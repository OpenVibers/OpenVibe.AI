# Memory import (M3): ChatGPT, Claude and Gemini exports

The Memory page in Codes (`/memory?tab=import`) walks a person through bringing what their cloud assistants
already remember into OpenVibe Memory. The parsing and the redaction live in OpenVibe.AI, beside the store M2
reads; Codes only forwards the person's token and the bytes, then renders what comes back.

## The flow

1. **Preview** — `POST /api/v1/memory/import/preview` (person token; a service token is refused).
   The body is a `.zip` export, one `multipart/form-data` form from the page, or JSON `{ provider, text }` for a
   pasted answer. AI parses it, redacts every candidate with `openvibe-sdk/redact`, and returns the candidates.
   Nothing is written to `memory_items`. The candidates (already redacted) are sealed into one `memory_imports`
   row with `AI_MEMORY_KEY` (AAD `memory-import|<owner>|<id>`) and expire after two hours.
2. **Keep** — `POST /api/v1/memory/import/:id/commit` with `{ keep: ["k1", "k3"] }`.
   Only those keys go through the store's normal batch import (which redacts again and dedupes), and the draft is
   deleted. Keys that are not ticked are deleted with it. `DELETE /api/v1/memory/import/:id` throws the draft away.
3. **Walkthroughs** — `GET /api/v1/memory/import/providers` returns the three cards (where to request the export,
   what arrives, how long) and the extraction prompt. It contains no note.

## What each parser reads

| Provider | File | What it gives |
|---|---|---|
| ChatGPT | `conversations.json` | the current branch of each conversation (`mapping`, `current_node`); only the person's sentences that announce a durable memory become candidates |
| Claude | `memories.json` | every saved memory, confidence 0.9 (no marker needed) |
| Claude | `conversations.json` | `chat_messages[]`, `sender: "human"`, content blocks |
| Gemini | `Takeout/My Activity/Gemini Apps/My Activity.json` | the activity record's prompt title (`Said …`, `Prompted …`) |
| Gemini | `Gemini/conversations/*.json` | `messages[]` with `role: "user"` |
| Any | pasted answer | bullets, with an optional `[preference]` / `[fact]` / `[project rule]` / `[procedure]` / `[decision]` / `[lesson]` label |

An export with no candidate is still a successful preview: it says so and points at the extraction prompt, which
is the method Claude's own memory import uses. Every candidate keeps its source and date, so the note can be
removed with the rest of that source later.

## Limits and safety

- at most 25 MB uploaded, 5,000 zip entries, 60 MB of JSON, 200 JSON entries, 200 candidates per preview;
- only stored (0) and deflate (8) entries, basic ZIP64; encrypted entries and other methods are refused;
- the archive is parsed in memory and never extracted to disk;
- no secret is returned in a preview: redaction runs before the candidate leaves the module, and again on commit;
- no route logs a note's text; a preview is sealed and owned, and belongs to the person's account deletion.

## Tests

`test/memory-import.test.js` builds its own exports with `test/fixtures/zip.js` (no real exports in the repo):
redaction before the preview, no note stored by a preview, the sealed draft, the per-item commit, Claude
`memories.json`, a Gemini Takeout path, a pasted answer, service-token refusal, owner isolation and expiry.
