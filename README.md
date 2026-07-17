# Atlas Sentinel 🌍🛰️ (v2 — crash-proof build)

> v2 changes: signals-not-verdicts sweep architecture (AI does cross-channel correlation), resources as the state layer, 3 workflow prompts, full alerting suite (Telegram + confirmation guardrails + watchman + budget/kill-switch + audit), **pure-JSON persistence (zero native modules — immune to the NitroStudio runtime-mismatch crash)**, and process-level crash shields.

**Real-time threat monitoring for factories and supply chains — as an MCP server any AI assistant can use.**

Enterprises pay critical-event-management vendors millions to learn, fast, when the world threatens their operations. Atlas Sentinel is that capability as an open MCP server: register your factories, warehouses and suppliers, then ask any AI assistant *"what threatens my operations right now?"* — it sweeps live planetary data (real USGS earthquakes, severe weather at every site, NOAA geomagnetic storms, global news signals) and returns a ranked threat brief with recommended actions.

## Architecture

```
 Claude / ChatGPT / NitroChat / any MCP client
        │  MCP (STDIO locally, HTTP/SSE deployed)
        ▼
 ┌─────────────────────────────────────────────────────┐
 │ atlas-sentinel (NitroStack)                          │
 │  assets ──── registry: the sites Atlas protects      │
 │  seismic ─── USGS quakes → exposure engine → OSM     │
 │              critical infrastructure (Overpass)      │
 │  hazards ─── Open-Meteo weather · NOAA space weather │
 │              · GDELT news signals                    │
 │  ops ─────── threat_sweep (all channels, ranked)     │
 │              generate_sitrep · prompts · live board  │
 └────────┬───────────┬───────────┬───────────┬────────┘
          ▼           ▼           ▼           ▼
        USGS      Open-Meteo   NOAA SWPC    GDELT + OSM
      (keyless)   (keyless)    (keyless)    (keyless)
```

## MCP surface
**12 Tools** — register_asset, list_assets, remove_asset, latest_events, check_asset_exposure, find_critical_infra, replay_event, forecast_at, space_weather, news_shocks, threat_sweep ⭐, generate_sitrep
**2 Resources** — atlas://assets · atlas://threats/live
**2 Prompts** — morning_risk_brief · emergency_sitrep

## Quickstart
```bash
npm install
npm run dev            # local MCP server with hot reload (STDIO + widget server)
```
Open **NitroStudio**, connect to this project, and chat: "Any big earthquakes in the last 24 hours?"

Env: `ATLAS_MODE=live` (default, real APIs) · `ATLAS_MODE=mock` (offline demo fallback)

Tests: `npx tsx --test tests/logic.test.ts`

## Demo script (2 minutes)
1. "What assets is Atlas monitoring?" → seeded supply chain (Hsinchu / Osaka / Kochi)
2. "What threatens my operations right now?" → threat_sweep: ranked brief citing real events with real timestamps
3. "Register our textile supplier in Gaziantep, Türkiye at 37.07, 37.38" → live registration
4. "Show how Atlas would have responded to the 2023 Türkiye earthquake" → replay_event us6000jllz → SEVERE exposure, stamped ⚠️ SIMULATION
5. "Give me a formal sitrep for that event" → structured report + real hospitals near the epicenter
6. Same deployed URL answering in a second LLM client — one server, every AI

## Design principles
Never crashes ({error, hint} payloads, 12s timeouts) · errors teach (unknown ids return known ids) · honest data (LIVE vs SIMULATION stamps) · transparent risk model (rule table in src/lib/geo.ts, unit-tested) · TTL caching on all external calls.

## External components (declared per R12)
USGS FDSN Event API · Open-Meteo · NOAA SWPC · GDELT DOC API · OpenStreetMap/Overpass — all keyless, free. NitroStack SDK/CLI, zod, dotenv, tsx.
AI coding assistants (Claude) used for implementation assistance per R22; problem definition, architecture and creative direction by Team Atlas.

## Roadmap
NASA FIRMS wildfire channel · webhook alerts · per-asset thresholds · AIS maritime channel · multi-tenant registries.
