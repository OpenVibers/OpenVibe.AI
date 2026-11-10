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

For Fable: part 1 adds storage only. The next read surface will expose the daily
series, sample counts and null states for charts without needing raw receipts.
