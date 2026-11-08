# Abuse prevention for the free tier (plan E5)

OpenVibe.AI's free tier is the owner's DeepSeek key, local models and community volunteers. The allowance is
small, so mass sign-ups must not farm it. This is what stands in the way, and exactly what it stores.

Code: `server/abuse/`. Migration: `0034_abuse.sql`. Tests: `test/abuse-trust.test.js`, `test/abuse-pow.test.js`,
`test/abuse.test.js`, `test/abuse-runs.test.js`; Network's signals: `test/identity-trust.test.js`.

## 1. The allowance grows with trust

`curl GET /internal/identity/resolve?subject_id=…&trust=1` on Network (server token,
`identity.subject.resolve`) adds a `trust` object to the usual projection: account age, whether a Locker passkey
exists, **how many** accounts are linked, whether the account is 30 days old and active, and
`verified`/`verified_by`. No email, no linked site ids, no last-seen timestamp leaves Network.

| Tier | Condition | Allowance |
|---|---|---|
| new | under 24 h, unverified, or Network cannot vouch for it | ¼ of `AI_FREE_DAILY_TOKENS` |
| established | over 7 days, unverified | ½ |
| verified | a passkey, a linked account, or 30 days with activity | full |
| contributor | verified, with community kudos | full + up to one extra full (kudos tokens) |

A hosting/data-centre ASN is always the new tier, whatever the account says. The counter is per UTC day, per
account, or per device when the device is shared (below). At the limit the run is refused **before** a provider is
touched: `402 ai.allowance_spent` with the reset time and how many tokens were used. This is admission, separate
from the provider `free_allowance` in `server/free-allowance.js` (which is pricing only).

`AI_FREE_DAILY_TOKENS` (default 20 000) is the full tier. Zero turns the free allowance off.

## 2. Network signals: ASN, never the address

A client address reaches AI from the loopback proxy, or in `x-ov-client-ip` from a first-party service token
(`AI_FIRST_PARTY_SERVICES`, default `exchange`); any other caller's header is ignored. AI maps it with a local
monthly table — `scripts/update-ip2asn.js` downloads iptoasn.com's free TSV files to `data/ip2asn/`, never a paid
API — and keeps only:

* the ASN number and whether its organisation is a hosting/data-centre one, and
* an HMAC-SHA256 of the address's `/24` (IPv4) or `/48` (IPv6), with `AI_ABUSE_SALT`.

That row expires after **24 hours**. `AI_HOSTING_ASNS` adds ASNs the organisation-name match misses. A hosting
request gets the new tier and `AI_ABUSE_HOSTING_RATE_PER_MIN` (default 20/min) instead of
`AI_ABUSE_RATE_PER_MIN` (default 60/min).

## 3. Devices

The API sets `ovai_device` — a signed, `HttpOnly`, `SameSite=Lax`, `Secure` cookie, `Domain` from
`AI_DEVICE_COOKIE_DOMAIN` (set it to `.openvibe.exchange` so the site and `api.openvibe.exchange` share it). The
Exchange may instead forward the cookie's signed value in `x-ov-device-id` from its own server; the signature is
what matters, so a raw id is refused. A first-party service forwards the client address in `x-ov-client-ip` only
when it holds a first-party token.

Accounts are counted per device. At **more than three** accounts, they share one allowance: the counter key is the
device, and its cap is the lowest tier among the accounts on it. A device row is pruned 180 days after it was last
seen.

## 4. Proof of work for the anonymous Try it

No account, no Balance: `POST /api/v1/exchange/tryit/challenge` returns a random challenge, `AI_POW_BITS` (default
18, about a second on a phone; clamped to 8–28) and a five-minute expiry. The client sends
`x-ov-pow: <challenge>:<nonce>` where `sha256("<challenge>:<nonce>")` has that many leading zero bits. AI stores
only `sha256(challenge)` and accepts one solution once. `AI_POW_REQUIRED` is on in production and off in tests.

## 5. Anomaly throttling

Every finished free run adds its tokens (input + output) to three per-minute buckets: its ASN, its device, and an
HMAC of the run's input hash (a repeated scripted request). Before a run, the current minute is compared with the
last week's per-minute baseline for that bucket. Above `AI_ABUSE_VELOCITY_MIN_TOKENS_PER_MIN` (default 10 000) or
10× the baseline, the run is refused with `429 ai.abuse_throttled` and a plain retry-in-a-minute message, and an
`abuse.throttled` row goes to the operator audit log. The rate limit above records `abuse.rate_limited` the same
way.

Operators see both on [Exchange's abuse page](https://openvibe.exchange/console/abuse), and the gauge `ai_abuse_throttles{reason}` (events in the last 15 minutes)
is on `/metrics`. OpenVibe.Host's `deploy/prometheus/openvibe-rules.yml` raises `OpenVibeAiAbuseThrottling`
(severity ticket) above 20 in 15 minutes.

## Privacy: what is kept, for how long

| Data | Where | Kept |
|---|---|---|
| Raw client IP | request memory only | not written; gone when the request ends |
| ASN + HMAC of `/24` or `/48` | `abuse_network_seen` | 24 hours after last seen |
| Raw device id | the person's browser cookie | their browser controls it; signed with `AI_ABUSE_SALT` |
| HMAC of the device id | `abuse_devices` | 180 days after last seen |
| Free tokens per account/device | `abuse_daily_usage` | 30 days |
| Free tokens per minute per ASN/device/input bucket | `abuse_velocity` | 8 days (seven-day baseline plus a day) |
| Proof-of-work challenge hash | `abuse_pow` | one day after expiry, then pruned |
| Network trust facts | AI process memory | 5 minutes (a miss: 1 minute) |
| Throttle/rate events | `audit_log` (`target_type='abuse'`) | with the audit log; ASN, tier and counts only, never an address, device id or prompt |

The salt is `AI_ABUSE_SALT`; without it a per-boot random key is used, so hashes cannot be linked across boots and
device cookies are re-issued after a restart. Set it in production. Nothing in these tables can be turned back into
an address, a device or a prompt without the salt, and the salt never leaves the service.

The IP-to-ASN files are public data (`iptoasn.com`), not a person's data. The table is replaced monthly by the
job, and the service loads it lazily.
