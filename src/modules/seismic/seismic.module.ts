import { ToolDecorator as Tool, ExecutionContext, z, Module } from '@nitrostack/core';
import { fetchJson, errorPayload, isMock } from '../../lib/http.js';
import { haversineKm, quakeSeverity } from '../../lib/geo.js';
import { store } from '../../lib/store.js';

/** Normalised quake shape used everywhere downstream. */
export interface Quake {
  id: string; mag: number; place: string; time_utc: string;
  hours_ago: number; lat: number; lon: number; depth_km: number; url: string;
}

function parseUsgs(geojson: any): Quake[] {
  const feats = geojson?.features ?? [];
  return feats.map((f: any) => ({
    id: f.id,
    mag: f.properties?.mag,
    place: f.properties?.place,
    time_utc: new Date(f.properties?.time).toISOString(),
    hours_ago: Math.round((Date.now() - f.properties?.time) / 3600_000 * 10) / 10,
    lat: f.geometry?.coordinates?.[1],
    lon: f.geometry?.coordinates?.[0],
    depth_km: f.geometry?.coordinates?.[2],
    url: f.properties?.url,
  }));
}

export async function fetchQuakes(minMag: number, hoursBack: number): Promise<Quake[]> {
  // USGS FDSN query API: filter server-side by time and magnitude. Keyless.
  const start = new Date(Date.now() - hoursBack * 3600_000).toISOString();
  const url =
    `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson` +
    `&starttime=${encodeURIComponent(start)}&minmagnitude=${minMag}&orderby=magnitude&limit=30`;
  return parseUsgs(await fetchJson(url, { ttlMs: 120_000 }));
}

/** Direct USGS lookup by event id — works for any event, recent or historical. */
export async function fetchQuakeById(eventId: string): Promise<Quake | undefined> {
  const url = `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&eventid=${encodeURIComponent(eventId)}`;
  return parseUsgs(await fetchJson(url, { ttlMs: 3600_000 }))[0];
}

export function exposureFor(q: Quake) {
  return store.listAssets().map((a) => {
    const distance_km = Math.round(haversineKm({ lat: q.lat, lon: q.lon }, a));
    return { asset: a.name, type: a.type, distance_km, severity: quakeSeverity(q.mag, distance_km) };
  }).sort((x, y) => x.distance_km - y.distance_km);
}

export class SeismicTools {
  @Tool({
    name: 'latest_events',
    description:
      'Step 1 of the earthquake workflow: fetch real recent earthquakes from the USGS global feed. Each event includes magnitude, ' +
      'location, coordinates, hours ago, and a unique event id (events[].id). ' +
      'WHEN TO USE: the user asks about earthquakes or seismic activity — e.g. "Any earthquakes?", "Any big quakes in the last 24 hours?". ' +
      'NEXT STEP: if the user also asks "are my factories affected?" or "are my monitored assets at risk?", immediately call ' +
      'check_asset_exposure with an id from events[].id — never judge exposure from this feed alone. Pass an id to generate_sitrep for a formal report. ' +
      'WHEN NOT TO USE: historical/famous earthquakes (use replay_event); a full multi-channel risk overview or morning briefing (use threat_sweep); ' +
      'weather or news (use forecast_at / news_shocks).',
    inputSchema: z.object({
      min_magnitude: z.number().default(4.5).describe('Minimum magnitude (4.5 = significant; lower to 4.0 if few results)'),
      hours_back: z.number().default(24).describe('Look-back window in hours (24-72 typical)'),
    }),
  })
  async latestEvents(input: { min_magnitude: number; hours_back: number }, ctx: ExecutionContext) {
    try {
      ctx.logger.info('Fetching USGS events', input);
      const quakes = await fetchQuakes(input.min_magnitude ?? 4.5, input.hours_back ?? 24);
      return {
        mode: isMock() ? 'SIMULATION (mock data)' : 'LIVE — real USGS data',
        count: quakes.length,
        events: quakes,
        next_step: quakes.length
          ? 'To see whether monitored assets are affected, call check_asset_exposure with event_id set to one of events[].id. For a formal report, then call generate_sitrep with the same id.'
          : undefined,
        tip: quakes.length === 0 ? 'Quiet period. Lower min_magnitude to 4.0 or widen hours_back to 72.' : undefined,
      };
    } catch (e) {
      return errorPayload('USGS earthquake feed', e);
    }
  }

