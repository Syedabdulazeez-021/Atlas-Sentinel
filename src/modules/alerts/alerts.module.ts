import {
  ToolDecorator as Tool, ResourceDecorator as Resource, PromptDecorator as Prompt,
  ExecutionContext, z, Module,
} from '@nitrostack/core';
import { errorPayload } from '../../lib/http.js';
import { store, Contact } from '../../lib/store.js';
import { rateLimitOk, budgetOk, consumeBudget, alertsPaused, sanitizeUntrusted } from '../../lib/guardrails.js';
import { fetchQuakes, exposureFor } from '../seismic/seismic.module.js';
import { severityRank, Severity } from '../../lib/geo.js';

const SEVERITIES = ['severe', 'high', 'moderate', 'low'] as const;
type Level = typeof SEVERITIES[number];

function meetsThreshold(sev: Severity, threshold: Level): boolean {
  return severityRank(sev) <= severityRank(threshold);
}

/** Send one Telegram message. Never throws. */
async function telegramSend(chatId: string, text: string):
  Promise<{ sent: boolean; error?: string }> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return { sent: false, error: 'Set TELEGRAM_BOT_TOKEN in .env. Get one from @BotFather on Telegram.' };
  if (alertsPaused()) return { sent: false, error: 'Alerts are paused (kill switch). Use resume_alerts to re-enable.' };
  const budget = budgetOk();
  if (!budget.ok) return { sent: false, error: 'Daily alert budget exhausted. Use set_alert_budget or wait until UTC midnight.' };
  if (!rateLimitOk()) return { sent: false, error: 'Rate limit: max 5 alerts per minute. Wait a moment.' };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 1000), parse_mode: 'Markdown' }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok || body?.ok === false) return { sent: false, error: `Telegram: ${body?.description ?? res.status}` };
    consumeBudget();
    return { sent: true };
  } catch (e) {
    return { sent: false, error: `Telegram send failed: ${(e as Error).message}` };
  }
}

function formatAlert(sev: string, asset: string, headline: string, channel: string): string {
  const action =
    sev === 'severe' ? 'URGENT: contact site immediately, activate business continuity plan' :
    sev === 'high' ? 'Contact site within 2 hours for status check' :
    'Email site for status confirmation, review schedules';
  return `🚨 *ATLAS SENTINEL ALERT*\n*Severity:* ${sev.toUpperCase()}\n*Asset:* ${asset}\n*Threat:* ${headline}\n*Channel:* ${channel}\n*Recommended action:* ${action}\n*Generated:* ${new Date().toISOString()}\n— Atlas Sentinel · automated threat monitoring`;
}

// ---------------- background watchman ---------------------------------------
let monitorTimer: ReturnType<typeof setInterval> | null = null;
const alerted = new Set<string>(); // event_id+asset dedup
let checksRun = 0, alertsSent = 0, lastCheck: string | null = null;

async function monitorCycle(): Promise<void> {
  try {
    checksRun += 1; lastCheck = new Date().toISOString();
    const threshold = store.getSetting<Level>('alert_threshold', 'high');
    const quakes = await fetchQuakes(4.5, 1);
    for (const q of quakes) for (const e of exposureFor(q)) {
      const key = `${q.id}|${e.asset}`;
      if (e.severity === 'none' || alerted.has(key) || !meetsThreshold(e.severity, threshold)) continue;
      alerted.add(key);
      for (const c of store.contactsForAsset(e.asset)) {
        const msg = formatAlert(e.severity, e.asset,
          `M${q.mag} earthquake ${q.place} — ${e.distance_km} km away (${q.hours_ago}h ago)`, 'seismic');
        const r = await telegramSend(c.telegram_chat_id, msg);
        store.addAudit('watchman', `${key} -> ${c.name}`, r.sent ? 'sent' : `blocked: ${r.error}`);
        if (r.sent) alertsSent += 1;
      }
    }
  } catch (err) {
    try { store.addAudit('watchman', 'cycle error', String((err as Error).message)); } catch { /* never die */ }
  }
}

