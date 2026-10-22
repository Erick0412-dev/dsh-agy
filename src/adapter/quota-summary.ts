/**
 * `v1internal:retrieveUserQuotaSummary` — the grouped 5-hour / weekly quota
 * windows, as distinct from `fetchAvailableModels`' per-model `quotaInfo`.
 *
 * WHY THIS ENDPOINT EXISTS HERE AT ALL. `fetchAvailableModels` reports only
 * `remainingFraction` + `resetTime` per model, with NO window field: measured
 * across every id, the only keys under `quotaInfo` are those two. So a "5-hour
 * vs weekly" view is not derivable from it, and the summary endpoint is the only
 * source for both windows. Recorded in docs/ANTIGRAVITY-API.md §3, which
 * previously stated the opposite ("no retrieveUserQuota path").
 *
 * The shapes differ meaningfully and must not be merged:
 *   - `fetchAvailableModels` -> per MODEL (used for ranking/rotation)
 *   - `retrieveUserQuotaSummary` -> per GROUP (Gemini, Claude+GPT), 2 windows each
 * The group split is upstream's own, so it is carried through verbatim rather
 * than re-derived from model-id prefixes: `3p-*` covers Claude AND GPT, which no
 * prefix rule in `modelFamilyOf` would group together.
 *
 * Measured response (live account):
 *   { groups: [ { displayName, buckets: [
 *       { bucketId: "gemini-5h", window: "5h", remainingFraction, resetTime },
 *       { bucketId: "gemini-weekly", window: "weekly", ... } ] } ] }
 *
 * The identity used is the same bootstrap User-Agent as `fetchAvailableModels`
 * (that pair is what answers 200 here), so nothing new is impersonated.
 */

import { AGY_ENDPOINT_FALLBACKS, getAgyBootstrapUserAgent } from '../oauth/constants.ts'
import { proxiedFetch } from '../proxy.ts'
import { QUOTA_WINDOWS } from '../types.ts'
import type { QuotaGroup, QuotaWindow } from '../types.ts'

export type { QuotaGroup, QuotaWindow } from '../types.ts'

export const QUOTA_SUMMARY_PATH = '/v1internal:retrieveUserQuotaSummary'

/** The raw response, structurally. */
interface RawQuotaSummary {
  groups?: Array<{
    displayName?: unknown
    buckets?: Array<{
      bucketId?: unknown
      window?: unknown
      remainingFraction?: unknown
      resetTime?: unknown
    }>
  }>
}

/**
 * Sort rank for an upstream window token: shorter windows first.
 *
 * The order comes from `QUOTA_WINDOWS` (`types.ts`), the same table the scheduler
 * reads its window kinds from, so the parser and the scheduler cannot drift
 * apart — they used to keep separate tables, and the `daily` token only one of
 * them knew about silently destroyed a real measurement. Unknown tokens rank last
 * (and tie-break alphabetically) so a window added upstream later is still shown,
 * just after the ones we understand.
 */
function windowRank(window: string): number {
  return QUOTA_WINDOWS[window]?.rank ?? Number.MAX_SAFE_INTEGER
}

/** Clamp to 0..1; a non-number is "unknown" rather than zero. */
function fractionOf(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null
  return Math.max(0, Math.min(1, raw))
}

/** A non-empty string, else null. */
function stringOf(raw: unknown): string | null {
  return typeof raw === 'string' && raw !== '' ? raw : null
}

/**
 * Parse a summary payload into groups.
 *
 * Defensive like the rest of the wire parsing: a group with no usable window is
 * DROPPED rather than rendered as an empty card, because a group row with no
 * windows tells the user nothing and would push a real group off screen. Buckets
 * are ordered with the shorter window first so a group reads "immediate pressure,
 * then the weekly budget" consistently regardless of upstream order.
 */
export function parseQuotaSummary(raw: unknown): QuotaGroup[] {
  const data = raw as RawQuotaSummary | null
  if (typeof data !== 'object' || data === null) return []
  const groups: QuotaGroup[] = []
  for (const group of Array.isArray(data.groups) ? data.groups : []) {
    if (typeof group !== 'object' || group === null) continue
    const windows: QuotaWindow[] = []
    for (const bucket of Array.isArray(group.buckets) ? group.buckets : []) {
      if (typeof bucket !== 'object' || bucket === null) continue
      const bucketId = stringOf(bucket.bucketId)
      const window = stringOf(bucket.window)
      if (bucketId === null || window === null) continue
      windows.push({
        bucketId,
        window,
        remainingFraction: fractionOf(bucket.remainingFraction),
        resetTime: stringOf(bucket.resetTime),
      })
    }
    if (windows.length === 0) continue
    // Shortest window first, by an explicit table rather than by token length.
    // Length happens to order today's vocabulary correctly (`5h` < `weekly`), and
    // would even survive `daily`/`monthly`, but it ranks by a coincidence of
    // spelling instead of by the duration the token names — `daily` (5 chars)
    // would sort BEFORE `weekly` (6) for the wrong reason. An unknown token sorts
    // last, so a window upstream adds later appears after the known ones instead
    // of landing somewhere arbitrary.
    windows.sort((a, b) => windowRank(a.window) - windowRank(b.window) || a.window.localeCompare(b.window))
    groups.push({ name: stringOf(group.displayName) ?? '', windows })
  }
  return groups
}

