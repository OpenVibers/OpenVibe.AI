# Privacy notes (service data)

This is the engineering note for what OpenVibe.AI keeps. The public legal text is served by
`openvibe-shared/legal` (`/privacy`); the facts here must match the code, and a change to one is a change to both.

## A run

A run keeps the prompt (unless the workflow is passthrough or `history: false`), the answer, the model and why it
was chosen, tokens, cost, payer and the receipt. Retention follows `AI_RUN_RETENTION_DAYS`; the receipt goes with
the run. A person's own provider key is encrypted and never logged. See `README.md` ("Runs", "Presets, receipts,
BYOK and the privacy label").

## Abuse prevention (plan E5)

The free tier's controls are described in full in [`abuse-prevention.md`](abuse-prevention.md#privacy-what-is-kept-for-how-long):

- **No raw client IP is stored.** AI uses the address only in memory to look up an ASN in a local table, then
  keeps the ASN and an HMAC-SHA256 of the `/24` (IPv4) or `/48` (IPv6) for 24 hours.
- **No raw device id is stored.** The browser holds a signed `HttpOnly` cookie; AI stores only an HMAC of it, for
  180 days after the device was last seen.
- **The anonymous Try it's proof of work** is stored as `sha256(challenge)`, accepted once, and pruned a day after
  it expires.
- **Counters**: free tokens per account/device for 30 days; free tokens per minute per ASN, device and input
  bucket for 8 days. No prompt is stored by the abuse code; the input bucket is an HMAC of the run's existing
  input hash.
- **Network's trust signals** (account age, a passkey, a link count, 30-day activity) are read through the
  existing identity route and cached in memory for five minutes; AI never sees an email or which sites are linked.
- **Operator events** (`audit_log`, `target_type='abuse'`) carry the reason, ASN, tier and counts, never an
  address, a device id or a prompt, and are visible only in the owner-only operator console
  ([abuse](https://openvibe.exchange/console/abuse), [audit](https://openvibe.exchange/console/audit)) on [OpenVibe.Exchange](https://openvibe.exchange/console).

`AI_ABUSE_SALT` keys every one of those hashes and signs the device cookie. Without it, a per-boot key is used:
the rows cannot be linked across boots and device cookies are re-issued, which is the safe default. Set it in
production.
