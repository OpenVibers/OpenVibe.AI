# The uncensored policy (the Exchange remake, "Uncensored")

`policy: "uncensored"` asks for an offer that has had its refusals removed. It is accepted on
`POST /v1/chat/completions`, `POST /v1/messages` and `POST /api/v1/runs`, with `on_behalf_of` naming the person
the run is for.

Four things hold it up, and none of them is the caller's word:

1. **The account is 18+.** Network owns the flag. The person confirms it on `/my` → Content, and OpenVibe.AI asks
   Network under `identity.subject.resolve` (`GET /internal/identity/adult?subject_id=usr_…`,
   `server/policy/adult-status.js`). The answer is cached for five minutes and fails closed: if Network cannot be
   reached, the tier is closed. A developer app never gets it, and a run that names no person never gets it.
2. **Only the offers marked uncensored answer.** A standard request never runs an uncensored offer, even when it is
   the cheapest and the healthiest one (`server/providers/index.js`, `policyAllows`). The marks are in the
   catalogue (`server/providers/pool-providers.js`): Refuseless, Abliteration.ai, and the abliterated models
   Featherless lists.
3. **The hard floor holds on the request and on the answer** (`server/policy/floor.js`). It is checked before a
   provider is called, over the answer's own text, and over every chunk of a streamed answer before it goes out.
4. **Every answer carries a label.** The run's `output.label` and `output.policy`, `x_openvibe.label` and
   `x_openvibe.policy` on both public APIs, and the `X-OpenVibe-Content-Policy` header say what produced the answer:
   `Uncensored model — adults only (18+)`.

## The floor

Three lines, on every offer, uncensored or not:

| rule | what it refuses |
|---|---|
| `minors` | sexual content involving minors |
| `non_consensual` | non-consensual sexual content of real people |
| `mass_harm` | help with weapons of mass harm, or with attacks on others |

The lines are decided by the **house's own text classifiers** (`server/policy/classifiers.js`), not by a third set of
words written for this service:

- **Live**'s `server/ai/explicit.js` — a child together with a bare body in the same text (`minorNude`);
- **Vision**'s `server/vision/review.js` — `classifyText`, the three categories `fine`, `sex_acts`, `minor_sexual`.

OpenVibe.AI is its own service and cannot import another service's files, so those rules travel here with the name
of the file they come from and the day they were read. They are the house's rules, not new ones: Live and Vision keep
their own copies until the rules move into one shared package (the follow-up).

Two narrow lists extend them for the words the house has none for: the names of a child abuse (the `minors` rule),
and the two lines about consent and weapons that no house classifier covers. They are deliberately narrow, so
ordinary work is never refused: "how do I kill a stuck process", "cp -r src dst" and "what is our incident response
plan" all pass. A person and a sexual act must be in the same text, and a weapon only counts when the text asks for
one to be made, acquired or used.

### Instructions and content

The narrow lists are unambiguous wherever they appear, so they hold on every text. The house's classifiers read what
a text *shows* — a child with a bare body, a child with sex acts — so they are read on the **content**: the person's
words and the answer. They are not read on the **instructions** (the system prompt), because an instruction that
names a category is not that category: our own templates say "nothing sexual involving minors" and "flag any sexual
content involving minors", and the moderation desk has to be able to say so. The answer is still read: a model that
writes what was asked for is refused there.

So a person's request for such content is refused before a provider is called, and our own desks keep working.

Nudity on its own is art (the owner, 2026-10-31) and is allowed; a child and nudity together is not.

## What the tier is not

- It is not a key anyone can use: a person's own provider key never answers an uncensored request (the tier is
  network supply only), and the tier's answer is never cached with a standard one.
- It is not a promise of anything: the label says what produced the answer, and the floor holds whatever the offer
  says.
- It is not free: an uncensored offer is a paid offer like any other, and the commercial gate
  (`docs/provider-matrix.md`) applies to it like to every other.

## The Network side

Network PR #587 ("Account: the 18+ confirmation for uncensored AI") owns the flag: `users.adult_confirmed_at`
(migration 0040), `GET/PUT/DELETE /api/v1/me/adult`, the confirmation screen on `/my` → Content, and the internal
read. It is a timestamp, never a birth date, and Network never infers an age.
