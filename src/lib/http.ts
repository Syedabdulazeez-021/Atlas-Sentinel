/**
 * http.ts — one tiny gateway for ALL external API calls.
 *
 * Why it exists:
 *  - every fetch gets a timeout (a hung API must never hang a tool)
 *  - responses are cached in-memory for a short TTL (Overpass rate-limits;
 *    judges re-running the demo shouldn't re-hit every API)
 *  - ATLAS_MODE=mock serves realistic canned payloads from mocks.ts, so the
 *    whole server works offline — dev without internet, and a guaranteed
 *    fallback if an API is down at demo time.
 */

import { mockFor } from './mocks.js';

const MODE = (process.env.ATLAS_MODE || 'live').toLowerCase();
const cache = new Map<string, { at: number; data: unknown }>();

export function isMock(): boolean {
  return MODE === 'mock';
}

export async function fetchJson(
  url: string,
  opts: { ttlMs?: number; timeoutMs?: number; method?: string; body?: string } = {}
): Promise<unknown> {
  const { ttlMs = 60_000, timeoutMs = 12_000, method = 'GET', body } = opts;

  if (isMock()) return mockFor(url);

  const key = method + ' ' + url + (body ?? '');
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.data;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      body,
      signal: ctrl.signal,
      headers: body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : undefined,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
    const data = await res.json();
    cache.set(key, { at: Date.now(), data });
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/** Standard error payload — tools return this instead of throwing. */
export function errorPayload(context: string, e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  return {
    error: `${context}: ${msg}`,
    hint: 'External data source may be slow or unreachable. Retry in a moment, or set ATLAS_MODE=mock for offline demo data.',
  };
}
