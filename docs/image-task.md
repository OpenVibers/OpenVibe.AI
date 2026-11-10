# The shared image task (`image.picture`)

One workflow, two modes, for Blog's and Wiki's editors and writers. Every picture is stored in
OpenVibe.Media and returned by reference (`med_…`); no image bytes are ever inline in a run's output.

```
POST /api/v1/runs?wait=60000
{
  "workflow": "image.picture",
  "task": "image.picture",
  "on_behalf_of": { "type": "user", "id": "usr_…" },
  "input": { "mode": "find", "query": "a workbench", "count": 8, "media_app": "blog" }
}
```

## find

Licensed pictures from Wikimedia Commons and Openverse. Only a picture with a licence that allows
reuse is fetched and stored; the licence, the author and the source page are kept in the Media
object's metadata and in the answer. The owner's engine order (`search_engines`) and guest rule
(`guest_find`) apply; signed-in editors may always find.

```json
{ "mode": "find", "task": "image.picture", "query": "a workbench", "media": [
  { "media_id": "med_…", "url": "https://openvibe.media/o/med_…", "title": "A workbench",
    "license": "CC BY-SA 4.0", "author": "Ada Example", "credit": "Ada Example, CC BY-SA 4.0",
    "source_url": "https://commons.wikimedia.org/wiki/File:…", "provider": "commons", "ai": false }
], "count": 1, "gaps": [] }
```

## make

The owner's configured image model, through the ordinary provider routing. **Off until the owner
picks a model**: the task default `image_model` is `null` at seed and make answers
`503 image.make_unconfigured` until it is set.

A dry run quotes first and calls no provider:

```
"input": { "mode": "make", "prompt": "A goose eating croutons", "n": 2, "dry_run": true }
→ "estimate": { "model": "openai/gpt-image-1", "source": "openvibe", "images": 2,
                "per_image_usd": 0.04, "price_usd": 0.08 }, "media": []
```

A real make reserves the run, calls the model, uploads each picture to Media and settles the run at
`per_image_usd × images` (the model row's `metadata.price_per_image_usd`). A paid, unpriced image
offer is refused (`402 image.price_required`) rather than guessed at. The owner's `daily_cap` limits
made pictures per person per UTC day (`429 image.daily_cap`), and a made picture carries
`"ai": true`, `"model": "…"` and the credit `Made with AI (<model>)` in its caption data.

## Owner defaults (API)

`GET|PUT /api/v1/admin/task-defaults`, owner only. The `image.picture` value adds:

| field | meaning |
|---|---|
| `image_model` | the model make uses; `null` keeps make off |
| `daily_cap` | made pictures per person per UTC day; `null` means the service default (24) |
| `guest_find` | whether a run with no person may use find (seed: `false`) |
| `search_engines` | find's engine order, Commons/Openverse |
| `max_cost_usd` | a per-run ceiling for one make |

## Media tenant

`media_app` names the Media tenant: `blog` or `wiki` (their editors can attach the object by id),
or absent for the AI tenant. Network grants the AI service `media.object.upload` in the `ai`, `blog`
and `wiki` namespaces; Media seeds the `ai` tenant at boot.
