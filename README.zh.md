# dsh-tier-router — 分层模型路由 for DeepSeek Harness

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![dsh-plugin](https://img.shields.io/badge/dsh-plugin-ready-4B32C3)](https://github.com/topics/dsh-plugin)

按任务难度分层路由模型：**强档（默认 deepseek-v4-pro）负责规划 / 架构 / 评审**，
**弱档（默认 deepseek-v4-flash）负责日常编码实现**，并支持每档回退链与按任务强度
自动选择思考强度。灵感来自 Claude Code 的
在 DeepSeek Harness 里用官方机制实现，并扩展了难度升级门、失败自动升级与 subagent 分层。

[English](README.md) · 中文

## 工作原理

```mermaid
flowchart LR
    subgraph main["所有代理（agent/request 瀑布 seam）"]
      U["用户消息"] --> IN["agent/inbox/inserted"]
      STEP0["每个模型请求"] --> AR["agent/request 瀑布"]
      IN --> AR
      PM["plan/mode 翻转"] --> AR
      AR -->|"按档位返回 provider/model/effort"| STEP["该步骤跑对应档模型"]
    end
    subgraph child["子代理（startActivation + 同一瀑布）"]
      W["tier_worker 派发"] -->|"agentOptions 注入"| C["子代理"]
      C --> AR
    end
    G["tools/pre-execute 守卫"] -.->|"弱档 + 高危模式"| DENY["deny + 升级提示"]
    E["agent/error 连续失败"] -.->|"阈值内"| ESC["临时强档（TTL）"]
    FE["agent/request-error"] -.->|"模型不可用"| FB["回退链下一项 + 重试"]
```

DSH 0.2 的 `agent/request` 瀑布对**每个**请求生效，切档不再有一步延迟，
`request/header` 日志由 loop 自己写入。旧版本运行时（无瀑布 seam）会自动
降级为写 header 的兼容策略。

```mermaid
sequenceDiagram
    participant U as 用户
    participant S as 会话（主代理）
    participant A as 强档 v4-pro
    participant C as 弱档 v4-flash
    U->>S: /tier plan（进入计划模式）
    S->>S: 写 header → strong
    S->>A: 规划 / 架构 / 设计方案
    U->>S: 批准计划，退出计划模式
    S->>S: 写 header → cheap
    S->>C: 日常编码实现
    S->>A: tier_advisor（困难决策）/ tier_review（收尾评审）
    Note over S,C: 高危操作（rm -rf / 凭据文件）被守卫拦截，要求先切强档
```

## 功能

- **自动分层路由（auto 模式，opusplan 式）**：进入计划模式时步骤跑强档，执行步骤跑弱档。
  在 agent loop 构建首个或恢复后的请求前，路由器会同步 agent 的模型 options 与持久化
  `request/header`；后续切换会保留 `maxTokens` 等无关请求配置。
- **按会话隔离（per-session）**：`/tier strong|cheap|auto|delegated|off` 只影响当前会话，
  **进程内其他会话保持自己的档位**（全局默认 `auto`）。`delegated` 模式下主会话保持模型
  选择器的选项，只有子代理使用分层路由；`/tier auto` 仍是显式的本会话覆盖。不想被管理的
  会话发一次 `/tier off` 即可退出。
- **按需咨询（advisor 式）**：`/advisor <问题>` 命令 + `tier_advisor` 工具，把一个问题
  加已有证据交给强档模型，返回建议 / 证据 / 风险 / 验收条件；实现仍由当前档执行。
- **评审阶段**：`tier_review` 工具 + `/tier review <焦点>`，强档模型对变更与验证结果
  给出 `APPROVE / NEEDS-CHANGES / BLOCKED` 及分级问题清单。
- **失败自动升级**：同一会话在窗口内连续出错（默认 60s 内 2 次）自动临时切到强档
  （默认 180s），TTL 过期自动回落；`off` 会话不参与。
- **每档回退链**：每个 tier 都有有序回退链。主模型不可用（未知模型、配额、限流、
  凭据缺失/失效、server/transport 错误或任意 >= 500）时，路由器在受支持的
  request-error 边界切换到下一项并重试同一步。移除全部条目即可关闭回退。回退状态按
  agent 与 tier 分开记录，TTL（默认 5 分钟，`state.fallbackTtlMs`）后回到主模型，
  且计划模式切换不会把弱档回退链误解释为强档回退链。
- **两个独立开关**：`/tier layout <two|three>`（三档加入主档：计划模式走主档、执行走低成本档，
  强档成为升级档；默认双档）和 `/tier roles <on|off>`（顾问与审查通过 `/tier set advisor|reviewer`
  使用各自模型；关闭时走强档路由）。角色没有自己的降级链，回退到强档降级链。审查时若与执行者同
  家族，`/tier status` 会给出警告。
- **可配置双档（持久化）**：`/tier set <strong|main|cheap> <provider> <model> [effort]` 或
  `tier_configure` 工具可修改任意已注册 provider / model、让强档与主档跟随会话模型选择，并配置
  有序回退链。配置持久化在 host 级 `tier-routing` profile 条目上，重启不丢；
  传 `sessionOnly: true` 可只改内存。
- **WebUI 设置页**：host `tier-routing` 条目的全部 volatile 字段（模式、provider、模型、
  思考强度、跟随会话、回退链、子代理策略）由 DSH 自动生成设置页并持久化，
  不再需要手写 `client/client.js`（已移除）。
- **seam 自诊断**：启动时探测所有用到的 DSH 服务与事件；`/tier status` 报告当前
  路由策略（`waterfall`/`header`）与缺失能力。某个 seam 缺失只会让对应功能降级，
  不会拖垮整个插件。
- **高危升级门（确定性守卫）**：当执行档为弱档时，`tools/pre-execute` 拦截高危工具调用，
  要求先切到强档再执行，不依赖模型自觉。守卫规则（纯逻辑 `lib/core/guard.js`，单元测试覆盖）：
  - `rm -rf` 全拼写：合并参数（`-rf`）、拆分参数（`-r -f`）、大小写（`-R`）、长参数
    （`--recursive --force`）、前缀命令（`sudo rm -rf`、`busybox rm`）；
  - 破坏性命令：`mkfs`、`dd if=`、`sudo`、`shutdown/reboot/halt`、`git push --force/-f`、
    `git clean -f*`、`find ... -delete` / `find ... -exec rm`、`python -c` 里的
    `shutil.rmtree` / `os.remove`、`curl|sh`、`wget|sh`、`chmod` 到 `.ssh`、`chown`；
  - 敏感路径：`.env`（`.env.example/.template` 白名单例外）、`credentials`/`secrets`
    常见扩展名、`.ssh/`、`id_rsa` 等私钥（大小写不敏感）、`.pem`、`.key`；
  - 散文不误伤：`echo rm -rf`、`grep sudo` 之类不触发（锚定命令位置）。
- **subagent 分层**：`tier_worker` 按档派发子代理（`subagents.startActivation` +
  `agentOptions` 注入模型），支持 `outputSchema`（结构化结果）、`agentPreset`
  （按其他预设组合 worker——替代上游已删除的 `persona`/`toolFilter`）、
  `maxDepth`（深度上限）、`background`（jobs 后台执行，owner 为 SessionId）；`/tier subagent
  <inherit|cheap|strong>` 也会在普通 `subagent` 与 `subagent_fork` 的首个请求前应用
  对应路由。自动升级始终受 TTL 限制，不会永久覆盖 worker 显式选择的档位。
- **难度升级规则注入**：向系统提示词注入升级门（歧义未消、架构 / 安全 / 数据完整性、
  两次失败、收尾高风险等条件），模型在决策点调用 `tier_advisor` / `tier_review`。

## 安装

> **作用域说明**：bundle 包含两行——**host 层** `tier-routing` 条目持有持久化配置
> （在插件管理页编辑——随包的 `client/` 浏览器模块会在该插件卡片下注册
> “Tier routing” 设置表单，读写同一个 host 设置命名空间），**agent 层**
> `tier-routing-agent` 行位于随包声明的
> `tiered` agent preset 内。工具、命令与路由监听器只在使用该 preset 的会话中挂载。
> preset 通过 `@deepseek-ai/dsh-agent-preset` 声明，无需也不支持向
> `~/.dsh/.agent-presets` 拷贝文件（DSH 0.2 不再扫描该目录）。

```sh
# 1. 安装到 profile。
dsh plugin --profile web add dsh-tier-router

# 本地开发同样使用该安装路径：
dsh plugin --profile web add .

# 2. 重启 DSH，在新会话的预设选择器中选择 “tiered”（或设为默认）。
#    配置入口：插件管理页 → dsh-tier-router 卡片 → 展开出 “Tier routing”
#    设置表单（命名空间由 host 提供，需先用 tiered 预设跑过一个会话）。
```

卸载：`dsh plugin --profile web remove dsh-tier-router`，下次启动后 host 条目与
`tiered` preset 一并消失。

### 安装后验收清单

1. **重启 DSH**：先杀掉 LISTEN 在 web 端口的进程（`lsof -tiTCP:<端口> -sTCP:LISTEN | xargs kill -9`），再启动。
2. **新开一个会话**——已存在的会话保留创建时的 preset（设计如此）。
3. 运行 `/tier status`，必须看到：
   - `config persisted: yes (host entry "tier-routing", writable)`
   - `routing seam: waterfall` 与 `seams: all ok`
   - 两个 tier 各自的 provider/model/effort
   - `diag:` 行实时计数器
4. 该会话里必须能调用 `tier_status` / `tier_route` / `tier_configure` /
   `tier_advisor` / `tier_review` / `tier_worker` 六个工具。
5. 廉价档执行期间，高危命令（如 `rm -rf`、`sudo …`）必须被守卫拒绝并给出升级提示。
6. `/tier set strong <provider> <model> [effort]` 必须回复 `Saved to
   tier-router settings.` 且重启后仍然生效。

如果 `/tier status` 不可用：说明该会话的 preset 里缺 `tier-routing` 行（见"安装"），
或该会话创建于切换默认 preset 之前。

## 使用

### 斜杠命令（在输入框直接输入，只作用于当前会话）

```
/advisor <决策问题>                          # 强档模型一次咨询
/tier status                                # 查看路由状态、升级状态与诊断计数器
/tier strong | cheap                        # 本会话强制走某档（可选持久化为会话默认）
/tier auto                                  # 本会话恢复自动（计划模式→强档，执行→弱档）
/tier delegated                             # 主会话保持模型选择器，仅对子代理分层
/tier off                                   # 本会话关闭路由并恢复默认模型（不影响其他会话）
/tier plan                                  # auto + 进入计划模式，并立即应用强档 header
/tier models                                # 列出已注册 provider 与其模型
/tier main                                  # 本会话走主档（仅三档布局）
/tier layout <two|three>                    # 双档（默认）或三档（加入主档，强档作为升级档）
/tier roles <on|off>                        # 顾问与审查使用各自模型，或走强档路由
/tier gate explore <n>                      # exit_plan_mode 前所需的读/检索调用次数（0 关闭）
/tier gate advisor <on|off>                 # 计划提交前由顾问先评审一次
/tier set <strong|main|cheap|advisor|reviewer> <provider> <model> [effort]
/tier set <strong|main> follow-session      # 跟随会话模型选择
/tier subagent [spawn|fork] <inherit|cheap|strong|main|caller|capped> # 子代理路由；caller 仅用于 fork，capped 不超过主档
/tier review <评审焦点>                       # 强档模型评审
```

示例输出（`/tier status`）：

```
Tiered model routing
  mode: global=auto, this session=auto (per-session via /tier strong|cheap|auto|delegated|off; escalate: 2 errors / 60s window -> 180s strong)
  strong: deepseek-official/deepseek-v4-pro (max)
  cheap:  deepseek-official/deepseek-v4-flash (low)
  subagents: inherit
  diag: requestSteps=42 guardChecks=31 guardDenies=3 headerWrites=4 errorsSeen=0 escalations=0
  session default: deepseek-official/deepseek-v4-pro (max)
  providers: deepseek-official, opencode-go, minimax
```

### 模型工具（由模型在需要时调用）

| 工具 | 用途 |
| --- | --- |
| `tier_advisor` | 强档咨询：一个问题 + 证据 → 建议 / 风险 / 验收条件 |
| `tier_review` | 强档评审：变更集 + 验证结果 → 判定与分级问题 |
| `tier_route` | 设置**本会话**档位（strong/cheap/auto/delegated/off，可选持久化） |
| `tier_configure` | 重配任意档位的 provider/model/effort 与 subagent 策略 |
| `tier_worker` | 按档派发子代理执行有界任务包；支持 outputSchema / agentPreset / maxDepth / background |
| `tier_status` | 只读诊断：全局与本会话档位、升级状态、监听器计数器、生效档位 |

## 配置

运行时配置（无需重启）：

```sh
/tier set strong deepseek-official deepseek-v4-pro max
/tier set cheap deepseek-official deepseek-v4-flash low
```

`/tier set` 与 `tier_configure` 会把双档配置持久化到 host `tier-routing` profile 条目
（重启不丢；`sessionOnly: true` 可只改内存）。`settings` 服务不可达时降级为纯内存配置，
`/tier status` 会如实提示。`tier_route strong|cheap|delegated` 只影响当前会话
且默认不持久化，传 `persist: true` 才写入会话默认模型（`agent-default-model`）。
失败自动升级参数（阈值 / 窗口 / 时长）当前为内建常量，后续版本可配置化。

## 测试

```sh
npm test        # node:test — core 纯逻辑 + mock 上下文冒烟（agent/request 瀑布、
                # settings 持久化、startActivation、回退链、升级与守卫路径）
npm run check   # 语法检查 lib/index.js、lib/core/*、lib/dsh/*
```

架构说明：`lib/core/` 是无 DSH 依赖、无 I/O 的纯决策层（可单测）；`lib/dsh/` 是唯一的
harness 适配层（服务探测、路由 seam 策略、subagent/jobs 适配、settings 桥）。未来 DSH
的 breaking change 理论上只需改 `lib/dsh/` 内单个文件——这是刻意设计的兼容边界。

会话内严格多轮实测（动态插件形态）记录：

| 项目 | 结果 |
| --- | --- |
| 主会话每步路由（持久日志证据） | ✅ `request/header` 事件显示从 pro 切到 flash |
| 守卫矩阵（auto/strong/off） | ✅ auto 拒 / strong 放行 / off 放行并恢复默认档 / 恢复 auto 拒 |
| 守卫加固（拆分参数、前缀 rm、散文、.env 白名单、大小写） | ✅ 7/7 实测通过 |
| 工具正向 | ✅ advisor/review 真调强档；route 四种模式；configure 改档；worker 在 spawn 与 fork 两个 provider 上完成 |
| worker 新参数 | ✅ outputSchema 结构化结果、agentPreset 透传、maxDepth 拒绝超限、jobs 后台（toolFilter/persona 为 0.2 之前 API 下的实测，上游已删除） |
| 工具反向用例 | ✅ 非法 provider 拒绝、非法 subagent provider 报错 |
| subagent 分层 | ✅ 弱档跑 flash、强档跑 pro（子代理日志与返回值证实） |
| 失败升级事件路径 | ✅ `agent/error` 真实触发、计数器自增、off 模式正确跳过 |
| 生命周期 | ✅ stop 后守卫与工具消失；重新 run 全部恢复且守卫生效 |
| 持久化 | ✅ `agent-default-model` 写入成功 |
| 跨回合监听器存活 | ✅ 诊断计数器跨回合持续自增 |

## FAQ

**Q: 为什么我另一个会话的模型被自动切换了？**
早期版本是进程级全局模式。v0.3.0 起 `/tier` 命令只作用于**当前会话**，
其他会话默认 `auto` 且互不影响；不想被管理的会话输入 `/tier off` 即可退出。

**Q: 切换档位后没有立刻生效？**
DSH 0.2 的 `agent/request` 瀑布让切档作用于下一个模型调用——没有一步延迟。
若 `/tier status` 显示 `routing seam: header`（旧运行时），则从下一步生效。

**Q: 想用订阅渠道的模型（如 OpenCode Go / MiniMax）？**
先 `/tier models` 确认 provider 已注册、模型已配置，再
`/tier set cheap opencode-go deepseek-v4-flash`。pi-ai 类 provider 必须在
settings.yaml 中声明 `baseURL`/`api`/`models`，否则任何模型 id 都会被拒绝。

**Q: 高危操作被拦了怎么办？**
守卫的提示会告诉你：先 `tier_route` 切到 `strong`（或 `/tier strong`）再重试——
拦截本身就是为了避免弱档模型直接执行破坏性操作。

**Q: 装完 bundle 后 `/tier` 不出现？**
会话必须使用 `tiered` preset（见"安装"）：路由属于 agent 层，只在该 preset 内挂载；
host 层 `tier-routing` 行只承载设置页。切换 preset 后新开会话，用 `/tier status` 验证。

## 已知限制

- 旧运行时的 header 降级 seam 下切档从下一步生效；0.2 瀑布 seam 下当请求生效。
- `tier_worker` 的 `agentPreset` 需要子代理 provider 声明 preset 能力（`spawn` 支持）；
  `toolFilter`/`persona` 已被上游删除，无法可靠模拟。
- 子代理全局档位策略（`/tier subagent`）是进程级的；worker 的单次派发档位始终优先。
- `settings` 服务缺失时配置仅内存有效。
- 失败自动升级的完整"失败→自愈"现场序列在会话内已验证事件路径与单元逻辑，端到端
  现场触发建议按 FAQ 操作验证。

## 路线图（尚未实现）

- **N 个命名档**：`lib/core/tiers.js` 已是有序注册表，未来配置加 `extraTiers` 即可。
- **升级前先询问**：`lib/core/policy.js` 预留 `ask` 动作与 `awaiting-confirm` 阶段，
  未来可在交给强档前弹确认。
- **新咨询类型**：`lib/core/consult.js` 是注册表——advisor/review 是条目，未来加
  delegate/diff-review 无需新管线。
- **决策模型适配器（Jev / Clef / OpenRouter Decisions）**：计划中的可选
  `lib/dsh/decisions.js`，向 OpenRouter Decisions API（`/api/alpha/decisions`）
  或任意 Jev 兼容端点（如自托管 `laya-server`）POST `{state, questions}`
  （noul/choice/score）；模型 id 是配置字段，Jev、Perplexity Decider、Clef、Drex
  等不改代码即可互换。目标用途：`ask` 策略动作、guard 二级分类、`tier_worker`/
  consult 的选档——不用于每请求热路径。无 key/endpoint 时静默回落到确定性策略。

## 许可

MIT