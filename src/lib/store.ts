/**
 * store.ts — the asset registry + last-sweep cache.
 *
 * Storage strategy (honest hackathon tradeoff): in-memory Map, seeded from
 * data/assets.seed.json at boot, best-effort persisted to data/assets.json
 * after writes. NitroCloud may scale to zero and reset the filesystem, so the
 * seed guarantees demo assets always exist. Swappable for a real DB later —
 * every access goes through this module.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

export interface Asset {
  name: string;
  lat: number;
  lon: number;
  type: 'office' | 'warehouse' | 'supplier' | 'factory' | 'datacenter' | 'port';
  notes?: string;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../../data');
const SEED = path.join(DATA_DIR, 'assets.seed.json');
const PERSIST = path.join(DATA_DIR, 'assets.json');

const assets = new Map<string, Asset>();
let lastSweep: unknown = null;
let lastSweepAt: string | null = null;

function load(file: string) {
  try {
    const arr: Asset[] = JSON.parse(fs.readFileSync(file, 'utf-8'));
    for (const a of arr) assets.set(a.name.toLowerCase(), a);
  } catch {
    /* file absent is fine */
  }
}
load(SEED);
load(PERSIST); // user-registered assets override/extend seed

function persist() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(PERSIST, JSON.stringify([...assets.values()], null, 2));
  } catch {
    /* read-only FS in some deploys — in-memory still works */
  }
}

export const store = {
  addAsset(a: Asset): Asset {
    assets.set(a.name.toLowerCase(), a);
    persist();
    return a;
  },
  removeAsset(name: string): boolean {
    const ok = assets.delete(name.toLowerCase());
    if (ok) persist();
    return ok;
  },
  getAsset(name: string): Asset | undefined {
    return assets.get(name.toLowerCase());
  },
  listAssets(): Asset[] {
    return [...assets.values()];
  },
  assetNames(): string[] {
    return [...assets.values()].map((a) => a.name);
  },
  setLastSweep(result: unknown) {
    lastSweep = result;
    lastSweepAt = new Date().toISOString();
  },
  getLastSweep(): { at: string | null; result: unknown } {
    return { at: lastSweepAt, result: lastSweep };
  },
};
