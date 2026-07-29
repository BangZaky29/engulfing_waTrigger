// =====================================================
// services/versionResolver.ts
// Resolves the correct WhatsApp Web version dynamically.
// Uses multiple sources with fallback chain to avoid
// the 405 error caused by stale versions.
// =====================================================

type WAVersion = [number, number, number];

// Known-good fallback version (updated from wppconnect.io 28 Jul 2026)
const FALLBACK_VERSION: WAVersion = [2, 3000, 1044015310];

/**
 * Fetch the latest WhatsApp Web version from the WPPConnect API.
 * This is the most reliable source as it tracks versions in real-time.
 */
async function fetchFromWppConnect(): Promise<WAVersion | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const res = await fetch('https://web.whatsapp.com/check-update?version=1&platform=web', {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    });
    clearTimeout(timeout);

    if (!res.ok) {
      console.warn(`[VERSION] check-update returned ${res.status}`);
      return null;
    }

    const data = await res.json();
    // Response format: { currentVersion: "2.3000.xxxxx", ... }
    if (data?.currentVersion) {
      const parts = data.currentVersion.split('.').map(Number);
      if (parts.length === 3 && parts.every((n: number) => !isNaN(n))) {
        // HACK: WhatsApp check-update endpoint is currently returning 2.2413.51
        // which causes a 428 Connection Terminated error because it's too old.
        // We only accept versions 2.3000.x and above.
        if (parts[1] >= 3000) {
          console.log(`[VERSION] ✅ Got version from check-update: ${parts.join('.')}`);
          return parts as WAVersion;
        } else {
          console.warn(`[VERSION] ⚠️ check-update returned stale version: ${parts.join('.')}. Ignoring.`);
        }
      }
    }

    return null;
  } catch (e: any) {
    console.warn(`[VERSION] Failed to fetch from check-update: ${e?.message || e}`);
    return null;
  }
}

/**
 * Fetch version from the Baileys GitHub repo as secondary source.
 */
async function fetchFromBaileysGitHub(): Promise<WAVersion | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const res = await fetch(
      'https://raw.githubusercontent.com/WhiskeySockets/Baileys/master/src/Defaults/baileys-version.json',
      { signal: controller.signal }
    );
    clearTimeout(timeout);

    if (!res.ok) return null;

    const data = await res.json();
    if (data?.version && Array.isArray(data.version) && data.version.length === 3) {
      console.log(`[VERSION] ✅ Got version from Baileys GitHub: ${data.version.join('.')}`);
      return data.version as WAVersion;
    }

    return null;
  } catch (e: any) {
    console.warn(`[VERSION] Failed to fetch from Baileys GitHub: ${e?.message || e}`);
    return null;
  }
}

// Cached version to avoid repeated fetches during reconnects
let cachedVersion: WAVersion | null = null;
let lastFetchTime = 0;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Resolve the WhatsApp Web version with multi-source fallback.
 * 
 * Priority:
 * 1. Cached version (if fresh, < 30 min old)
 * 2. WhatsApp check-update endpoint
 * 3. Baileys GitHub repo
 * 4. Hardcoded fallback
 * 
 * @param forceRefresh - bypass cache (used after 405 errors)
 */
export async function resolveWaVersion(forceRefresh = false): Promise<WAVersion> {
  const now = Date.now();

  // Return cached version if still fresh
  if (!forceRefresh && cachedVersion && (now - lastFetchTime) < CACHE_TTL_MS) {
    console.log(`[VERSION] Using cached version: ${cachedVersion.join('.')}`);
    return cachedVersion;
  }

  console.log('[VERSION] Fetching latest WhatsApp Web version...');

  // Source 1: WhatsApp check-update
  let version = await fetchFromWppConnect();

  // Source 2: Baileys GitHub
  if (!version) {
    console.log('[VERSION] Trying Baileys GitHub fallback...');
    version = await fetchFromBaileysGitHub();
  }

  // Source 3: Hardcoded fallback
  if (!version) {
    console.warn(`[VERSION] ⚠️ All sources failed. Using hardcoded fallback: ${FALLBACK_VERSION.join('.')}`);
    version = FALLBACK_VERSION;
  }

  // Cache the result
  cachedVersion = version;
  lastFetchTime = now;

  return version;
}

/**
 * Invalidate cached version. Called when a 405 error is detected
 * so the next connect attempt fetches a fresh version.
 */
export function invalidateVersionCache(): void {
  console.log('[VERSION] Cache invalidated — will fetch fresh version on next connect.');
  cachedVersion = null;
  lastFetchTime = 0;
}