export class AlertTools {
  @Tool({
    name: 'register_contact',
    description: 'Register a stakeholder to receive Telegram alerts for a specific asset. ' +
      'IMPORTANT: the contact must first open Telegram, find the bot, and press Start — Telegram does not allow bots to message users who have not initiated contact.',
    inputSchema: z.object({
      name: z.string(), role: z.enum(['owner', 'hospital', 'emergency']),
      asset_name: z.string(), telegram_chat_id: z.string(), email: z.string().optional(),
    }),
  })
  async registerContact(input: Contact, ctx: ExecutionContext) {
    if (!store.getAsset(input.asset_name))
      return { error: `Unknown asset '${input.asset_name}'.`, known_assets: store.assetNames() };
    store.addContact(input);
    ctx.logger.info('contact registered', { name: input.name });
    return { registered: input, total_contacts: store.listContacts().length };
  }

  @Tool({
    name: 'list_contacts',
    description: 'List all registered alert contacts with their assets and roles.',
    inputSchema: z.object({}),
  })
  async listContacts(_i: unknown, ctx: ExecutionContext) {
    ctx.logger.info('list contacts');
    return { count: store.listContacts().length, contacts: store.listContacts() };
  }

  @Tool({
    name: 'send_alert',
    description: 'Send a Telegram alert to registered contacts (optionally only those of one asset), OR to one specific telegram_chat_id. ' +
      'GUARDRAIL: direct chat ids must already be in the contacts registry or equal the server owner id (prevents spam relay). ' +
      'GUARDRAIL: first call WITHOUT confirm returns a preview — show it to the user and only re-call with confirm=true after explicit approval. ' +
      "Use when the user says 'notify the team' or 'alert the factory owner'.",
    inputSchema: z.object({
      message: z.string().describe('Alert text; if generic/empty the latest sweep summary is attached'),
      asset_name: z.string().optional(),
      telegram_chat_id: z.string().optional().describe('Send to this one chat id instead of registered contacts'),
      confirm: z.boolean().default(false).describe('Must be true to actually send; false returns a preview'),
    }),
  })
  async sendAlert(input: { message: string; asset_name?: string; telegram_chat_id?: string; confirm?: boolean }, ctx: ExecutionContext) {
    try {
      if (input.telegram_chat_id) {
        const allowed = new Set(store.listContacts().map((c) => c.telegram_chat_id));
        if (process.env.ATLAS_OWNER_CHAT_ID) allowed.add(process.env.ATLAS_OWNER_CHAT_ID);
        if (!allowed.has(input.telegram_chat_id))
          return { error: 'Chat id not in the allowed set (registered contacts + owner). Register the contact first — this guardrail prevents the bot being used as a spam relay.' };
        if (!input.confirm)
          return { requires_confirmation: true, preview: { recipient: input.telegram_chat_id, message_text: input.message.slice(0, 1000) },
            instruction: 'Show this preview to the user. Only re-call with confirm=true after explicit approval.' };
        const r = await telegramSend(input.telegram_chat_id, input.message);
        store.addAudit('send_alert', `direct:${input.telegram_chat_id}`, r.sent ? 'sent' : `blocked: ${r.error}`);
        return r;
      }
      const targets = input.asset_name ? store.contactsForAsset(input.asset_name) : store.listContacts();
      if (!targets.length) return { error: 'No matching contacts.', known_contacts: store.listContacts().map((c) => c.name) };
      let text = (input.message ?? '').trim();
      if (text.length < 10) {
        const last: any = store.getLastSweep().result;
        text = `🚨 *ATLAS SENTINEL ALERT*\n${text || 'Status update.'}\nLatest sweep: ${last?.signal_count ?? 0} signals at ${last?.generated_at_utc ?? 'n/a'}.\n— Atlas Sentinel`;
      }
      if (!input.confirm) {
        store.addAudit('send_alert', `preview to ${targets.length} contact(s)`, 'awaiting confirmation');
        return { requires_confirmation: true,
          preview: { recipients: targets.map((c) => `${c.name} (${c.asset_name})`), message_text: text },
          instruction: 'Show this preview to the user. Only re-call with confirm=true after explicit user approval.' };
      }
      const results = [];
      for (const c of targets) {
        const r = await telegramSend(c.telegram_chat_id, text);
        store.addAudit('send_alert', c.name, r.sent ? 'sent' : `blocked: ${r.error}`);
        results.push({ contact: c.name, ...r });
      }
      return { sent_to: results.filter((r) => r.sent).map((r) => r.contact),
        failed: results.filter((r) => !r.sent) };
    } catch (e) { return errorPayload('send_alert', e); }
  }

