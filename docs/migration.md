# Moving Live's AI into OpenVibe.AI

OpenVibe.Live grew into the network's de facto AI service: every feature called model providers
through `server/ai/llm.js` with the shared key held in Live's admin settings, and Network's footer
copy called Live's `/internal/ai/site-copy`. This document is the cutover plan: what moves here,
what stays in Live, how to import, and how to switch and roll back.

## What moves and what stays

### Records that move here

| Live source | Becomes in OpenVibe.AI | How |
|---|---|---|
| `site_settings.ai_provider`, `ai_base_url`, `ai_model`, `ai_enabled`, `ai_input_cost_per_mtok`, `ai_output_cost_per_mtok` | the `shared` provider and its default model | **environment**, with the same names upper-cased (`AI_PROVIDER`, …). The import prints the values and records a hold |
| `site_settings.ai_api_key` | `shared.secret_ref = env:AI_API_KEY` | **environment only**. The import records a `secret` hold and never prints the value |
| `site_settings.ai_model_chat` / `_vision` / `_director` / `_summary` | a new version of route `live.<role>` with that model | import (`created_by = import`; the boot seed never overwrites it) |
| `site_settings.ai_pricing_json` | `models` rows for provider `shared` with cost metadata | import. The `default` entry and prefix matching stay in `AI_PRICING_JSON` (held) |
| `site_settings.ai_max_cost_usd_per_day` | quota `global` / `day` / `max_cost_usd` | import (also `AI_MAX_COST_USD_PER_DAY` at boot) |
| `site_settings.ai_viewers_global_cap_usd_per_day` | quota `global` / `day` / `max_cost_usd`, `workflow_prefix live.viewers.` | import |
| `ai_usage` | `usage_daily` (requester `service:live`, attribution `live:user:<owner>`, workflow from the Live kind, provider `shared` or `live-byo`) and today's quota windows | import, one ledger row per usage id |
| `channel_ai_config.daily_budget_cents` (shared key) | quota `attribution` `live:user:<id>` / `day` / `max_cost_usd`, prefix `live.viewers.` | import |
| `channel_ai_config` BYO key / base URL | — | **held** (`byo_provider`): per-actor provider secrets are not stored here yet, so BYO calls keep going straight to the streamer's provider from Live |
| `translations` | — | **held** (`unrepresentable`): rows are keyed by `sha1(from\|to\|text)` without the source text, so they cannot become input-hashed cache entries. Live keeps them as its read-through cache; new translations are also cached here (per service) |
| `ai_timeline_cache` | — | **held** (`stays_in_live`): an assembled Live read model with no model output |
| `ai_chatbot_configs` | — | **held** (`superseded`): Live already migrated it into `channel_ai_config` |
| Live's prompts | versioned templates and workflows (see below) | code (`server/workflows/*.js`), seeded at boot |

### Records that stay in Live

`stream_memories`, `stream_timeline_events`, `streamer_overviews`, `stream_recaps`, `vod_ai_state`,
`clip_ai_state`, `chat_ai_summaries`, `channel_ai_bots`, `ai_viewer_threads`, `ai_viewer_log`,
`channel_ai_config.settings_json`, and the `ai_*_enabled` feature switches. They are Live's product
state: AI produces a draft/evidence package (a run), and Live decides what to store and show. Each
run is attributable to a workflow, its version, a model and a run id — never to a person — and Live
can keep that `run_id` next to what it stored.

## Live features and their workflows

Structured workflows own their prompt here (templates copied verbatim from Live):

| Live code | Workflow |
|---|---|
| `i18n/translate.js` translate / translateChatMessage / translateLines | `live.translate` (cache per service) |
| `ai-analysis.analyzeImagePaste` (paste_image, moment_frame) | `live.paste.describe_image` |
| `ai-analysis.analyzeTextPaste` | `live.paste.summarize_text` |
| `ai-analysis.analyzeStreamFrame` (stream memories, live pastes) | `live.stream.describe_frame` |
| `ai-analysis.summarizeStreamMemories` (overview + inferred category) | `live.stream.summarize` |
| `ai-analysis.generateStreamerOverview` | `live.streamer.overview` |
| `media-analysis.analyzeMedia` (VOD/clip overview) | `live.media.overview` |
| `recap/recap.js` aiWriteup | `live.stream.recap` |
| `internal/routes.js` `/internal/ai/site-copy` (Network footer) | `network.site_copy` |
| `transcribe.js` (whisper.cpp) | `live.media.transcribe` — available here; Live keeps transcribing locally for now (see below) |

