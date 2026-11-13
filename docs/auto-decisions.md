# Auto's decision step

`openvibe/auto` ranks its candidates as before (the free allowance, the owner's order, measured evidence). Then, when
the route offers a cheaper model and a stronger one, it asks Google's Decisions API one calibrated yes/no question
about the request itself: *would a small, inexpensive model answer this as well as a frontier model?* When the answer's
probability `p` reaches the task kind's threshold, the cheaper model goes first; otherwise the order stays.

Code: `server/routing/auto-decision.js`, called from the pool (`server/providers/index.js`). Migration
`0087_route_decisions.sql`.

## When it does not ask

- the request is not on `openvibe/auto`, or it is private (the alias or the route's objective);
- an exact model id, a pinned offer, a task choice or provider routing named the model;
- the owner's own order (fixed, cheapest, fastest) is on for the capability;
- the request carries a picture, or there is no text;
- there is one candidate, or the cheapest is already first;
- there is no Gemini key (only a calibrated answer can meet a threshold; the router's own fallback would route through
  this same pool);
- the question would cost 5% or more of the stronger model's expected answer (input tokens at its price, plus its
  output limit or 512 tokens).

A decision that fails is skipped and the order stays. `AI_AUTO_DECISIONS=0` turns the step off.

## Receipts

Every answer that asked carries `explain.route_decision` — `{ id, kind, p, threshold, picked: cheap | strong,
decision_cost_usd, explore? }` — and a reason in words at the head of `explain.reasons`. The decision itself is metered
as a `classify` request, like any call to Decisions. No request text is stored: the person and the prompt are kept as
hashes, only to recognise the same question asked again.

## Thresholds

`route_thresholds(kind, threshold, n, updated_at, fitted_at)`, 0.7 when a kind has no row. The kind is the route's
Bench category, else the route's key.

Once a week (due-based, from the hourly housekeeping) each kind is re-fitted from the last 28 days of decisions:

- an answer is **bad** when the same person asked the same thing again within 10 minutes (`retried`), or a product
  reported it bad;
- an answer is **good** when a product reported it good, or 10 minutes passed with neither;
- the new threshold is the lowest of 0.50, 0.55 … 0.95 whose bad rate among cheaper answers is within 2 points of the
  stronger model's, with at least 30 answers on each side. Without that evidence the threshold does not move; when no
  threshold keeps quality, it goes to 0.95.

A small share of borderline requests (p within 0.1 under the threshold; 5%, `AI_AUTO_EXPLORE` up to 0.2) try the
cheaper model, so the fit can lower a threshold as well as raise it. Their receipt says `explore: true`.

## Reporting how an answer went

`POST /api/v1/route-decisions/:id/outcome` with `{ "good": true | false }` (capability `ai.run.create`): a test that
passed, a person's vote. Only the person or service the decision answered may report it; anyone else gets 404.
Decisions are kept 120 days.
