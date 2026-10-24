/**
 * Device fingerprint generation for rate-limit mitigation (two layers):
 *
 * 1. Per-request randomized headers — platform/arch/SDK-client pools.
 * 2. Per-account persistent fingerprint — deviceId/sessionToken/UA snapshot
 *    with bounded history (≤5 versions, restorable), regenerated when an
 *    account's capacity looks exhausted.
 *
 * All tunable pools live in fingerprint-data.json so they can be updated
 * without a code release (the reference implementation stopped at an old
 * version string once archived — that staleness is the detectable signal).
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { AGY_HUB_CHANGELIST, AGY_IDE_TYPE, AGY_PLATFORM_ENUM, currentAgyVersion } from '../oauth/constants.ts'
import { migrateToAgyDir } from '../store/paths.ts'
import type { ClientMetadata, Fingerprint, FingerprintVersion } from '../types.ts'
import fingerprintData from './fingerprint-data.json'

export interface FingerprintData {
  versionPool: string[]
  platforms: string[]
  sdkClients: string[]
  ideTypes: string[]
}

export const DEFAULT_FINGERPRINT_DATA = fingerprintData as FingerprintData

export const MAX_FINGERPRINT_HISTORY = 5

/** The override file's NAME (inside the agy data dir), for messages and tests. */
export const FINGERPRINT_OVERRIDE_FILE = 'agy-fingerprint-data.json'

/**
 * Effective fingerprint data: a user override at `$DSH_HOME/agy/agy-fingerprint-data.json`
 * wins when present and parseable (hot-updatable without a code release — the
 * bundled copy is compiled in), otherwise the bundled defaults. The legacy
 * `$DSH_HOME/agy-fingerprint-data.json` location is migrated once by rename.
 */
let cachedData: FingerprintData | null = null
export function getFingerprintData(): FingerprintData {
  if (cachedData) return cachedData
  try {
    // NOT `resolveDshHome()`-based: see the note on `getFingerprintData` above.
    const dshHome = process.env.DSH_HOME ? process.env.DSH_HOME : join(process.env.HOME ?? '.', '.dsh')
    const overrideFile = migrateToAgyDir('agy-fingerprint-data.json', dshHome).file
    if (existsSync(overrideFile)) {
      const parsed = JSON.parse(readFileSync(overrideFile, 'utf8')) as FingerprintData
      if (parsed && Array.isArray(parsed.versionPool) && parsed.versionPool.length > 0) {
        cachedData = parsed
        return cachedData
      }
    }
  } catch {
    // unreadable override — fall through to bundled defaults
  }
  cachedData = DEFAULT_FINGERPRINT_DATA
  return cachedData
}

function randomFrom<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!
}

/**
 * Replace the pool data for one test, and restore the real source with `undefined`.
 *
 * `getFingerprintData()` caches its result in-process, so a test cannot exercise a
 * user override file (`$DSH_HOME/agy/agy-fingerprint-data.json`) without a way to drop
 * that cache.
 */
export function _setFingerprintDataForTest(data: FingerprintData | undefined): void {
  cachedData = data ?? null
}

/** Generate a randomized device fingerprint representing one apparent device. */
export function generateFingerprint(
  data: FingerprintData = getFingerprintData(),
  version = randomFrom(data.versionPool),
): Fingerprint {
  const platform = randomFrom(data.platforms)
  const [osType = 'darwin', arch = 'arm64'] = platform.split('/')
  return {
    deviceId: randomUUID(),
    sessionToken: randomBytes(16).toString('hex'),
    userAgent: `antigravity/hub/${version} (aidev_client; os_type=${osType}; arch=${arch}; cl=${AGY_HUB_CHANGELIST})`,
    apiClient: randomFrom(data.sdkClients),
    // The metadata message, not a header (see `ClientMetadata` in types.ts). The
    // version is stamped here as well as in the UA because the official message
    // carries `ide_version` — a UA the SDK overwrites would otherwise be the only
    // place this client states its version.
    clientMetadata: {
      ideType: randomFrom(data.ideTypes),
      ideVersion: version,
      platform: AGY_PLATFORM_ENUM,
    },
    createdAt: Date.now(),
  }
}

