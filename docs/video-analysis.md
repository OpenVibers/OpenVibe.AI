# Video analysis

The owner's 2026-11-13 feature (plan 2026-11-13 Z.9 step 4): the AI reads a video. One durable run measures the
file with ffprobe, takes its keyframes, hears it with the speech route, reads every frame with the vision route, and
writes an `ai.video-analysis@1` document with its chapters, summary, named people, objects and places, tags, answer
and receipt. OpenVibe.Video shows it on a video's page; a composer can "ask about this video"; OpenVibe.Design's deep
dive reads screen recordings through it.

## The run

Workflow `video.analyze` (`server/workflows/video.js`), one `video_analyze` step that runs
`server/video-analysis/`. The steps, live on `GET /api/v1/video-analyses/:id/state`:

| step | what happens |
| --- | --- |
| `probe` | ffprobe: the duration, the size, the codecs, the frame rate, the rotation, the audio stream |
| `keyframes` | ffmpeg: the scene cuts (a threshold over the picture changes) plus one frame every 30 s, at most 12 (quick), 32 (standard) or 96 (deep); each frame is a small JPEG, kept as a private Media object |
| `transcript` | the speech route (the router picks Deepgram, Parakeet or whisper.cpp): the audio is cut to 16 kHz mono and read in windows of ten minutes, so a long video is read in chunks and one failed window costs that window only |
| `describe` | the vision route reads every keyframe: what is shown in it and the text on screen |
| `analyse` | one model writes the chapters, the summary, the people, objects and places that were named, the tags and the answer to the question that was asked |
| `explicit` | the house rule on explicit content (the same one Live keeps for clips): `fine`, `sex_acts` or `minor_sexual` |
| `report` | `ai.video-analysis@1` assembled from what was actually measured, heard and seen, validated and stored with the run |

A step that fails leaves a named gap; nothing is made up. A run that cannot start at all says why in the
run's error: `video_analysis.tool_unavailable` (this service has no ffprobe), `media.unreadable` (the file is not
a video this tool can read), `media.not_readable` (Media will not give it to this requester) or `input.invalid`. A video without sound has no transcript, and the run says
so (`receipt.steps[transcript].status` is `skipped`, and the gap names it). A name the video does not show or say is
dropped, and the gap says which one.

## The video

One video, and only one OpenVibe.Media holds:

- `media_id`: a Media object. AI asks Media for a signed download URL as the run's owner; Media answers 404 for an
  object that owner may not read, so **Media decides** who may read what.
- `attachment_id`: a composer attachment (Media's own attachments API). Its id is unguessable and Media serves the
  bytes under it; Media answers 404 when there is no such attachment.
- `url`: a Media URL. The origin must be Media's own (the public one, or the internal one this service is configured
  with). Any other URL is refused with `422 input.invalid` before a run is made: this workflow never fetches a video
  from the open internet.

## API

```
GET  /api/v1/video-analyses/pricing       public: key, frames, price per minute and the floor per depth
POST /api/v1/video-analyses               ai.run.create: { media_id | attachment_id | url, depth, ask?, language?,
                                               duration_s?, on_behalf_of? } -> 202
GET  /api/v1/video-analyses               ai.run.read: the caller's analyses, newest first
GET  /api/v1/video-analyses/:id           the state and, at the end, the ai.video-analysis@1 report
GET  /api/v1/video-analyses/:id/state     just progress, steps, frames, gaps and error
GET  /api/v1/video-analyses/:id/frames/:frame   one keyframe, as the owner (private, no-store)
```

The price is computed from the depth and the length the caller names (`duration_s`, never a price in the body) and
passed to `runs.create` as the run's estimate; with the tier budgets on it is held on `ai-usd`/`ai-token`
(`tiers.admit`). The real numbers are on the receipt: the run's `requests` on `GET /api/v1/runs/:id`, and the
report's `receipt.models`.

## The price

`GET /api/v1/video-analyses/pricing` is the list Exchange shows. The price is per minute of video, with a floor per
depth:

| depth | frames | per minute | the floor |
| --- | --- | --- | --- |
| quick | 12 | $0.02 | $0.05 |
| standard | 32 | $0.06 | $0.20 |
| deep | 96 | $0.20 | $0.60 |

