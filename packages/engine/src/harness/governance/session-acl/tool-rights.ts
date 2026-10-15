/**
 * ToolRights algebra (SEC-2) — narrow-only intersection across policy layers.
 *
 * A tool is permitted when every layer allows it. Deny always wins.
 * Capability denies use the same tags as `ToolDefinition.capabilities` (D5-a).
 *
 * `allow` semantics:
 * - `undefined` = unrestricted names (identity for intersection)
 * - `[]` (empty array) = deny-all names (result of disjoint allow intersection)
 * - non-empty = allowlist; `'*'` matches any name
 *
 * User config ergonomics: `normalizeToolRights` maps input `allow: []` to
 * `undefined` (same as ToolPolicy empty-allow = allow-all). Intersection
 * results must NOT re-collapse `[]` away — that would fail open.
 */

import type { ToolRights } from './types.js';
import { resolveToolCapabilities } from '../../extension/execution-environment/tool-capabilities.js';

/** Normalized ToolRights. `allow: []` means deny-all names, not unrestricted. */
export interface NormalizedToolRights {
  allow: string[] | undefined;
  deny: string[];
  denyCapabilities: string[];
}

/** Unrestricted surface (identity for intersection). */
export const EMPTY_TOOL_RIGHTS: NormalizedToolRights = {
  allow: undefined,
  deny: [],
  denyCapabilities: [],
};

