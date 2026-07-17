import {
  ToolDecorator as Tool, ResourceDecorator as Resource, PromptDecorator as Prompt,
  ExecutionContext, z, Module,
} from '@nitrostack/core';
import { errorPayload, isMock } from '../../lib/http.js';
import { weatherFlags, kpToStorm, worstSeverity, severityRank, Severity } from '../../lib/geo.js';
import { store } from '../../lib/store.js';
import { fetchQuakes, fetchQuakeById, exposureFor, Quake } from '../seismic/seismic.module.js';
import { forecastDays, currentKp } from '../hazards/hazards.module.js';

interface Threat {
  channel: 'seismic' | 'weather' | 'space';
  severity: Severity;
  headline: string;
  asset?: string;
  detail: unknown;
}

/** Pure aggregation logic, exported for unit tests. */
export function rankThreats(threats: Threat[]): Threat[] {
  return [...threats].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
}

async function runSweep(): Promise<{ threats: Threat[]; channels_checked: string[]; errors: string[] }> {
  const threats: Threat[] = [];
  const errors: string[] = [];
  const assets = store.listAssets();

  // Channel 1: seismic — real quakes vs every asset
  try {
    const quakes = await fetchQuakes(4.5, 48);
    for (const q of quakes) {
      for (const e of exposureFor(q)) {
        if (e.severity !== 'none') {
          threats.push({
            channel: 'seismic', severity: e.severity, asset: e.asset,
            headline: `M${q.mag} earthquake ${q.place} — ${e.distance_km} km from ${e.asset} (${q.hours_ago}h ago)`,
            detail: { event: q, exposure: e },
          });
        }
      }
    }
  } catch (err) { errors.push(`seismic: ${(err as Error).message}`); }

  // Channel 2: weather — 3-day flags per asset
  for (const a of assets) {
    try {
      const flags = weatherFlags(await forecastDays(a.lat, a.lon));
      for (const f of flags) {
        threats.push({
          channel: 'weather', severity: f.severity, asset: a.name,
          headline: `${f.reason} at ${a.name} (${f.date})`, detail: f,
        });
      }
    } catch (err) { errors.push(`weather@${a.name}: ${(err as Error).message}`); }
  }

  // Channel 3: space weather — one global reading
  try {
    const kp = await currentKp();
    const storm = kpToStorm(kp);
    if (storm.severity !== 'none') {
      threats.push({
        channel: 'space', severity: storm.severity,
        headline: `Geomagnetic storm ${storm.level} (Kp ${kp}) — ${storm.note}`,
        detail: { kp, ...storm },
      });
    }
  } catch (err) { errors.push(`space: ${(err as Error).message}`); }

  return {
    threats: rankThreats(threats),
    channels_checked: ['seismic (USGS)', 'weather (Open-Meteo)', 'space (NOAA SWPC)'],
    errors,
  };
}

export class OpsTools {
  @Tool({
    name: 'threat_sweep',
    description:
      'THE flagship tool: sweep ALL physical hazard channels (real USGS earthquakes, 3-day severe weather at every asset, NOAA geomagnetic ' +
      'storms) against every monitored asset, and return a single ranked threat brief. ' +
      'WHEN TO USE: call this FIRST for any morning briefing, "current threats", "what threatens my operations/assets/factories right now", ' +
      'operations status, risk overview, or supply-chain risk question. ' +
      'NEXT STEP: ALWAYS follow with news_shocks (focused query built from the monitored asset regions, e.g. "Taiwan port strike") — ' +
      'the sweep does NOT include news signals, so a briefing is incomplete without that second call. ' +
      'WHEN NOT TO USE: exposure to one specific earthquake (check_asset_exposure); weather at one named site (forecast_at).',
    inputSchema: z.object({}),
  })
  async threatSweep(_input: unknown, ctx: ExecutionContext) {
    try {
      ctx.logger.info('Running full threat sweep');
      const sweep = await runSweep();
      const result = {
        mode: isMock() ? 'SIMULATION (mock data)' : 'LIVE — real-time data',
        generated_at_utc: new Date().toISOString(),
        assets_monitored: store.assetNames(),
        overall_level: worstSeverity(sweep.threats.map((t) => t.severity)),
        threat_count: sweep.threats.length,
        threats: sweep.threats,
        channels_checked: sweep.channels_checked,
        channel_errors: sweep.errors.length ? sweep.errors : undefined,
        next_step:
          'News signals are NOT included in this sweep. To complete the briefing, call news_shocks now with a focused query built from the monitored asset regions (e.g. "Taiwan port strike", "Japan logistics disruption").',
      };
      store.setLastSweep(result);
      return result;
    } catch (e) {
      return errorPayload('threat sweep', e);
    }
  }