  @Tool({
    name: 'check_asset_exposure',
    description:
      'Step 2 of the earthquake workflow — THE core risk tool: given an earthquake event id, compute how exposed each monitored ' +
      'asset is, using distance from the epicenter vs magnitude. Severity levels: severe / high / moderate / low / none. ' +
      'Returns the event, per-asset exposures, and the affected subset. ' +
      'WHEN TO USE: right after latest_events (or replay_event) whenever the user asks "Are my factories affected?", ' +
      '"Are my monitored assets at risk?", "which sites are at risk?". Pass event_id exactly as returned in events[].id — any valid USGS id works, recent or historical. ' +
      'NEXT STEP: if the user wants a report to circulate, call generate_sitrep with the same event_id. ' +
      'WHEN NOT TO USE: without an event id (call latest_events first to get one); weather exposure (forecast_at); all-channel overview (threat_sweep).',
    inputSchema: z.object({
      event_id: z.string().describe('USGS event id exactly as returned by latest_events or replay_event, e.g. "us6000jllz"'),
      min_magnitude: z.number().default(4.0).describe('Feed filter used to re-locate the event'),
      hours_back: z.number().default(96).describe('Look-back used to re-locate the event'),
    }),
  })
  async checkExposure(input: { event_id: string; min_magnitude?: number; hours_back?: number }, ctx: ExecutionContext) {
    try {
      const quakes = await fetchQuakes(input.min_magnitude ?? 4.0, input.hours_back ?? 96);
      let q = quakes.find((x) => x.id === input.event_id);
      if (!q) {
        // The recent feed is magnitude-ordered and capped at 30, so a valid id can
        // be missing from it — fall back to a direct USGS lookup by event id.
        try { q = await fetchQuakeById(input.event_id); } catch { /* fall through to error payload */ }
      }
      if (!q) {
        return {
          error: `Event '${input.event_id}' not found (recent feed or direct USGS lookup).`,
          known_event_ids: quakes.slice(0, 10).map((x) => x.id),
          hint: 'Call latest_events first and use one of its ids, or use replay_event for historical earthquakes.',
        };
      }
      const exposures = exposureFor(q);
      const affected = exposures.filter((e) => e.severity !== 'none');
      ctx.logger.info('Exposure computed', { event: q.id, assets: exposures.length });
      return {
        event_id: q.id,
        event: q,
        exposures,
        affected,
        method: 'haversine distance vs magnitude rule table (see README for thresholds)',
        next_step: 'If the user wants a report to circulate, call generate_sitrep with this event_id.',
      };
    } catch (e) {
      return errorPayload('exposure check', e);
    }
  }

  @Tool({
    name: 'find_critical_infra',
    description:
      'Find critical infrastructure (hospitals, fire stations) near a coordinate via OpenStreetMap. ' +
      'WHEN TO USE: assessing an earthquake epicenter or asset location — e.g. enriching a generate_sitrep report with nearby emergency facilities. ' +
      'Take lat/lon from the event returned by latest_events / check_asset_exposure / replay_event, or from a registered asset. ' +
      'WHEN NOT TO USE: not a threat detector — it only lists facilities near a point.',
    inputSchema: z.object({
      lat: z.number(), lon: z.number(),
      radius_km: z.number().default(50).describe('Search radius in km (keep <= 100)'),
    }),
  })
  async findInfra(input: { lat: number; lon: number; radius_km: number }, ctx: ExecutionContext) {
    try {
      const r = Math.min(input.radius_km ?? 50, 100) * 1000;
      const q = `[out:json][timeout:20];(node["amenity"="hospital"](around:${r},${input.lat},${input.lon});node["amenity"="fire_station"](around:${r},${input.lat},${input.lon}););out 20;`;
      const data: any = await fetchJson('https://overpass-api.de/api/interpreter', {
        method: 'POST', body: 'data=' + encodeURIComponent(q), ttlMs: 600_000, timeoutMs: 25_000,
      });
      const items = (data?.elements ?? []).map((e: any) => ({
        name: e.tags?.name ?? '(unnamed)',
        kind: e.tags?.amenity,
        lat: e.lat, lon: e.lon,
        distance_km: Math.round(haversineKm({ lat: input.lat, lon: input.lon }, { lat: e.lat, lon: e.lon })),
      })).sort((a: any, b: any) => a.distance_km - b.distance_km);
      ctx.logger.info('Infra lookup', { found: items.length });
      return { count: items.length, facilities: items.slice(0, 15), source: 'OpenStreetMap via Overpass' };
    } catch (e) {
      return errorPayload('OpenStreetMap/Overpass lookup', e);
    }
  }

  @Tool({
    name: 'replay_event',
    description:
      'SIMULATION MODE: run the full Atlas exposure pipeline against a historical earthquake, clearly labeled as a replay. ' +
      'WHEN TO USE: capability demonstrations or past events — "show me how Atlas would respond to the 2023 Türkiye earthquake". ' +
      'Known ids: "us6000jllz" = 2023 Türkiye M7.8. Any USGS event id works. ' +
      'NEXT STEP: the returned event.id can be passed to generate_sitrep for a formal report, or to check_asset_exposure. ' +
      'WHEN NOT TO USE: current/recent earthquakes (use latest_events).',
    inputSchema: z.object({
      event_id: z.string().default('us6000jllz').describe('Historical USGS event id'),
    }),
  })
  async replayEvent(input: { event_id: string }, ctx: ExecutionContext) {
    try {
      const url = `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&eventid=${encodeURIComponent(input.event_id)}`;
      const q = parseUsgs(await fetchJson(url, { ttlMs: 3600_000 }))[0];
      if (!q) return { error: `No historical event '${input.event_id}' found at USGS.`, hint: 'Try "us6000jllz" (Türkiye 2023 M7.8).' };
      ctx.logger.info('Replaying historical event', { id: q.id, mag: q.mag });
      return {
        mode: '⚠️ SIMULATION — historical replay, not a current event',
        event: q,
        exposures: exposureFor(q),
        affected: exposureFor(q).filter((e) => e.severity !== 'none'),
      };
    } catch (e) {
      return errorPayload('historical replay', e);
    }
  }
}

@Module({
  name: 'seismic',
  description: 'Earthquake monitoring: USGS feed, exposure engine, OSM critical infrastructure, historical replay',
  controllers: [SeismicTools],
})
export class SeismicModule {}
