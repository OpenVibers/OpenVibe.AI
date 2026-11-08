## Batches

Many prompts in, the answers later. A batch is half the retail price for the customer, and it runs
where the money works out: on OpenVibe's own capacity and free providers, on a community offer that
asks at most half, on a paid provider inside a price-book off-peak window, or on **a provider's own
batch API** when that provider's real batch price is at most half the retail card. The customer
batch therefore runs on a paid model at any hour, not only in an off-peak window.

The providers whose own batch API this service speaks, with the discount, the window and the limits
read on each provider's own documentation page (a provider whose batch API could not be read is not
listed and is never called):

| provider | adapter | batch price | window | limits |
|---|---|---|---|---|
| `shared` (OpenAI) | OpenAI-compatible | half the list price | 24 h | 50 000 requests, 200 MB, one model per file |
| `qwen` (DashScope) | OpenAI-compatible | half the real-time price | 24 h | 50 000 requests, 500 MB, one model per file |
| `kimi` (Moonshot) | OpenAI-compatible | 60% of the list price | 24 h | 10 000 requests, 100 MB, one model per file |
| `deepinfra` | OpenAI-compatible | 80% of the list price | 24 h | 10 000 requests, 100 MB, one model per file |
| `anthropic` | Message Batches | half the list price | 24 h | 100 000 requests, 256 MB (adapter written, not enabled) |
| `gemini` | Gemini Batch API | half the list price | 24 h | 10 000 requests (adapter written, **not enabled**: the endpoint could not be read on the provider's own page) |

Only the providers whose batch price is at most half the retail card (`shared`, `qwen`) may carry a
**customer** batch: the customer is charged half, so the network's real cost has to fit inside that
half. Kimi and DeepInfra are below half and are therefore not eligible for a customer batch, though
the network's own batches may still use them.

How a native batch runs: an item whose run has `latency_class = 'batch'` waits in the queue
(`batch_queue`), grouped by provider and model. A group goes to the provider when it is full
(`AI_BATCH_NATIVE_MAX_ITEMS`, default 1000) or old (`AI_BATCH_NATIVE_MAX_AGE_MS`, default 5
minutes). One worker polls the batches the provider is working on (the claim is the database's and
expires on its own, so several workers are safe), writes every answer onto its own run (the status,
the output, the tokens and the cost **at the provider's batch price**) and finishes the run on the
ordinary path: the same settle, the same receipt, the same events. A deadline the provider cannot
meet re-routes the item to the ordinary (background or standard) path, and the item says so.

The money: the cost written on a run is what the provider really charged for the tier it really ran
on (its own list price times its own batch discount), computed in nano-USD. The customer is charged
half the retail card through Billing like every other request; this queue is a queue and a status,
never a second ledger.

**The balance is checked when the batch is submitted, and the money is taken when the answer
arrives.** A run whose estimate does not fit the customer's Balance (or the project's budget) is
refused before the provider is given the work, so the network never owes a provider for a run nobody
can pay for; the item carries the reason. The hold itself is taken and settled when the answer comes
back, so a batch that waits hours does not hold the customer's Balance in the meantime.

**A waiting batch run is durable.** It waits in the database, not in the service's memory: the
service is deployed several times a day, and a restart leaves the waiting runs queued (the provider
is still working on them) instead of failing them. The batcher finishes them when the answer is
there, with the ordinary settle, the ordinary receipt and the ordinary events.

**Service batches.** A first-party service principal whose token carries the `ai.batches.create`
grant may open a batch of the network's own: it is billed to the network's account (there is no
Balance session for it) and the run's attribution names the service. The grant is checked locally by
the batch service (`server/batch/service.js`), because the pinned `openvibe-contracts` build does
not know that capability id yet: the Contracts capability entry comes later (BA3). Until then the
route's own guard still asks for `ai.run.create` (or an app's `ai.app.run`) as well.

