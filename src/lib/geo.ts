/**
 * geo.ts — pure geospatial + risk-scoring logic for Atlas Sentinel.
 * No I/O here: everything is a pure function so it's trivially unit-testable.
 */

export interface LatLon { lat: number; lon: number; }

/** Great-circle distance in kilometres (haversine). */
export function haversineKm(a: LatLon, b: LatLon): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export type Severity = 'severe' | 'high' | 'moderate' | 'low' | 'none';

/**
 * Earthquake exposure: a transparent rule table (defensible on camera).
 * Larger magnitude => damage felt further away.
 */
export function quakeSeverity(magnitude: number, distanceKm: number): Severity {
  if (magnitude >= 7.0 && distanceKm < 250) return 'severe';
  if (magnitude >= 6.0 && distanceKm < 100) return 'severe';
  if (magnitude >= 6.0 && distanceKm < 300) return 'high';
  if (magnitude >= 5.5 && distanceKm < 150) return 'high';
  if (magnitude >= 5.0 && distanceKm < 150) return 'moderate';
  if (magnitude >= 4.5 && distanceKm < 300) return 'moderate';
  if (magnitude >= 4.5 && distanceKm < 600) return 'low';
  return 'none';
}

/** Weather flags from a 3-day forecast for one location. */
export interface WeatherDay {
  date: string;
  t_max_c: number | null;
  precip_mm: number | null;
  gust_kmh: number | null;
}
export interface WeatherFlag { severity: Severity; reason: string; date: string; }

export function weatherFlags(days: WeatherDay[]): WeatherFlag[] {
  const flags: WeatherFlag[] = [];
  for (const d of days) {
    if (d.gust_kmh != null && d.gust_kmh >= 120)
      flags.push({ severity: 'severe', reason: `damaging wind gusts ${Math.round(d.gust_kmh)} km/h`, date: d.date });
    else if (d.gust_kmh != null && d.gust_kmh >= 90)
      flags.push({ severity: 'high', reason: `strong wind gusts ${Math.round(d.gust_kmh)} km/h`, date: d.date });
    if (d.precip_mm != null && d.precip_mm >= 150)
      flags.push({ severity: 'severe', reason: `extreme rainfall ${Math.round(d.precip_mm)} mm/day (flood risk)`, date: d.date });
    else if (d.precip_mm != null && d.precip_mm >= 80)
      flags.push({ severity: 'high', reason: `heavy rainfall ${Math.round(d.precip_mm)} mm/day`, date: d.date });
    if (d.t_max_c != null && d.t_max_c >= 45)
      flags.push({ severity: 'high', reason: `extreme heat ${Math.round(d.t_max_c)}°C`, date: d.date });
    else if (d.t_max_c != null && d.t_max_c >= 42)
      flags.push({ severity: 'moderate', reason: `heatwave ${Math.round(d.t_max_c)}°C`, date: d.date });
  }
  return flags;
}

/** Geomagnetic storm class from planetary K-index (NOAA scale). */
export function kpToStorm(kp: number): { level: string; severity: Severity; note: string } {
  if (kp >= 8) return { level: 'G4-G5', severity: 'severe', note: 'severe geomagnetic storm: satellite ops, GPS and grid risk' };
  if (kp >= 7) return { level: 'G3', severity: 'high', note: 'strong storm: GPS degradation likely, satellite drag increased' };
  if (kp >= 6) return { level: 'G2', severity: 'moderate', note: 'moderate storm: high-latitude grid fluctuations possible' };
  if (kp >= 5) return { level: 'G1', severity: 'low', note: 'minor storm: weak grid fluctuations possible' };
  return { level: 'quiet', severity: 'none', note: 'quiet to unsettled conditions' };
}

const ORDER: Severity[] = ['severe', 'high', 'moderate', 'low', 'none'];
export function worstSeverity(list: Severity[]): Severity {
  for (const s of ORDER) if (list.includes(s)) return s;
  return 'none';
}
export function severityRank(s: Severity): number {
  return ORDER.indexOf(s); // 0 = worst
}