/**
 * Per-request randomized headers (platform + SDK client pools).
 *
 * No longer used on any production path: the account's identity is created once
 * on first use and reused ({@link generateFingerprint}), so nothing re-rolls a
 * platform per request. Kept as the pool-level primitive that
 * {@link getStableHeaders} and the fingerprint tests are built on.
 */
/** The impersonation surface a fingerprint produces: two headers and the body message. */
export interface ImpersonationHeaders {
  'User-Agent': string
  'X-Goog-Api-Client': string
  clientMetadata: ClientMetadata
}

export function getRandomizedHeaders(
  data: FingerprintData = getFingerprintData(),
  version = randomFrom(data.versionPool),
): ImpersonationHeaders {
  const platform = randomFrom(data.platforms)
  const [osType = 'darwin', arch = 'arm64'] = platform.split('/')
  return {
    'User-Agent': `antigravity/hub/${version} (aidev_client; os_type=${osType}; arch=${arch}; cl=${AGY_HUB_CHANGELIST})`,
    'X-Goog-Api-Client': randomFrom(data.sdkClients),
    clientMetadata: {
      ideType: randomFrom(data.ideTypes),
      ideVersion: version,
      platform: AGY_PLATFORM_ENUM,
    },
  }
}

/**
 * Deterministic fallback headers for the `stable` fingerprint mode: the first
 * entry of each pool, every call — one fixed client identity instead of
 * per-request randomization (OMP-style fixed-client posture).
 */
export function getStableHeaders(
  data: FingerprintData = getFingerprintData(),
  version = data.versionPool[0] ?? '',
): ImpersonationHeaders {
  const platform = data.platforms[0] ?? 'darwin/arm64'
  const resolved = version || currentAgyVersion()
  const [osType = 'darwin', arch = 'arm64'] = platform.split('/')
  return {
    'User-Agent': `antigravity/hub/${resolved} (aidev_client; os_type=${osType}; arch=${arch}; cl=${AGY_HUB_CHANGELIST})`,
    'X-Goog-Api-Client': data.sdkClients[0] ?? '',
    clientMetadata: {
      ideType: data.ideTypes[0] ?? AGY_IDE_TYPE,
      ideVersion: resolved,
      platform: AGY_PLATFORM_ENUM,
    },
  }
}

/**
 * Rewrite the version inside a fingerprint UA; reports whether it changed.
 *
 * Carries the metadata message's `ideVersion` along: they state the same fact,
 * and letting them drift is how one account comes to look like two clients.
 */
export function updateFingerprintVersion(fingerprint: Fingerprint, version: string): boolean {
  const pattern = /^(antigravity\/(?:hub\/)?)([\d.]+)/
  const match = fingerprint.userAgent.match(pattern)
  const uaChanged = match === null || match[1] !== 'antigravity/hub/' || match[2] !== version
  if (uaChanged) {
    fingerprint.userAgent = `antigravity/hub/${version} (aidev_client; os_type=darwin; arch=arm64; cl=${AGY_HUB_CHANGELIST})`
  }
  const metaChanged = fingerprint.clientMetadata.ideVersion !== version
  if (metaChanged) fingerprint.clientMetadata.ideVersion = version
  return uaChanged || metaChanged
}

/** Append a fingerprint to the account history (bounded), then use it as current. */
export function recordFingerprintVersion(
  history: FingerprintVersion[] | undefined,
  fingerprint: Fingerprint,
  reason: FingerprintVersion['reason'],
): FingerprintVersion[] {
  const next = [...(history ?? []), { fingerprint, timestamp: Date.now(), reason }]
  return next.slice(-MAX_FINGERPRINT_HISTORY)
}
