/**
 * guardrails.ts — server-side safety the model cannot talk around.
 * Sanitization of untrusted external text, alert budget, rate limiting.
 */
import { store } from './store.js';

const INJECTION = /(ignore (all )?previous|disregard|system:|you are now|new instructions)/gi;

/** Neutralize instruction-like patterns in third-party text (news, OSM names). */
export function sanitizeUntrusted(text: unknown): string {
  let t = String(text ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  t = t.replace(INJECTION, '[filtered]');
  return t.slice(0, 200);
}

// ---- rate limit: max 5 telegram sends per rolling minute -------------------
const sendTimes: number[] = [];
export function rateLimitOk(): boolean {
  const now = Date.now();
  while (sendTimes.length && now - sendTimes[0] > 60_000) sendTimes.shift();
  if (sendTimes.length >= 5) return false;
  sendTimes.push(now);
  return true;
}

// ---- daily alert budget ----------------------------------------------------
export function budgetOk(): { ok: boolean; remaining: number } {
  const today = new Date().toISOString().slice(0, 10);
  const day = store.getSetting<string>('budget_day', '');
  let used = store.getSetting<number>('budget_used', 0);
  if (day !== today) { used = 0; store.setSetting('budget_day', today); store.setSetting('budget_used', 0); }
  const budget = store.getSetting<number>('daily_alert_budget', 20);
  return { ok: used < budget, remaining: Math.max(0, budget - used) };
}
export function consumeBudget(): void {
  store.setSetting('budget_used', store.getSetting<number>('budget_used', 0) + 1);
}
export function alertsPaused(): boolean { return store.getSetting<boolean>('alerts_paused', false); }