  @Tool({
    name: 'generate_sitrep',
    description:
      'Generate a formal structured situation report for one earthquake event: event facts, per-asset exposure, and recommended actions. ' +
      'WHEN TO USE: after latest_events, check_asset_exposure, or replay_event — pass the event id those tools returned ' +
      '(events[].id or event.id) — whenever the user wants a sitrep, report, or something to circulate to management. ' +
      'Works for both recent and historical event ids; historical ones are clearly marked SIMULATION. ' +
      'The returned JSON is the data — present it as a clean formatted report. ' +
      'WHEN NOT TO USE: without an event id (call latest_events or replay_event first to get one); ' +
      'multi-channel briefings (threat_sweep); weather or news reports (forecast_at / news_shocks).',
    inputSchema: z.object({
      event_id: z.string().describe('USGS event id exactly as returned by latest_events (events[].id), check_asset_exposure, or replay_event (event.id)'),
    }),
  })
  async generateSitrep(input: { event_id: string }, ctx: ExecutionContext) {
    try {
      let q: Quake | undefined = (await fetchQuakes(4.0, 96)).find((x) => x.id === input.event_id);
      let mode = 'LIVE';
      if (!q) {
        // fall back to direct historical lookup => simulation
        try { q = await fetchQuakeById(input.event_id); } catch { /* fall through to error return */ }
        if (q) mode = '⚠️ SIMULATION — historical replay';
      }
      if (!q) {
        return {
          error: `Event '${input.event_id}' not found (recent or historical).`,
          hint: 'Get a valid id from latest_events (events[].id) or replay_event (event.id) first.',
        };
      }

      const exposures = exposureFor(q);
      const affected = exposures.filter((e) => e.severity !== 'none');
      const actions: string[] = [];
      for (const a of affected) {
        if (a.severity === 'severe') actions.push(`URGENT: attempt contact with ${a.asset}; activate business-continuity plan; assess personnel safety.`);
        else if (a.severity === 'high') actions.push(`Contact ${a.asset} within 2 hours; request structural + inventory status.`);
        else if (a.severity === 'moderate') actions.push(`Email ${a.asset} for status confirmation; review shipment schedules.`);
        else actions.push(`Monitor ${a.asset}; no immediate action required.`);
      }
      if (!affected.length) actions.push('No monitored assets exposed. Log event and continue monitoring.');

      ctx.logger.info('Sitrep generated', { event: q.id, affected: affected.length });
      const generatedAt = new Date().toISOString();
      const summary = `M${q.mag} earthquake, ${q.place}, ${q.hours_ago}h ago, depth ${q.depth_km} km`;
      const nextReview = 'Re-run threat_sweep in 4 hours or upon aftershock M5.0+';
      const markdown = [
        `# ATLAS SENTINEL SITUATION REPORT`,
        ``,
        `**Mode:** ${mode}  `,
        `**Generated:** ${generatedAt}  `,
        `**Event:** ${q.id} — [USGS page](${q.url})`,
        ``,
        `## SITUATION`,
        summary + '.',
        ``,
        `## ASSET IMPACT`,
        `| Asset | Type | Distance (km) | Severity |`,
        `|---|---|---:|---|`,
        ...exposures.map((e) => `| ${e.asset} | ${e.type} | ${e.distance_km} | ${e.severity.toUpperCase()} |`),
        ``,
        `## RECOMMENDED ACTIONS`,
        ...actions.map((a, i) => `${i + 1}. ${a}`),
        ``,
        `## NEXT REVIEW`,
        nextReview,
      ].join('\n');
      return {
        report_type: 'ATLAS SENTINEL SITUATION REPORT', mode,
        generated_at_utc: generatedAt,
        situation: { event: q, summary },
        asset_impact: exposures,
        affected_count: affected.length,
        recommended_actions: actions,
        next_review: nextReview,
        markdown,
        presentation_hint: 'Show the markdown field to the user as the formatted, circulateable report.',
      };
    } catch (e) {
      return errorPayload('sitrep generation', e);
    }
  }
}

