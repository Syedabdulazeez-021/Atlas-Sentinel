/**
 * mocks.ts — realistic canned responses for every external API we use.
 * Served when ATLAS_MODE=mock. Shapes mirror the real APIs exactly, so the
 * rest of the code has ONE code path for live and mock.
 *
 * Mock quake data is modeled on real USGS GeoJSON structure; the replay
 * event mirrors the 2023-02-06 Türkiye M7.8 (usgs id us6000jllz).
 */

const now = Date.now();

const quakeFeed = {
  features: [
    {
      id: 'mockquake1',
      properties: {
        mag: 5.8, place: '89 km SE of Hualien City, Taiwan',
        time: now - 6 * 3600_000, url: 'https://earthquake.usgs.gov/mock', type: 'earthquake',
      },
      geometry: { coordinates: [121.9, 23.4, 25.0] }, // lon, lat, depth
    },
    {
      id: 'mockquake2',
      properties: {
        mag: 4.9, place: 'near the coast of Central Chile',
        time: now - 11 * 3600_000, url: 'https://earthquake.usgs.gov/mock2', type: 'earthquake',
      },
      geometry: { coordinates: [-71.6, -33.0, 40.0] },
    },
  ],
};

const turkeyReplay = {
  features: [
    {
      id: 'us6000jllz',
      properties: {
        mag: 7.8, place: 'Pazarcik earthquake, Kahramanmaras earthquake sequence',
        time: 1675671800000, url: 'https://earthquake.usgs.gov/earthquakes/eventpage/us6000jllz', type: 'earthquake',
      },
      geometry: { coordinates: [37.032, 37.166, 10.0] },
    },
  ],
};

const overpass = {
  elements: [
    { type: 'node', id: 1, lat: 23.5, lon: 121.8, tags: { amenity: 'hospital', name: 'Hualien Tzu Chi Hospital' } },
    { type: 'node', id: 2, lat: 23.45, lon: 121.85, tags: { amenity: 'hospital', name: 'Mennonite Christian Hospital' } },
    { type: 'node', id: 3, lat: 23.6, lon: 121.7, tags: { amenity: 'fire_station', name: 'Hualien County Fire Bureau' } },
  ],
};

const openMeteo = {
  daily: {
    time: ['2026-07-17', '2026-07-18', '2026-07-19'],
    temperature_2m_max: [31.2, 33.8, 43.1],
    precipitation_sum: [4.2, 96.0, 12.0],
    wind_gusts_10m_max: [38.0, 95.0, 41.0],
  },
};

const noaaKp = [
  { time_tag: new Date(now - 120000).toISOString(), kp_index: 6, estimated_kp: 6.33 },
];

const gdelt = {
  articles: [
    { title: 'Port workers announce 48-hour strike at Kaohsiung terminal', url: 'https://example.com/1', seendate: '20260717T030000Z', domain: 'example.com', sourcecountry: 'Taiwan' },
    { title: 'Typhoon watch issued for western Pacific shipping lanes', url: 'https://example.com/2', seendate: '20260717T010000Z', domain: 'example.com', sourcecountry: 'Japan' },
  ],
};

export function mockFor(url: string): unknown {
  if (url.includes('eventid=us6000jllz') || url.includes('us6000jllz')) return turkeyReplay;
  if (url.includes('earthquake.usgs.gov')) return quakeFeed;
  if (url.includes('overpass')) return overpass;
  if (url.includes('open-meteo')) return openMeteo;
  if (url.includes('swpc.noaa.gov')) return noaaKp;
  if (url.includes('gdeltproject')) return gdelt;
  return { note: 'no mock registered for this URL', url };
}