  @Tool({
    name: 'auto_alert_sweep',
    description: 'Run a fresh seismic exposure check and AUTOMATICALLY notify registered contacts via Telegram for any threat at or above the ' +
      "configured threshold (no confirmation needed — this is the autonomous path, governed by budget/rate/kill-switch guardrails). " +
      "Use when the user says 'check and alert', 'run alerts', or 'notify if anything is wrong'.",
    inputSchema: z.object({}),
  })
  async autoAlertSweep(_i: unknown, ctx: ExecutionContext) {
    try {
      const threshold = store.getSetting<Level>('alert_threshold', 'high');
      const quakes = await fetchQuakes(4.5, 48);
      const sent: string[] = []; const found: string[] = [];
      for (const q of quakes) for (const e of exposureFor(q)) {
        if (e.severity === 'none') continue;
        found.push(`${e.severity}: ${e.asset} <- M${q.mag} ${q.place}`);
        if (!meetsThreshold(e.severity, threshold)) continue;
        for (const c of store.contactsForAsset(e.asset)) {
          const r = await telegramSend(c.telegram_chat_id,
            formatAlert(e.severity, e.asset, `M${q.mag} earthquake ${q.place} — ${e.distance_km} km away (${q.hours_ago}h ago)`, 'seismic'));
          store.addAudit('auto_alert_sweep', c.name, r.sent ? 'sent' : `blocked: ${r.error}`);
          if (r.sent) sent.push(c.name);
        }
      }
      ctx.logger.info('auto_alert_sweep', { found: found.length, sent: sent.length });
      return { threshold, threats_found: found, alerts_sent: sent,
        note: sent.length ? undefined : `No threats at ${threshold}+ — no alerts fired (working as designed).` };
    } catch (e) { return errorPayload('auto_alert_sweep', e); }
  }

  
  @Tool({
    name: 'monitoring',
    description: "Control the autonomous background watchman with one tool. action='start' (with optional interval_minutes, default 5): " +
      "Atlas checks USGS every N minutes and auto-alerts contacts above the threshold even when nobody is chatting — use when the user says " +
      "'watch my assets' or 'alert me if an earthquake happens'. action='stop' halts it. action='status' reports active state and statistics. " +
      'Note: the timer runs while the server process is alive; serverless scale-to-zero pauses it when the server sleeps.',
    inputSchema: z.object({
      action: z.enum(['start', 'stop', 'status']),
      interval_minutes: z.number().min(1).max(60).default(5).describe('Only used with start'),
    }),
  })
  async monitoring(input: { action: 'start' | 'stop' | 'status'; interval_minutes?: number }, ctx: ExecutionContext) {
    try {
      if (input.action === 'start') {
        const mins = input.interval_minutes ?? 5;
        if (monitorTimer) clearInterval(monitorTimer);
        monitorTimer = setInterval(() => { void monitorCycle(); }, mins * 60_000);
        store.setSetting('monitoring_active', true);
        store.setSetting('monitoring_interval', mins);
        void monitorCycle();
        ctx.logger.info('monitoring started', { mins });
        return { active: true, interval_minutes: mins, message: `Watchman armed: checking USGS every ${mins} min.` };
      }
      if (input.action === 'stop') {
        if (monitorTimer) clearInterval(monitorTimer);
        monitorTimer = null;
        store.setSetting('monitoring_active', false);
        ctx.logger.info('monitoring stopped');
        return { active: false };
      }
      return { active: monitorTimer !== null,
        interval_minutes: store.getSetting<number>('monitoring_interval', 5),
        checks_run: checksRun, alerts_sent: alertsSent, last_check_utc: lastCheck,
        threshold: store.getSetting('alert_threshold', 'high') };
    } catch (e) { return errorPayload('monitoring', e); }
  }

