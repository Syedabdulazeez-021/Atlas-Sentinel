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
      'Fetch real recent earthquakes from the USGS global feed, with magnitude, location, coordinates, hours ago, and a unique ' +
      'event id per quake. WHEN TO USE: any question like "Any significant earthquakes in the last day?", "any earthquakes?", ' +
      '"recent seismic activity?" — this is always the FIRST tool of the earthquake workflow. ' +
      'If the user also asks "are any of my monitored assets at risk?" or "are my factories affected?", follow up with ' +
      'check_asset_exposure using an id from events[].id. ' +
      'WHEN NOT TO USE: historical/famous earthquakes (replay_event); a full multi-channel risk overview (threat_sweep).',
    inputSchema: z.object({
      min_magnitude: z.number().default(4.5).describe('Minimum magnitude (4.5 = significant; lower to 4.0 if few results)'),
      hours_back: z.number().default(24).describe('Look-back window in hours (24-72 typical)'),
    }),
  })
  async latestEvents(input: { min_magnitude: number; hours_back: number }, ctx: ExecutionContext) {
    try {
      ctx.logger.info('Fetching USGS events', input);
      const minMag = input.min_magnitude ?? 4.5;
      const hours = input.hours_back ?? 24;
      const quakes = await fetchQuakes(minMag, hours);
      return {
        summary: quakes.length
          ? `Found ${quakes.length} earthquake(s) M${minMag}+ in the last ${hours}h from the USGS feed — largest: M${quakes[0].mag} ${quakes[0].place}.`
          : `No earthquakes M${minMag}+ in the last ${hours}h — a quiet period.`,
        mode: isMock() ? 'SIMULATION (mock data)' : 'LIVE — real USGS data',
        count: quakes.length,
        events: quakes,
        tip: quakes.length === 0 ? 'Quiet period. Lower min_magnitude to 4.0 or widen hours_back to 72.' : undefined,
      };
    } catch (e) {
      return errorPayload('USGS earthquake feed', e);
    }
  }

  @Tool({
    name: 'check_asset_exposure',
    description:
      'THE core risk tool: given an earthquake event id (from latest_events or replay_event), compute how exposed each ' +
      'monitored asset is, using distance from the epicenter and magnitude. Severity levels: severe / high / moderate / low / none. ' +
      'Use whenever the user asks "are we affected", "which sites are at risk", or after any significant event is found.',
    inputSchema: z.object({
      event_id: z.string().describe('USGS event id, e.g. "us6000jllz"'),
      min_magnitude: z.number().default(4.0).describe('Feed filter used to re-locate the event'),
      hours_back: z.number().default(96).describe('Look-back used to re-locate the event'),
    }),
  })
  async checkExposure(input: { event_id: string; min_magnitude?: number; hours_back?: number }, ctx: ExecutionContext) {
    try {
      const quakes = await fetchQuakes(input.min_magnitude ?? 4.0, input.hours_back ?? 96);
      let q = quakes.find((x) => x.id === input.event_id);
      if (!q) {
        // Recent feed is magnitude-ordered and capped at 30 — fall back to direct by-id lookup.
        try { q = await fetchQuakeById(input.event_id); } catch { /* fall through */ }
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
        summary: `Exposure check for M${q.mag} earthquake ${q.place}: ${affected.length} of ${exposures.length} monitored assets potentially affected.`,
        event: q,
        exposures,
        affected,
        method: 'haversine distance vs magnitude rule table (see README for thresholds)',
      };
    } catch (e) {
      return errorPayload('exposure check', e);
    }
  }

  @Tool({
    name: 'find_critical_infra',
    description:
      'Find critical infrastructure (hospitals, fire stations) near a coordinate via OpenStreetMap. ' +
      'Use when assessing an earthquake epicenter or asset location — e.g. for a situation report listing nearby emergency facilities.',
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
      'SIMULATION MODE: run the full Atlas exposure pipeline against a famous historical earthquake, clearly labeled as a replay. ' +
      'Use for capability demonstrations ("show me how Atlas would respond to the 2023 Türkiye earthquake"). ' +
      'Known ids: "us6000jllz" = 2023 Türkiye M7.8. Any USGS event id works.',
    inputSchema: z.object({
      event_id: z.string().default('us6000jllz').describe('Historical USGS event id'),
    }),
  })
  async replayEvent(input: { event_id: string }, ctx: ExecutionContext) {
    try {
      const url = `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&eventid=${encodeURIComponent(input.event_id)}`;
      let q = await fetchJson(url, { ttlMs: 3600_000 }).then((d) => parseUsgs(d)[0]).catch(() => undefined as Quake | undefined);
      if (!q && input.event_id === 'us6000jllz') {
        q = { id: 'us6000jllz', mag: 7.8, place: 'Pazarcik earthquake, Kahramanmaras, Türkiye',
          time_utc: '2023-02-06T01:17:00Z', hours_ago: Math.round((Date.now() - 1675646220000) / 3600_000),
          lat: 37.166, lon: 37.032, depth_km: 10,
          url: 'https://earthquake.usgs.gov/earthquakes/eventpage/us6000jllz' }; // offline fallback
      }
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
