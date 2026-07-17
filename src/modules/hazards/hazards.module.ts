import { ToolDecorator as Tool, ExecutionContext, z, Module } from '@nitrostack/core';
import { fetchJson, errorPayload } from '../../lib/http.js';
import { WeatherDay, weatherFlags, kpToStorm } from '../../lib/geo.js';
import { store } from '../../lib/store.js';

export async function forecastDays(lat: number, lon: number): Promise<WeatherDay[]> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&daily=temperature_2m_max,precipitation_sum,wind_gusts_10m_max&forecast_days=3&timezone=UTC`;
  const d: any = await fetchJson(url, { ttlMs: 600_000 });
  const t = d?.daily?.time ?? [];
  return t.map((date: string, i: number) => ({
    date,
    t_max_c: d.daily.temperature_2m_max?.[i] ?? null,
    precip_mm: d.daily.precipitation_sum?.[i] ?? null,
    gust_kmh: d.daily.wind_gusts_10m_max?.[i] ?? null,
  }));
}

export async function currentKp(): Promise<number> {
  const d: any = await fetchJson('https://services.swpc.noaa.gov/json/planetary_k_index_1m.json', { ttlMs: 300_000 });
  const last = Array.isArray(d) && d.length ? d[d.length - 1] : null;
  return Number(last?.kp_index ?? last?.estimated_kp ?? 0);
}

export class HazardTools {
  @Tool({
    name: 'forecast_at',
    description:
      'Get a 3-day severe-weather outlook for one monitored asset (heat, extreme rainfall/flood risk, damaging wind gusts). ' +
      'Use when the user asks about weather risk to a site, storms, typhoons, heatwaves or flooding. Pass the exact asset name from list_assets.',
    inputSchema: z.object({ asset_name: z.string().describe('Exact name of a registered asset') }),
  })
  async forecastAt(input: { asset_name: string }, ctx: ExecutionContext) {
    const asset = store.getAsset(input.asset_name);
    if (!asset) {
      return { error: `Unknown asset '${input.asset_name}'.`, known_assets: store.assetNames() };
    }
    try {
      const days = await forecastDays(asset.lat, asset.lon);
      const flags = weatherFlags(days);
      ctx.logger.info('Forecast fetched', { asset: asset.name, flags: flags.length });
      return {
        asset: asset.name, forecast: days, flags,
        summary: flags.length ? `${flags.length} weather flag(s) in the next 3 days` : 'No severe weather flagged',
        source: 'Open-Meteo',
      };
    } catch (e) {
      return errorPayload('Open-Meteo forecast', e);
    }
  }

  @Tool({
    name: 'space_weather',
    description:
      'Current geomagnetic storm conditions from NOAA (planetary K-index). Solar storms disrupt GPS, satellite links and power grids — ' +
      'relevant to logistics, datacenters and grid-dependent factories. Use when the user asks about solar activity, GPS reliability, or as part of a full threat sweep.',
    inputSchema: z.object({}),
  })
  async spaceWeather(_input: unknown, ctx: ExecutionContext) {
    try {
      const kp = await currentKp();
      const storm = kpToStorm(kp);
      ctx.logger.info('Space weather', { kp });
      return {
        kp_index: kp, storm_level: storm.level, severity: storm.severity, assessment: storm.note,
        affected_asset_types: storm.severity === 'none' ? [] : ['datacenter', 'port', 'factory (grid-sensitive)'],
        source: 'NOAA Space Weather Prediction Center',
      };
    } catch (e) {
      return errorPayload('NOAA space weather', e);
    }
  }

  @Tool({
    name: 'news_shocks',
    description:
      'Scan global news (GDELT, updated every 15 min) for supply-chain disruption signals: strikes, port closures, accidents, unrest. ' +
      'Use with a focused query like "port strike Taiwan" or "factory fire semiconductor". Treat results as SIGNALS to investigate, not confirmed facts, and say so.',
    inputSchema: z.object({
      query: z.string().describe('Focused search, e.g. "port strike", "factory fire", a region or supplier name'),
      max_results: z.number().default(5),
    }),
  })
  async newsShocks(input: { query: string; max_results: number }, ctx: ExecutionContext) {
    try {
      const url =
        `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(input.query)}` +
        `&mode=artlist&maxrecords=${input.max_results ?? 5}&format=json&timespan=3d`;
      const d: any = await fetchJson(url, { ttlMs: 300_000 });
      const arts = (d?.articles ?? []).map((a: any) => ({
        title: a.title, url: a.url, seen: a.seendate, source: a.domain, country: a.sourcecountry,
      }));
      ctx.logger.info('News scan', { query: input.query, hits: arts.length });
      return {
        query: input.query, count: arts.length, signals: arts,
        caveat: 'News signals are unverified — treat as leads for investigation.',
        source: 'GDELT Project',
      };
    } catch (e) {
      return errorPayload('GDELT news scan', e);
    }
  }
}

@Module({
  name: 'hazards',
  description: 'Weather, space weather, and news disruption channels',
  controllers: [HazardTools],
})
export class HazardsModule {}