  @Tool({
    name: 'alert_controls',
    description: "Configure the alerting guardrails with one tool. action='set_threshold' + level (severe/high/moderate/low): minimum severity that " +
      "triggers alerts — use for 'alert me only for severe' or 'notify on moderate or above'. action='pause': KILL SWITCH, instantly stop ALL sends " +
      "(use immediately if the user reports spam or wants silence). action='resume': re-enable. action='set_budget' + per_day: max Telegram alerts per day (default 20). " +
      "action='status': current threshold, pause state, budget remaining.",
    inputSchema: z.object({
      action: z.enum(['set_threshold', 'pause', 'resume', 'set_budget', 'status']),
      level: z.enum(SEVERITIES).optional().describe('For set_threshold'),
      per_day: z.number().min(1).max(500).optional().describe('For set_budget'),
    }),
  })
  async alertControls(input: { action: string; level?: Level; per_day?: number }, ctx: ExecutionContext) {
    try {
      switch (input.action) {
        case 'set_threshold': {
          if (!input.level) return { error: "Provide level (severe/high/moderate/low) with action='set_threshold'." };
          store.setSetting('alert_threshold', input.level);
          ctx.logger.info('threshold set', { level: input.level });
          return { threshold: input.level, message: `Atlas now alerts on ${input.level} and above.` };
        }
        case 'pause':
          store.setSetting('alerts_paused', true); store.addAudit('alert_controls', 'kill switch', 'paused');
          return { alerts_paused: true };
        case 'resume':
          store.setSetting('alerts_paused', false); store.addAudit('alert_controls', 'kill switch', 'resumed');
          return { alerts_paused: false };
        case 'set_budget': {
          if (!input.per_day) return { error: "Provide per_day with action='set_budget'." };
          store.setSetting('daily_alert_budget', input.per_day);
          return { daily_alert_budget: input.per_day };
        }
        default:
          return { threshold: store.getSetting('alert_threshold', 'high'),
            alerts_paused: store.getSetting('alerts_paused', false),
            daily_alert_budget: store.getSetting('daily_alert_budget', 20),
            budget_used_today: store.getSetting('budget_used', 0) };
      }
    } catch (e) { return errorPayload('alert_controls', e); }
  }
}



export class AlertResources {
  @Resource({ uri: 'atlas://contacts', name: 'Alert Contacts',
    description: 'All registered alert contacts and their assets.', mimeType: 'application/json' })
  async contacts(uri: string, ctx: ExecutionContext) {
    ctx.logger.info('read atlas://contacts');
    return { contents: [{ uri, mimeType: 'application/json',
      text: JSON.stringify({ contacts: store.listContacts() }, null, 2) }] };
  }

  @Resource({ uri: 'atlas://audit', name: 'Audit Log',
    description: 'Last 50 alert/guardrail decisions — the system flight recorder.', mimeType: 'application/json' })
  async audit(uri: string, ctx: ExecutionContext) {
    ctx.logger.info('read atlas://audit');
    return { contents: [{ uri, mimeType: 'application/json',
      text: JSON.stringify({ entries: store.getAudit(50) }, null, 2) }] };
  }
}

export class AlertPrompts {
  @Prompt({ name: 'alert_sweep_notify',
    description: 'Check all hazards and automatically notify affected contacts; summarize findings and who was notified.',
    arguments: [] })
  async alertSweepNotify(_a: unknown, ctx: ExecutionContext) {
    ctx.logger.info('prompt alert_sweep_notify');
    return [{ role: 'user' as const, content:
      'Run auto_alert_sweep to check current seismic threats against all assets and auto-notify contacts above the threshold. ' +
      'Then call get_audit_log to confirm what was actually sent. Summarize: threats found, who was notified, anything blocked by guardrails and why.' }];
  }
}

export { sanitizeUntrusted };

@Module({
  name: 'alerts',
  description: 'Alerting: contacts, thresholds, guarded Telegram sends, autonomous watchman, budget/kill-switch, audit log',
  controllers: [AlertTools, AlertResources, AlertPrompts],
})
export class AlertsModule {}
