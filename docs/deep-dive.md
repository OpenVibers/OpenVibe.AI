# Deep dive

The owner's 2026-11-11 design-research feature: one durable run that searches every source we have, captures the
best sites at phone and computer sizes, reads them with a vision and a text model, and writes an `ai.deep-dive@1`
report with its evidence and receipt. OpenVibe.Exchange shows it (`/deep-dive`); OpenVibe.Design calls the same API.

## The run

Workflow `design.deep_dive` (`server/workflows/deep-dive.js`), one `deep_dive` step that runs
`server/deep-dive/`. The steps, live on `GET /api/v1/deep-dives/:id/state`:

| step | what happens |
| --- | --- |
| `plan` | a model writes the expert questions and the searches that answer them |
| `search` | MegaSource, AI's web/picture/icon engines, GitHub projects, Design's rules register and component registry |
| `choose` | a model ranks candidate sites with a reason each; a person may add or drop any before Capture |
| `capture` | 390/1280 px, light and dark where supported, full page after a slow scroll, DOM facts; Expert adds menus, hover/focus, a frame strip, axe-core and LCP/CLS/INP |
| `analyse` | a text model reads each site's DOM facts and words; a vision model reads each full-page screenshot |
| `synthesise` | patterns across sites, a comparison, the best version, mistakes, the gap, reference tokens, do/don't, accessibility, speed, and recommendations checked against Design's rules |
| `report` | `ai.deep-dive@1` assembled from what was actually captured, validated, and stored with the run |

Depths: Quick 6 sites (about 3 minutes), Thorough 15, Expert 30. Quick goes straight from Choose to Capture;
Thorough and Expert wait `AI_DEEP_DIVE_CHOOSE_WAIT_SEC` (300) for `POST /api/v1/deep-dives/:id/sites`, or until the
person starts it. Cancelling the run aborts the provider calls and the next capture; nothing new starts after.

## API

```
GET  /api/v1/deep-dives/depths          public: key, sites, minutes and price_usd per depth
POST /api/v1/deep-dives                 ai.run.create: { question, depth, sites?, on_behalf_of? } -> 202
GET  /api/v1/deep-dives                 ai.run.read: the caller's runs, newest first
GET  /api/v1/deep-dives/:id             the state and, at the end, the ai.deep-dive@1 report
GET  /api/v1/deep-dives/:id/state       just progress, steps, candidates, captures, gaps and error
POST /api/v1/deep-dives/:id/sites       { add: [https], drop: [https], start: true } while Choosing
POST /api/v1/deep-dives/:id/cancel      the runs cancel; no later capture or model call starts
GET  /api/v1/deep-dives/:id/shots/:shot one private screenshot/crop, as the owner (private, no-store)
```

The price is computed from the depth (never the body) and passed to `runs.create` as the run's estimate; with the
tier budgets on it is held on `ai-usd`/`ai-token` (`tiers.admit`), and the run stops its own costly steps once its
receipt reaches the price. The real numbers are on the receipt: `POST /api/v1/runs`'s run, `requests` on
`GET /api/v1/runs/:id`, and the report's `receipt.models`. Every capture is a `requests` row (operation `capture`).

OpenVibe.Exchange's long-standing Network grant holds `ai.run.create` on `ai.complete`; `design.deep_dive` is the
workflow its own page starts, so AI's run namespace rule allows the `exchange` service this one workflow by key and
service id (`server/api/runs.js`, `server/api/deep-dives.js`). Every other workflow keeps the namespace rule.

Event: `ai.deep_dive.updated@1` (Contracts 0.412.0), one per step transition and one at the end. Subject
`run:<id>`, internal, low priority (`important` on failure). Payload: ids, status, step, progress, the seven step
statuses, depth, requester, on_behalf_of, the Exchange URL, an error and the time. Never the question's answer, a
capture or a prompt. `server/events.js` `deepDiveUpdated`.

## The capture worker

`server/capture/`, its own systemd unit `openvibe-ai-capture.service` (`MemoryMax=1500M`, loopback 4710). AI calls it
when `AI_CAPTURE_URL` is set (the AI unit sets `http://127.0.0.1:4710`); unset runs the same module in-process
(tests, a small install).

- One browser at a time (a promise chain in the worker) and a queue cap per person (`AI_CAPTURE_QUEUE_PER_OWNER` 3).
- Every request, redirect and WebSocket goes through a loopback CONNECT/HTTP proxy that resolves the name with
  `safeLookup` and refuses a non-public address or any port but 80/443. Photos are taken by Chrome; no request can
  reach 127.0.0.1, a private range or a metadata address.
- robots.txt is read first (our own user agent, else `*`, longest matching rule wins); a disallowed page is skipped
  and the report says so.
- A fresh context per page (no cookies, no stored state, no sign-in, no form submitted), a 45 s page budget, and a
  gap between two pages on the same host (`AI_CAPTURE_HOST_DELAY_MS` 3000).
- Screenshots go to OpenVibe.Media as `asset` objects, `visibility: private`, owner `X-OV-Subject` = the run's owner,
  metadata `source_url` and `captured_at`. The report shows them as attributed commentary through AI's shot route.
- A 7-day cache per URL, viewport, theme and Expert flag (`capture_cache`), so the same page is never photographed
  twice inside a week.
- Off under a drill: `AI_DRILL=1`/`LIVE_DRILL=1` makes `/capture` answer `503 capture.drill`.

## For OpenVibe.Design (stage 2)

Call `POST /api/v1/deep-dives` with a service token (`ai.run.create`, namespace `design.*`), `on_behalf_of` the
person, then follow `/state` or subscribe to `ai.deep_dive.updated@1`; the report at `GET /api/v1/deep-dives/:id` is
the generation brief. Two things stage 2 still needs: a stable **public** read or an owner-approved share for a
report (today the shots are private to the run's owner and the report is readable by the caller), and a way for a
report to propose a rule for the register (the report says `follows`/`would_change`; nothing is added by itself).
