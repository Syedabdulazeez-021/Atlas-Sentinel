/**
 * store.ts — persistence for Atlas Sentinel with ZERO native dependencies.
 *
 * Why JSON files instead of SQLite: NitroStudio spawns the server with its own
 * runtime; native modules (better-sqlite3) can hard-crash on ABI mismatch the
 * moment they're first used. Pure-JS file persistence cannot. Atomic writes
 * (tmp file + rename), every operation wrapped so storage failure can never
 * kill a tool call. Survives restarts and redeploys.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

export interface Asset {
  name: string; lat: number; lon: number;
  type: 'office' | 'warehouse' | 'supplier' | 'factory' | 'datacenter' | 'port';
  notes?: string;
}
export interface Contact {
  name: string; role: 'owner' | 'hospital' | 'emergency';
  asset_name: string; telegram_chat_id: string; email?: string;
}
export interface AuditEntry { ts: string; tool: string; summary: string; outcome: string; }

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../../data');
const F = {
  assets: path.join(DATA_DIR, 'assets.json'),
  seed: path.join(DATA_DIR, 'assets.seed.json'),
  contacts: path.join(DATA_DIR, 'contacts.json'),
  settings: path.join(DATA_DIR, 'settings.json'),
  audit: path.join(DATA_DIR, 'audit.json'),
  sweep: path.join(DATA_DIR, 'lastsweep.json'),
  sitrep: path.join(DATA_DIR, 'lastsitrep.json'),
};

function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')) as T; } catch { return fallback; }
}
function writeJson(file: string, value: unknown): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, file); // atomic on same volume
  } catch { /* storage must never crash a tool */ }
}

// ---- in-memory state, hydrated from disk at boot ---------------------------
const assets = new Map<string, Asset>();
const contacts = new Map<string, Contact>();
let settings: Record<string, unknown> = {};
let audit: AuditEntry[] = [];
let lastSweep: unknown = null;
let lastSweepAt: string | null = null;
let lastSitrep: unknown = null;

for (const a of readJson<Asset[]>(F.seed, [])) assets.set(a.name.toLowerCase(), a);
for (const a of readJson<Asset[]>(F.assets, [])) assets.set(a.name.toLowerCase(), a);
for (const c of readJson<Contact[]>(F.contacts, [])) contacts.set(c.name.toLowerCase(), c);
settings = readJson<Record<string, unknown>>(F.settings, {});
audit = readJson<AuditEntry[]>(F.audit, []);
const sw = readJson<{ at: string | null; result: unknown } | null>(F.sweep, null);
if (sw) { lastSweep = sw.result; lastSweepAt = sw.at; }
lastSitrep = readJson<unknown>(F.sitrep, null);

// Seed owner contact from env (no personal ids in source)
const ownerChat = process.env.ATLAS_OWNER_CHAT_ID;
if (ownerChat && contacts.size === 0) {
  const seedContacts: Contact[] = [
    { name: 'Owner (Kochi)', role: 'owner', asset_name: 'Kochi Assembly Plant', telegram_chat_id: ownerChat },
    { name: 'Owner (Hsinchu)', role: 'owner', asset_name: 'Hsinchu Chip Supplier', telegram_chat_id: ownerChat },
  ];
  for (const c of seedContacts) contacts.set(c.name.toLowerCase(), c);
  writeJson(F.contacts, [...contacts.values()]);
}

export const store = {
  // assets
  addAsset(a: Asset): Asset { assets.set(a.name.toLowerCase(), a); writeJson(F.assets, [...assets.values()]); return a; },
  removeAsset(name: string): boolean { const ok = assets.delete(name.toLowerCase()); if (ok) writeJson(F.assets, [...assets.values()]); return ok; },
  getAsset(name: string): Asset | undefined { return assets.get(name.toLowerCase()); },
  listAssets(): Asset[] { return [...assets.values()]; },
  assetNames(): string[] { return [...assets.values()].map((a) => a.name); },
  // contacts
  addContact(c: Contact): Contact { contacts.set(c.name.toLowerCase(), c); writeJson(F.contacts, [...contacts.values()]); return c; },
  removeContact(name: string): boolean { const ok = contacts.delete(name.toLowerCase()); if (ok) writeJson(F.contacts, [...contacts.values()]); return ok; },
  listContacts(): Contact[] { return [...contacts.values()]; },
  contactsForAsset(asset: string): Contact[] { return [...contacts.values()].filter((c) => c.asset_name.toLowerCase() === asset.toLowerCase()); },
  // settings (threshold, budget, pause, monitoring)
  getSetting<T>(key: string, fallback: T): T { return (settings[key] as T) ?? fallback; },
  setSetting(key: string, value: unknown): void { settings[key] = value; writeJson(F.settings, settings); },
  // audit log (capped at 200)
  addAudit(tool: string, summary: string, outcome: string): void {
    audit.push({ ts: new Date().toISOString(), tool, summary: String(summary).slice(0, 300), outcome });
    if (audit.length > 200) audit = audit.slice(-200);
    writeJson(F.audit, audit);
  },
  getAudit(limit = 20): AuditEntry[] { return audit.slice(-limit).reverse(); },
  // sweep / sitrep state
  setLastSweep(result: unknown): void { lastSweep = result; lastSweepAt = new Date().toISOString(); writeJson(F.sweep, { at: lastSweepAt, result }); },
  getLastSweep(): { at: string | null; result: unknown } { return { at: lastSweepAt, result: lastSweep }; },
  setLastSitrep(r: unknown): void { lastSitrep = r; writeJson(F.sitrep, r); },
  getLastSitrep(): unknown { return lastSitrep; },
};