/**
 * Check whether a quota group list contains a Gemini group.
 * A group counts as Gemini if its name mentions 'gemini' or 'google',
 * or any bucket id contains 'gemini'.
 */
export function hasGeminiQuotaGroup(groups: readonly QuotaGroup[]): boolean {
  return groups.some((g) => {
    const name = g.name.toLowerCase()
    if (name.includes('gemini') || name.includes('google')) return true
    return g.windows.some((w) => w.bucketId.toLowerCase().includes('gemini'))
  })
}

/**
 * Display sort order: Gemini first, then third-party (Claude/GPT), then anything else.
 * Preserves upstream's canonical display order where Gemini appears before 3P groups.
 */
function groupDisplayRank(name: string): number {
  const lower = name.toLowerCase()
  if (lower.includes('gemini') || lower.includes('google')) return 0
  if (lower.includes('claude') || lower.includes('gpt') || lower.includes('3p')) return 1
  return 2
}

/**
 * Merge newly discovered groups into an existing accumulator.
 * Existing groups are preserved, and missing groups (deduplicated by case-insensitive name)
 * are appended, followed by sorting in canonical display order (Gemini first).
 */
export function mergeQuotaGroups(accumulated: QuotaGroup[], incoming: QuotaGroup[]): QuotaGroup[] {
  const merged = [...accumulated]
  for (const group of incoming) {
    const key = group.name.trim().toLowerCase()
    const exists = merged.some((g) => g.name.trim().toLowerCase() === key)
    if (!exists) {
      merged.push(group)
    }
  }
  merged.sort((a, b) => groupDisplayRank(a.name) - groupDisplayRank(b.name) || a.name.localeCompare(b.name))
  return merged
}

/**
 * Fetch and parse the grouped windows for one account.
 *
 * Mirrors `fetchAvailableModels`: the endpoint fallback chain is walked here, and
 * the caller injects only the routed+time-bounded fetch, so the account's proxy
 * is honoured (omitting it would go direct and leak the account's real IP) and
 * one shared budget bounds both calls.
 *
 * RESILIENCE AGAINST ENDPOINT SKEW: Upstream endpoints may return partial group
 * sets. For instance, `daily-cloudcode-pa.googleapis.com` can omit `Gemini Models`
 * and return only `Claude and GPT models`, while production `cloudcode-pa.googleapis.com`
 * returns both. We accumulate groups across fallback endpoints: if the first
 * answering endpoint lacks the core Gemini group, subsequent endpoints are probed
 * to merge and recover missing groups. Probing stops as soon as Gemini quota is
 * present in the accumulated set.
 *
 * @param accessToken - a live access token for the account.
 * @param projectId - the account's Cloud Code project id, when known.
 * @param fetchImpl - routed, time-bounded fetch implementation.
 * @returns the parsed groups; empty when no endpoint answers (never throws, so a
 *   summary failure cannot discard the ranking data fetched alongside it).
 */
export async function fetchQuotaSummary(
  accessToken: string,
  projectId: string | undefined,
  fetchImpl: typeof fetch = proxiedFetch,
): Promise<QuotaGroup[]> {
  const body = JSON.stringify(projectId ? { project: projectId } : {})
  let accumulated: QuotaGroup[] = []

  for (const baseEndpoint of AGY_ENDPOINT_FALLBACKS) {
    try {
      const response = await fetchImpl(`${baseEndpoint}${QUOTA_SUMMARY_PATH}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'User-Agent': getAgyBootstrapUserAgent(),
        },
        body,
      })
      if (!response.ok) continue
      const groups = parseQuotaSummary(await response.json())
      if (groups.length === 0) continue

      accumulated = mergeQuotaGroups(accumulated, groups)

      // Stop fallback probing once the core Gemini group is captured.
      if (hasGeminiQuotaGroup(accumulated)) {
        return accumulated
      }
    } catch {
      // Try the next endpoint; the caller treats an empty result as "unknown".
    }
  }
  return accumulated
}