Passthrough workflows carry a prompt Live still renders itself (the run keeps only its hash):

| Live `llm.complete()` kind | Workflow |
|---|---|
| `ai_viewers_director` / `ai_viewers_reply` / `ai_viewers` / `ai_viewers_fold` | `live.viewers.plan` / `.reply` / `.line` / `.fold` |
| `chat_global`, `chat_user`, `chat_relay`, `chat_anon`, `combined_overview`, `session_titles` | `live.chat.insight` |
| `moment_vod_rank`, `moment_pick` | `live.moments.rank`, `live.moments.pick` |
| `auto_clip_confirm` | `live.clips.confirm` |
| `hero_slogans`, `easter_egg`, `home_star` | `live.hero.slogans`, `live.easter_egg`, `live.home.star` |
| `arena_persona`, `arena_quotes`, `arena_scene`, `arena_beef_judge`/`arena_mic_judge`, `arena_headline` | `live.arena.*` |
| `status_check` | `live.status_check` |
| anything else | `live.complete` |

Moving a passthrough feature's prompt here later is a normal change: add a template and a
structured workflow, point Live's call at it, and the passthrough key stays for old runs.

## Cutover

1. **Deploy OpenVibe.AI** (`/opt/openvibe.ai`, unit `deploy/systemd/openvibe-ai.service`, env
   `/etc/openvibe/ai.env` from `.env.example`). Leave `AI_STUB_FALLBACK` off in production.
2. **Dry-run the import** against a snapshot of Live's database:
   ```bash
   node scripts/import-from-live.js --live-db /path/live-snapshot.db --dry-run
   ```
   Copy the `environment` lines it prints into `/etc/openvibe/ai.env` (set `AI_API_KEY` from Live's
   `ai_api_key` yourself — the script never prints it), restart, check `GET /api/ready`.
3. **Import**: the same command without `--dry-run`. Re-running is safe: the ledger skips what is
   already imported and applies changed settings once. Review `import_holds`.
4. **Grant Live a token**: Network client `live` needs `ai.run.create` (and `ai.run.read`) for
   audience `openvibe.ai`, namespaces `live.*` and `network.site_copy` (the latter only while Live still
   answers `/internal/ai/site-copy`). Namespaces fail closed; a grant without namespaces is covered
   by the default `AI_NS_FALLBACK` (`live=live.*|network.site_copy`).
5. **Apply `docs/live-patch.diff`** to Live (`git apply`), deploy, then set in `/etc/openvibe/live.env`:
   ```
   AI_SERVICE=remote
   OV_AI_INTERNAL_URL=http://127.0.0.1:4700
   ```
   and restart Live. Live keeps its `ai_enabled` switch and local daily cap, and keeps writing
   `ai_usage` rows (provider `openvibe-ai`) so per-streamer AI-viewer budgets and the admin cost
   page work unchanged.
6. **Verify**: `GET /api/v1/runs?workflow=live.translate` (with an `ai.usage.read` token) shows runs
   from `service:live`; Live's logs show no `[AI service]` warnings.
7. **Network**: give Network's client `ai.run.create` with namespace `network.*` and call
   `POST /api/v1/runs {"workflow":"network.site_copy", ...}` directly instead of Live's
   `/internal/ai/site-copy` (same input and output shape). Until then Live's endpoint forwards to
   the same workflow.

**Rollback**: unset `AI_SERVICE` in `live.env` and restart Live. Nothing in Live's database changed
shape; the shared key must still be in Live's settings for that path (keep it until the cutover
has held for a while).

## Not moved yet

- **Streamer BYO providers** stay in Live (`llm.js` provider override): they need per-actor
  provider records with secret references here first.
- **Local transcription** (live timeline segments, VOD/clip transcripts, stream memories audio)
  still runs whisper.cpp inside Live: live segments are local files with a latency budget, and the
  VOD path resumes per 5-minute window. `live.media.transcribe` is ready here (fetches from
  allow-listed OpenVibe hosts only) for when VOD transcription moves.
- **YAMNet sound events** (`audio-events.js`) and frame capture (`stream-vision.js`) are Live
  capture code, not model calls; only the vision call moved.
- **Run events** (`ai.run.queued|succeeded|failed|cached`) are not published to OpenVibe.Events yet.