export class OpsResources {
  @Resource({
    uri: 'atlas://threats/live',
    name: 'Live Threat Board',
    description: 'The most recent full threat sweep result (ranked threats across all channels). Empty until threat_sweep runs.',
    mimeType: 'application/json',
  })
  async liveThreats(uri: string, ctx: ExecutionContext) {
    const last = store.getLastSweep();
    ctx.logger.info('Serving atlas://threats/live');
    return {
      contents: [{
        uri, mimeType: 'application/json',
        text: JSON.stringify(last.result ?? { note: 'No sweep yet — call the threat_sweep tool first.', last_run: last.at }, null, 2),
      }],
    };
  }
}

export class OpsPrompts {
  @Prompt({
    name: 'morning_risk_brief',
    description: 'Executive morning briefing: sweep all channels and summarise the top threats to monitored assets with recommended actions.',
    arguments: [],
  })
  async morningBrief(_args: unknown, ctx: ExecutionContext) {
    ctx.logger.info('morning_risk_brief prompt requested');
    return [{
      role: 'user' as const,
      content:
        'Act as our risk operations officer. Run the threat_sweep tool now, then call news_shocks with a focused query built from the ' +
        'monitored asset regions (e.g. "Taiwan port strike" or "Japan logistics disruption") to add news signals. ' +
        'Then, using both outputs, write a concise executive morning brief: ' +
        '(1) overall risk level in one line, (2) top 3 threats ranked with one-sentence explanations, (3) one concrete recommended action per threat, ' +
        '(4) notable news signals (clearly marked unverified), (5) anything that needs escalation today. ' +
        'Professional, calm tone. If a channel returned an error, note it transparently.',
    }];
  }

  @Prompt({
    name: 'emergency_sitrep',
    description: 'Formal situation report for a specific earthquake event id, ready to circulate to management.',
    arguments: [{ name: 'event_id', description: 'USGS event id, e.g. us6000jllz', required: true }],
  })
  async emergencySitrep(args: { event_id?: string }, ctx: ExecutionContext) {
    ctx.logger.info('emergency_sitrep prompt requested', { event: args?.event_id });
    return [{
      role: 'user' as const,
      content:
        `An earthquake (event id: ${args?.event_id ?? 'UNKNOWN — ask the user'}) may affect our facilities. ` +
        'Call generate_sitrep for this event, then also call find_critical_infra at the epicenter coordinates. ' +
        'Present a formal situation report with sections: SITUATION, ASSETS AFFECTED, NEARBY EMERGENCY FACILITIES, RECOMMENDED ACTIONS, NEXT REVIEW. ' +
        'If the data is marked SIMULATION, state that clearly at the top.',
    }];
  }
}

@Module({
  name: 'ops',
  description: 'Orchestration: full threat sweep, situation reports, live threat board, briefing prompts',
  controllers: [OpsTools, OpsResources, OpsPrompts],
})
export class OpsModule {}
