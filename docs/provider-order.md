# Owner provider order

The console's Provider order section stores each capability's array in the existing versioned route table (`provider-order.<capability>`). It does not create a second provider/model list. An owner enables an order explicitly; no order is enabled by installation. Turning the order off restores normal routing. An enabled empty array allows no managed offer.

The owner API reads `GET /api/v1/admin/console/orders` and writes `POST /api/v1/admin/console/orders/:capability` with `{ "enabled": true, "choices": [{ "provider": "openai", "model": "registered-model-id" }] }`. Choices must name existing providers and models, cannot repeat, and are limited to 64. Existing provider-management authorization, audit and route versions apply. Exchange additionally requires its owner role and same-origin writes.

Chat, vision, tools, image, video, speech, transcription, embeddings and rerank have separate orders. Chat-compatible operations use chat; image input uses vision and a tools request uses tools. Eligibility still applies: content tier and adult floor, provider access, scope, payer, price ceiling and model support are checked before an attempt. Own-key routing remains the person's preference. Exact-artifact requests cannot substitute another model.

Managed candidates that pass those checks run in the owner's order. A failed provider proceeds to the next choice without retrying that provider. Provider and model off switches are rechecked at each attempt. Disabled, gone and failed attempts remain in the existing receipt. An explicit order may reach more than the ordinary three-provider fallback limit. Run-specific exact pins retain their existing single-offer behavior.

This slice covers model routing. Search order arrays and provider spend caps follow separately; no search behavior changes here.

For Fable: the console Provider order section uses plain kit forms and a JSON array editor. It needs the designed order/reorder controls and model selection treatment.
