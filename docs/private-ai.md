# Private AI (strict privacy)

The plan of 2026-11-06, "Product lines and features", item 2. OpenVibe.Exchange's chat (`/chat`) and the Exchange
API both use one definition of private here; nothing in Exchange re-implements it.

## The label of an answer

`server/exchange/privacy.js` reads the label off the offer that answered, never guesses:

| label | when |
| --- | --- |
| `private` | the provider's own terms say zero retention **and** no training, or the offer is a person's own machine (a Link credential), or it is the host's own deployment (`metadata.local`). |
| `community` | the offer runs on a community machine (a person's hardware, Link's "Offer to the network"): that machine sees the prompt. |
| `anonymized` | everything else, including a provider that declares no policy (`known: false` says so). |

The label is written on the run's `explain.privacy` (every surface that reads a run shows it), on the receipt
(`privacy`), and in the OpenAI- and Anthropic-compatible responses (`x_openvibe.privacy` / `privacy`). The Exchange
catalog offers carry it too (`privacy`), beside the provider's declared `data_policy`.

## Strict privacy: the private preset

`@preset/private` is a built-in (`server/exchange/presets.js`): `data_policy: "private"`, `community: false`. The
router (`server/providers/index.js` → `server/exchange/constraints.js`) removes every offer that does not meet it,
naming the rule for each. When none is left it **refuses**:

- code `policy.privacy_unavailable`, HTTP 503, plain message: "Strict privacy is on: no offer that keeps nothing
  and trains on nothing can answer right now… the router does not fall back to one."
- nothing is called: the refusal is before any provider.

`node_modules` in Exchange is never involved: the Exchange asks for the preset by name (`options.preset: { name:
"private" }` in `/api/v1/runs`), and `server/runs.js` resolves it to the built-in policy. A preset named with a
policy inline still wins, so a caller can add a region or a cap on top.

## The switch on a key

A developer key (an app token) that names no preset uses its owner's preset named `default`, when one exists
(`resolveRequest` in `server/exchange/presets.js`). That is the strict-privacy switch on the Exchange's `/api` page:
it saves `{ data_policy: "private", community: false }` as the person's `default` preset through
`POST /api/v1/presets` with `on_behalf_of`, and on each project they own (Network's `GET /api/v1/projects`, filtered
to `owner.id === subject`), because a project's key acts as the project. A service's own requests are untouched:
only the key's owner's choice. A project owner may also save the preset directly:
`on_behalf_of: { type: "project", id: "prj_…" }`.

## Sealed history

Exchange stores only a `locker.envelope.v1` envelope (`exchange_chat_seals`), people-locked to the person with
`openvibe-shared/ov-locker.js`: the browser seals and opens the conversation, so OpenVibe cannot read it at rest.
The model still receives the turn (and the earlier turns the browser sends with it) while it answers: private at
rest, not from the model, and the page says that plainly. Account export carries the envelope as stored (base64
ciphertext) and deletion removes it with the chat.
