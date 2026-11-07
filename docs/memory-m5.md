# Memory M5: services, sharing and the portable file

This is the fifth stage of the Memory plan (`../../OpenVibe_Memory_Plan_2026-10-30.md`). M1–M4 are the Node readers,
the store, the cloud imports, the write-back and the agent API. M5 adds three things to the same store:

- the memory-service adapters (mem0, Letta, Zep) with the person's own key;
- team sharing of a memory store, through `openvibe-sdk/share`;
- the one portable JSON file, with an export and an import that round-trip.

Nothing here changes how an item is sealed: `AI_MEMORY_KEY`, AES-256-GCM, the AAD `memory|<owner>|<id>|<scope>`, and
the same redaction on both ends.

## The memory services

| id | What it reads | Request |
|---|---|---|
| `mem0` | the user's memories on the mem0 Platform | `GET <base>/v1/memories/?page=&page_size=`, `Authorization: Token <key>` |
| `letta` | each agent's core-memory blocks and archival passages | `GET <base>/v1/agents/`, `/v1/agents/{id}/core-memory/blocks`, `/v1/agents/{id}/archival-memory`, `Authorization: Bearer <key>` |
| `zep` | each user's session memory | `GET <base>/users`, `/users/{id}/sessions`, `/users/{id}/sessions/{id}/memory`, `Authorization: Api-Key <key>`; the default base is `https://api.getzep.com/api/v2` |

The endpoints are documented by the services: [mem0](https://docs.mem0.ai/api-reference/memory/get-memories),
[Letta](https://docs.letta.com/api-reference/agents) and [Zep](https://help.getzep.com/api-reference). A self-hosted
Letta or Zep names its own `base_url`; production requires https, and only a test may use a loopback `http://`
address.

### The key

`PUT /api/v1/memory/services/:provider { key, base_url?, account? }` stores the key in
`memory_service_connections.key_enc`, sealed exactly like a BYO provider key (`server/credentials.js`):
AES-256-GCM with `AI_CREDENTIALS_KEY`, the envelope `v1:<iv>:<tag>:<body>`, the AAD
`memory-service|<subject>|<provider>`, so a row moved to another person or provider does not decrypt.

- The key is never returned. `GET /api/v1/memory/services` answers the last four characters (`hint`), the service's
  health, the last sync time and its count.
- The key is never put in a URL, a log line, an error, a span or an event. An adapter's refusal is a status and a
  fixed sentence; the tests assert that the key does not appear in the answer, the logs or the ciphertext.
- `PUT` tests the key by reading one page, and keeps the connection with `status: failing` and a short `last_error`
  when the service refuses it, so the person can fix the key or the address without losing the form.
- `DELETE` removes the row. The account deletion removes it too (`server/account-data.js`).

### Sync

`POST /api/v1/memory/services/:provider/sync` opens the key for one call, reads at most 1,000 records, drops an item
that is only a secret, and hands the rest to the store's own batch. The batch redacts each item again, seals it under
the person, and dedupes by its text MAC. A sync never overwrites an item: a note that says the same thing as one
already there is merged into that item, with the service added to its sources. The answer is counts only (`found`,
`imported`, `deduped`, `skipped`), never text.

## Team sharing

`server/memory/sharing.js` wires `openvibe-sdk/share` with one resource per person: service `ai`, kind
`memory-store`, id the owner's `usr_…`. The store is `private` until its owner changes it; the four audiences are the
library's (`public`, `link`, `people`, `private`), and a team uses `people` with named members. The share settings and
the notes are separate: `GET /api/v1/memory/stores/:owner` calls `canView` first and returns only active notes; a
person who is not a member gets `memory.not_found` and never a count or a title.

- The uniform routes live at `/api/v1/memory-store/:id/share`; the owner's first GET registers the private row.
- `GET /api/v1/memory/shared` lists the stores shared with the person, with ids and access only.
- A read by a member is not an agent read and is not written to `memory_reads`; the read log is for agents.
- Network supplies the exact-name lookup and the notification push; Events receives the five `share.*` envelopes.
  When the deployment has no Network client secret or Events URL, the sharing routes answer 503
  `memory.sharing_unavailable` and the rest of the store keeps working.
- `openvibe-sdk/share` refuses a locked item that would be public. Memory does not use a content lock in M5.

Codes renders the sheet and the gate from openvibe-shared `4.123.0`'s markup (`[data-ov-share-sheet]`,
`[data-ov-share-gate]`); there is no inline script. Its `/api/v1/memory-store/...` routes are a thin proxy that
forwards the person's token, the method, the body and `If-Match` to AI, and keeps AI's `ETag` and
`Cache-Control: private, no-store`.

## The one portable file

`ai.memory-export@1` (Contracts) is the only file format:

```json
{
  "format": "openvibe.memory-export@1",
  "version": 1,
  "exported_at": "2026-11-07T09:30:00.000Z",
  "items": [
    {
      "text": "Prefers short answers.",
      "kind": "preference",
      "scope": "user",
      "source": "claude-code",
      "source_ref": { "path": ".claude/CLAUDE.md", "heading": "Style" },
      "status": "active",
      "confidence": 1,
      "seen_at": "2026-11-01T10:00:00.000Z",
      "created_at": "2026-10-30T10:00:00.000Z"
    }
  ]
}
```

- `GET /api/v1/memory/export[?scope=]` writes it, decrypted for the person's own token, at most 10,000 items.
- `POST /api/v1/memory/import` reads the same document. It reads `format`, `version` and `items`; `exported_at` is
  informational. Each item is redacted again, a secret-only item is skipped, and a `conflict` item is imported as a
  suggestion because its pair did not travel. The store's own dedupe then merges a text that is already there.
- There is deliberately no `id`, `owner`, `merged_into`, `conflict_with` or profile. A file can be imported into
  another account without carrying anyone's identity, and a profile is derived from the notes and rebuilt.
- The round trip is proved in `test/memory-m5.test.js`: export A's store, import it as B, and compare text, kind,
  scope and source; importing the same file again changes nothing.
- The Node writes and reads the same file (`openvibe-node memory export|import`); Codes offers a download and an
  import form. The format is the contract, not either client.

## Tests

- `test/memory-m5.test.js`: the three adapters against local stubs of their HTTP APIs (auth headers, pagination and
  mapping), the sealed key (no plaintext in the row, the answers or the logs), the portable round trip, and a shared
  store that only its members can read, with `Cache-Control: no-store` on every answer.
- `test/memory.test.js` and `test/account-data.test.js`: the M1–M4 rules still hold, the account export is unchanged
  (a service key is never exported), and the share tables are erased with the person.
