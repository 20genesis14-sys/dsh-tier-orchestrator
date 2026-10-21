// Ordered tier registry — pure data + lookups.
//
// Tiers are ordered strongest → weakest. The registry always holds all three
// ('strong', 'main', 'cheap'); the two-tier layout routes with ['strong',
// 'cheap'] only, and the three-tier layout adds 'main' between them, where
// strong becomes the escalation tier.

import { migrateTierConfig } from './routing.js'

export const TIER_ORDER = ['strong', 'main', 'cheap']

/** Tier names that route requests under the given layout, strongest first. */
export function activeTierOrder(threeTiers) {
  return threeTiers ? TIER_ORDER : ['strong', 'cheap']
}

/**
 * Create a tier registry over the persisted/raw per-tier configuration.
 * @param raw - map of tier name → raw tier config (missing names get defaults).
 */
export function createTierRegistry(raw) {
  const tiers = new Map()
  for (const name of TIER_ORDER) {
    tiers.set(name, migrateTierConfig(name, raw && raw[name]))
  }
  return {
    /** Ordered tier names, strongest first. */
    names() { return [...tiers.keys()] },
    /** The strongest tier name. */
    first() { return TIER_ORDER[0] },
    /** The weakest tier name. */
    last() { return TIER_ORDER[TIER_ORDER.length - 1] },
    /** Read one tier's normalized config. */
    get(name) { return tiers.get(name) },
    /** Replace one tier's normalized config (already migrated). */
    set(name, cfg) { if (tiers.has(name)) tiers.set(name, cfg) },
    /** Snapshot every tier into a plain name → config map. */
    snapshot() {
      const out = {}
      for (const [k, v] of tiers) out[k] = v
      return out
    },
  }
}

/** Short `provider/model (effort)` label for one tier config. */
export function tierLabel(tier) {
  return tier.provider + '/' + tier.model + ' (' + tier.reasoningEffort + ')'
}

/** `p/m@e -> p2/m2@e2` rendering of one tier's fallback chain. */
export function chainText(tier) {
  const chain = tier && tier.fallback
  if (!Array.isArray(chain) || chain.length === 0) return '(none)'
  return chain.map(function (f) { return f.provider + '/' + f.model + '@' + f.reasoningEffort }).join(' -> ')
}
