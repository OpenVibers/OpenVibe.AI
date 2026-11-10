# Measured Exchange metrics

`exchange_metrics_daily` preserves complete UTC days from AI run receipts. The due row
in `exchange_metrics_job` survives restarts; a transaction locks it before a worker
backfills retained receipts and refreshes the last two completed dates. The worker
wakes each minute, first five seconds after boot, and normally runs once a day after
00:05 UTC. It is disabled in tests and drills, and stops before the database closes.

Each row is a model, public provider, fixed task kind and day with at least twenty
real completed runs. Synthetic, cached, private/BYOK and hidden providers are excluded.
Uncensored offers are excluded from public analytics. No person, site, prompt, answer,
private template/workflow name or receipt identifier is stored in the rollup.

Success rate counts succeeded / (succeeded + failed) receipts attributed to the
answering or final attempted offer. It is run health, not individual fallback attempt
health. Latency percentiles use successful receipts' total latency. First token uses
recorded streamed TTFT; decode throughput is output tokens / (latency - TTFT) seconds.
Each timing metric needs twenty valid observations of its own. Unknown is null.
Mean cost per run includes failures with recorded cost; cost per thousand output
tokens includes input cost. Samples, units and dates travel with every future read.

Backfill covers complete dates still inside receipt retention (normally 29 days).
Longer history accumulates going forward; it is never fabricated from expired runs.
Models use the catalogue's canonical identity and longest matching registered revision.

Public reads under `/api/v1/exchange/metrics` are cached sixty seconds and allow
cross-origin GETs without credentials. Model slugs in path segments are URI-encoded.

| Read | Parameters | Data |
| --- | --- | --- |
| `/models/:model` | `days=30|90`, optional `kind` | Daily series per provider and task kind |
| `/compare` | `models=a,b` (up to six), optional `kind`, `measures`, `day` | Exact daily metrics, grouped by model/provider/kind |
| `/leaderboard` | `kind`, `measure`, optional `day` | Ordered model/provider rows for that completed UTC day |
| `/prices/:model` | `days=30|90` | Daily catalogue prices per offer, source and capture time |
| `/providers/:provider` | none | Seven days of hourly run success rate and successful median latency |
| `/status` | none | Published date coverage and job completion |

Comparisons and leaderboards default to the latest published day, shared by every
row. They never average daily medians or mix dates without saying so. These are
observational workloads, not controlled benchmark runs. The response names the
measure units, sample minimum, methodology, providers, task kinds and dates. An
empty series or cell is unavailable evidence, never a zero score.

The second due job records hourly provider health and today's listed prices. It
backfills health from seven days of receipts, refreshes two prior hours and keeps
only seven days. Prices are immutable daily observations and accumulate from the
deployment date; no previous price is invented. A listed price is not a measured
number and needs no run samples. Adult models are absent from these public reads.

For Fable: chart inputs are `series[].day`, provider/task kind, `runs`, the selected
measure and `samples`; price charts use `price_in/out/cached` in USD per million
tokens; health charts use UTC `hour`, `success_rate`, `latency_p50_ms` and samples.