(`AI_VIDEO_ANALYSIS_PRICE_*`.) A caller that knows the length of the video sends `duration_s` and the price is exact;
one that does not pays the floor until the run has measured the video.

## The output

`ai.video-analysis@1` (Contracts 0.427.0, `contracts/ai/video-analysis.v1.json`):

```json
{
  "media_id": "med_01JAB2C3D4E5F6G7H8J9K0MNPQ",
  "duration_s": 94.5,
  "probe": { "duration_s": 94.5, "size_bytes": 41943040,
    "video": { "codec": "h264", "width": 1920, "height": 1080, "fps": 29.97, "rotation": 0 },
    "audio": { "codec": "aac", "sample_rate": 48000, "channels": 2 } },
  "keyframes": [ { "t": 0, "url": "/api/v1/video-analyses/run_.../frames/0",
    "caption": "A desk with a laptop showing a README file.", "text": "README.md" } ],
  "transcript": { "lang": "en", "words": [ { "t0": 3.2, "t1": 3.8, "w": "we" } ], "text": "we open the readme" },
  "chapters": [ { "start": 0, "end": 48, "title": "The README" } ],
  "summary": "A screen recording of a developer opening a README file and running the tests.",
  "entities": [ { "name": "README.md", "kind": "object", "evidence": [ { "t": 0, "from": "frame" } ] } ],
  "tags": [ "screen recording", "developer" ],
  "answer": "It shows a README file being edited and the tests passing.",
  "explicit": { "category": "fine", "reason": "the text describes neither sex acts nor a child with nudity" },
  "receipt": { "steps": [ { "key": "probe", "status": "done", "detail": "94.5 s, 1920x1080 h264", "cost_usd": 0, "ms": 412 } ],
    "models": [ { "step": "analyse", "provider": "openai", "model": "gpt-4o-mini", "tokens_in": 2210, "tokens_out": 402, "cost_usd": 0.0021 } ],
    "cost_usd": 0.0033 }
}
```

`answer` is only there when the caller asked a question. `entities[].evidence[].from` is `frame` (seen) or `speech`
(heard), and the time is the one the tool gave.

## What OpenVibe.Video and Design's deep dive call

Both call the same API, with the video they already hold:

```
POST https://ai.openvibe.services/api/v1/video-analyses
Authorization: Bearer <a token with ai.run.create>
{ "media_id": "med_...", "depth": "standard", "ask": "What is in this video?", "duration_s": 94 }
-> 202 { "video_analysis": { "id": "run_...", "status": "queued", ... }, "price_usd": 0.12, "held_usd": 0.12 }

GET https://ai.openvibe.services/api/v1/video-analyses/run_.../state
-> { "video_analysis": { "status": "running", "step": "describe", "progress": 0.58, "steps": [...], "frames": [...], "gaps": [...] } }

GET https://ai.openvibe.services/api/v1/video-analyses/run_...
-> { "video_analysis": { "status": "succeeded", "report": { ...ai.video-analysis@1... } } }
```

The token needs `ai.run.create` to start one and `ai.run.read` to read it; only the requester (or the person the run
acts for) may read the report, so a page for a video the person may read asks AI with that person as `on_behalf_of`.
The frames are served from `GET /api/v1/video-analyses/:id/frames/:frame` to the same requester.

Event: `ai.video_analysis.updated@1` (Contracts 0.427.0), one per step transition and one at the end. Subject
`run:<id>`, internal, low priority (`important` on failure). Payload: ids, status, step, progress, the seven step
statuses, depth, requester, on_behalf_of, the URL, an error and the time. Never the transcript, a frame or a prompt.
`server/events.js` `videoAnalysisUpdated`.

## The tools

`ffprobe` and `ffmpeg` on this host (`FFPROBE_BIN`, `FFMPEG_BIN`), through `server/video-analysis/ffmpeg.js`; the
speech route (`AI_VIDEO_ANALYSIS_STT_ROUTE`, `live.stt` by default), the vision route
(`AI_VIDEO_ANALYSIS_DESCRIBE_ROUTE`, `background.vision`) and the writing route
(`AI_VIDEO_ANALYSIS_ANALYSE_ROUTE`, `background.json`). The work directory is `AI_VIDEO_ANALYSIS_DIR`; the video is
copied there before the tools see it, under a byte cap, and the room on the disk is checked first.