function dedupe(list?: string[]): string[] {
  if (!list || list.length === 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const t = typeof raw === 'string' ? raw.trim() : '';
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/**
 * Normalize a user/config ToolRights bag.
 * Empty input `allow` is treated as unrestricted (ToolPolicy ergonomics).
 * Do NOT use this on intersection results (empty there means deny-all).
 *
 * @param input - raw rights (possibly undefined)
 * @returns normalized rights
 */
export function normalizeToolRights(input?: ToolRights): NormalizedToolRights {
  const allow = dedupe(input?.allow);
  return {
    allow: allow.length > 0 ? allow : undefined,
    deny: dedupe(input?.deny),
    denyCapabilities: dedupe(input?.denyCapabilities),
  };
}

/**
 * Coerce any layer to arrays without collapsing empty allow.
 * `undefined` allow stays unrestricted; `[]` stays deny-all.
 */
function toLayer(input?: ToolRights): NormalizedToolRights {
  if (!input) return EMPTY_TOOL_RIGHTS;
  return {
    allow: input.allow === undefined ? undefined : dedupe(input.allow),
    deny: dedupe(input.deny),
    denyCapabilities: dedupe(input.denyCapabilities),
  };
}

/**
 * Intersect two allowlists (`'*'` matches any name).
 * Returns `[]` when the intersection is empty (deny-all) — never `undefined`.
 */
function intersectAllow(
  a: string[] | undefined,
  b: string[] | undefined,
): string[] | undefined {
  if (a === undefined) return b === undefined ? undefined : [...b];
  if (b === undefined) return [...a];
  const aHasStar = a.includes('*');
  const bHasStar = b.includes('*');
  if (aHasStar && bHasStar) return ['*'];
  if (aHasStar) return [...b];
  if (bHasStar) return [...a];
  const bSet = new Set(b);
  return a.filter((n) => bSet.has(n));
}

/**
 * Intersect two tool-rights layers (stricter wins).
 *
 * - deny / denyCapabilities: union
 * - allow: both defined → set intersection (`[]` = deny-all); one undefined
 *   → the defined one; both undefined → unrestricted
 *
 * @param a - left layer
 * @param b - right layer
 * @returns intersection; empty allow stays `[]` (deny-all)
 */
export function intersectToolRights(
  a: ToolRights | undefined,
  b: ToolRights | undefined,
): NormalizedToolRights {
  const na = toLayer(a);
  const nb = toLayer(b);
  return {
    allow: intersectAllow(na.allow, nb.allow),
    deny: [...new Set([...na.deny, ...nb.deny])],
    denyCapabilities: [...new Set([...na.denyCapabilities, ...nb.denyCapabilities])],
  };
}

function permitsName(
  rights: NormalizedToolRights,
  name: string,
  caps: readonly string[] | null,
): boolean {
  // deny '*' = deny every tool name (same as allow '*')
  if (rights.deny.includes('*') || rights.deny.includes(name)) return false;
  if (caps && rights.denyCapabilities.length > 0) {
    for (const cap of caps) {
      if (rights.denyCapabilities.includes(cap)) return false;
    }
  }
  if (rights.allow !== undefined) {
    if (!rights.allow.includes(name) && !rights.allow.includes('*')) return false;
  }
  return true;
}

/**
 * Whether `value` is strictly more powerful than `ceiling` (illegal grant).
 *
 * Compares permitted surfaces: value exceeds when some tool name would be
 * permitted by value but not by ceiling. A narrow allowlist satisfies a
 * deny-based ceiling without restating those denies.
 *
 * @param value - proposed rights
 * @param ceiling - max rights
 * @returns true when value exceeds ceiling
 */
export function toolRightsExceeds(
  value: ToolRights | undefined,
  ceiling: ToolRights | undefined,
): boolean {
  const v = toLayer(value);
  const c = toLayer(ceiling);

  // Ceiling deny-all names: value may permit nothing.
  if (c.deny.includes('*')) {
    if (v.deny.includes('*')) {
      // both deny-all on names — fall through to capability axis
    } else if (v.allow === undefined || v.allow.length > 0) {
      // value still permits some name (unrestricted or non-empty allowlist)
      return true;
    }
  }

  // Allow axis: if ceiling restricts names, value's allowlist must be ⊆ ceiling.
  // Ceiling `'*'` matches every name (so a concrete allowlist never exceeds it).
  if (c.allow !== undefined) {
    if (v.allow === undefined) return true;
    const cSet = new Set(c.allow);
    const ceilingAllowsAll = cSet.has('*');
    for (const name of v.allow) {
      if (name === '*') {
        // value wildcard only legal when ceiling is also wildcard
        if (!ceilingAllowsAll) return true;
        continue;
      }
      if (!ceilingAllowsAll && !cSet.has(name)) return true;
    }
  }

  // Name denies: value must not permit a tool ceiling denies.
  for (const name of c.deny) {
    if (name === '*') continue; // handled above
    if (permitsName(v, name, resolveToolCapabilities(name))) return true;
  }

  // Capability denies: value must not permit tools carrying that capability.
  for (const cap of c.denyCapabilities) {
    if (v.denyCapabilities.includes(cap)) continue;
    if (v.allow === undefined) return true;
    for (const name of v.allow) {
      const caps = resolveToolCapabilities(name);
      if (caps === null) return true;
      if ((caps as readonly string[]).includes(cap)) return true;
    }
  }
  return false;
}

/**
 * Evaluate one tool against a single ToolRights layer.
 *
 * Fail-closed when `denyCapabilities` is set and the tool's capability tags
 * are unknown (aligned with reduced-surface unknown-reject).
 *
 * @param toolName - registered tool name
 * @param capabilities - resolved capability tags (explicit preferred)
 * @param rights - layer to test
 * @returns false when this layer strips the tool
 */
export function isToolAllowedByRights(
  toolName: string,
  capabilities: readonly string[] | null | undefined,
  rights: ToolRights | undefined,
): boolean {
  if (!rights) return true;
  const r = toLayer(rights);
  const name = toolName.trim();
  // deny '*' = deny every tool (mirror allow '*')
  if (r.deny.includes('*') || r.deny.includes(name)) return false;
  const caps = capabilities !== undefined ? capabilities : resolveToolCapabilities(name);
  if (r.denyCapabilities.length > 0) {
    if (caps === null) return false;
    for (const cap of caps) {
      if (r.denyCapabilities.includes(cap)) return false;
    }
  }
  if (r.allow !== undefined) {
    if (!r.allow.includes(name) && !r.allow.includes('*')) return false;
  }
  return true;
}

/**
 * Merge ToolPolicy (allow/deny names) and ToolRights into one narrow-only check.
 *
 * @param toolName - registered tool name
 * @param capabilities - resolved capability tags
 * @param layers - every active layer (agent policy, session rights, …)
 * @returns true only when all layers permit
 */
export function isToolPermitted(
  toolName: string,
  capabilities: readonly string[] | null | undefined,
  layers: Array<ToolRights | { allow?: string[]; deny?: string[] } | undefined>,
): boolean {
  for (const layer of layers) {
    if (!layer) continue;
    if (!isToolAllowedByRights(toolName, capabilities, layer as ToolRights)) {
      return false;
    }
  }
  return true;
}
