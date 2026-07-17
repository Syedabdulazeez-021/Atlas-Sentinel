/** Unit tests for Atlas Sentinel's pure logic (node --test, zero deps). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haversineKm, quakeSeverity, weatherFlags, kpToStorm, worstSeverity } from '../src/lib/geo.js';
import { rankThreats } from '../src/modules/ops/ops.module.js';

test('haversine: Kochi to Chennai ~ 560 km', () => {
  const d = haversineKm({ lat: 9.93, lon: 76.26 }, { lat: 13.08, lon: 80.27 }); // ~560 km
  assert.ok(d > 500 && d < 620, `got ${d}`);
});

test('haversine: zero distance', () => {
  assert.equal(Math.round(haversineKm({ lat: 10, lon: 10 }, { lat: 10, lon: 10 })), 0);
});

test('quake severity table', () => {
  assert.equal(quakeSeverity(7.8, 60), 'severe');
  assert.equal(quakeSeverity(6.2, 200), 'high');
  assert.equal(quakeSeverity(5.0, 100), 'moderate');
  assert.equal(quakeSeverity(4.6, 500), 'low');
  assert.equal(quakeSeverity(4.6, 2000), 'none');
  assert.equal(quakeSeverity(3.0, 10), 'none');
});

test('weather flags fire on thresholds only', () => {
  const flags = weatherFlags([
    { date: 'd1', t_max_c: 30, precip_mm: 5, gust_kmh: 40 },   // calm
    { date: 'd2', t_max_c: 43, precip_mm: 96, gust_kmh: 95 },  // 3 flags
    { date: 'd3', t_max_c: 46, precip_mm: 160, gust_kmh: 130 } // 3 severe-ish
  ]);
  assert.equal(flags.filter(f => f.date === 'd1').length, 0);
  assert.equal(flags.filter(f => f.date === 'd2').length, 3);
  assert.ok(flags.some(f => f.severity === 'severe' && f.date === 'd3'));
});

test('kp mapping', () => {
  assert.equal(kpToStorm(2).severity, 'none');
  assert.equal(kpToStorm(5).level, 'G1');
  assert.equal(kpToStorm(7).severity, 'high');
  assert.equal(kpToStorm(9).severity, 'severe');
});

test('worstSeverity and rankThreats order severe-first', () => {
  assert.equal(worstSeverity(['low', 'severe', 'moderate']), 'severe');
  const ranked = rankThreats([
    { channel: 'weather', severity: 'low', headline: 'a', detail: {} },
    { channel: 'seismic', severity: 'severe', headline: 'b', detail: {} },
    { channel: 'space', severity: 'moderate', headline: 'c', detail: {} },
  ] as any);
  assert.deepEqual(ranked.map((t: any) => t.severity), ['severe', 'moderate', 'low']);
});
