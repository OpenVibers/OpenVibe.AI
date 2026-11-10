# OpenVibe AI Inference Exchange — Provider Eligibility Matrix

> Checked: 2026-11-03  
> Source: `plan-state-2026-10-22/ai-exchange/PLAN.md` section C and public provider terms.  
> Rule: `access_mode` defaults to `UNVERIFIED` unless the terms **clearly allow resale** **and** an executed agreement exists. Retail subscriptions and coding-agent plans do **not** count as transferable wholesale compute.

## Legend

- `access_mode` values: `OWN_DEPLOYMENT`, `AUTHORIZED_WHOLESALE`, `CUSTOMER_BYOK`, `RESTRICTED`, `UNVERIFIED`.
- **BYOK** = OpenVibe.AI can route using the customer's own API key (stored via `server/credentials.js`).
- **Adapter** = the OpenVibe.AI provider kind that would serve this provider today.
- **Resale quote** = exact wording from the provider's terms that governs resale / embedding in a third-party product.
- **UNVERIFIED** means we could not locate a current public term that clearly permits managed resale; paid forwarding must not be enabled without executed approval.

## Matrix

| Provider | API format | Existing adapter | BYOK | access_mode default | Resale terms / quote | Terms URL | Checked |
|---|---|---|---|---|---|---|---|
| OpenAI | OpenAI | `openai` | Yes | `RESTRICTED` | "Customer may not resell or lease access to its Account or any End User Account." (OpenAI Services Agreement §3.1, effective 2026-01-01) | https://openai.com/policies/business-terms/ | 2026-11-03 |
| Anthropic | Anthropic Messages | `anthropic` | Yes | `RESTRICTED` | "resell the Services except as expressly approved by Anthropic" (Commercial Terms §D.4, effective 2025-06-17) | https://www.anthropic.com/legal/commercial-terms | 2026-11-03 |
| Google Gemini / Vertex | Gemini / OpenAI-compatible | `gemini` / `openai` | Yes | `RESTRICTED` | "sell, resell, sublicense, transfer, or distribute any or all of the Services" (Google Cloud Terms §3.3(c)) | https://cloud.google.com/terms | 2026-11-03 |
| Mistral | OpenAI-compatible | `openai` (BYOK credential) | Yes | `RESTRICTED` | "nor grant any third party access to the Mistral AI Products without our prior written authorization" (Commercial Terms §2.2(i), effective 2026-09-25) | https://legal.mistral.ai/terms/commercial-terms-of-service | 2026-11-03 |
| xAI / Grok | OpenAI-compatible | `openai` (BYOK credential) | Yes | `RESTRICTED` | Enterprise terms permit Bundled Services to Customer's End Users only; no standalone resale right found. | https://x.ai/legal/terms-of-service-enterprise | 2026-11-03 |
| Together AI | OpenAI-compatible | `openai` (BYOK credential) | Yes | `RESTRICTED` | "transfer, distribute, resell, lease, license, or assign the Services or otherwise offer the Services on a standalone basis" (Terms §4.3, updated 2026-05-19) | https://www.together.ai/terms-of-service | 2026-11-03 |
| DeepInfra | OpenAI-compatible | `openai` / `http` | Yes (custom) | `RESTRICTED` | "resell, sublicense, rent, distribute, or otherwise make the Services available to any third party except as expressly permitted under this Agreement or the applicable Service Order" (Terms §11(a)(viii), modified 2026-10-15) | https://deepinfra.com/terms | 2026-11-03 |
| RunPod (serverless) | OpenAI-compatible | `openai` / `http` | No | `RESTRICTED` | "Resell any credits purchased through the Service without the prior written consent of Runpod"; Marketplace / compute terms restrict commercial exploitation. | https://www.runpod.io/terms-of-service | 2026-11-03 |
| Replicate | Replicate API | `http` | No | `RESTRICTED` | "rent, lease, lend, sell, sublicense, assign, distribute, publish, transfer, or otherwise make available any Services to any person, including ... software as a service" (Terms §2.7(c)(iii), updated 2026-04-01) | https://replicate.com/terms | 2026-11-03 |
| Cloudflare Workers AI | Workers AI REST | `http` | No | `RESTRICTED` | "rent, lease, loan, export, or sell access to the Services to any third party" (Self-Serve Subscription Agreement §2.2.1(a), updated 2025-09-12) | https://www.cloudflare.com/terms/ | 2026-11-03 |
| AWS Bedrock | Bedrock Converse / Invoke | `http` | No | `RESTRICTED` | Standard AWS Customer Agreement / Service Terms do not permit resale of managed AI inference; AWS marketplace/partner programs require separate authorization. | https://aws.amazon.com/service-terms/ | 2026-11-03 |
| Azure OpenAI / Foundry | Azure OpenAI / REST | `http` | No | `RESTRICTED` | Microsoft Customer Agreement / Online Subscription Agreement restrict resale; embedding in third-party SaaS requires negotiated terms. | https://azure.microsoft.com/en-us/support/legal/ | 2026-11-03 |
| Featherless | OpenAI-compatible | `openai` / `http` | No | `AUTHORIZED_WHOLESALE` (Scale only) | "Scale plans are not subject to said limits and may be used in arbitrary applications, including inference resale." (Terms §3, last updated 2024-06-10) **Requires executed Scale agreement.** | https://featherless.ai/terms | 2026-11-03 |
| Chutes | Custom / OpenAI-compatible | `http` | No | `UNVERIFIED` | Terms fetched; no explicit resale/wholesale clause found. Subscriptions are for casual/direct use; PAYGO required for production. | https://chutes.ai/terms | 2026-11-03 |
| Baseten | OpenAI-compatible | `http` | No | `UNVERIFIED` | Terms page did not return readable content in this check. | https://www.baseten.co/terms-of-service | 2026-11-03 |
| Venice | OpenAI-compatible | `http` | No | `UNVERIFIED` | Terms URL returned 404. | https://venice.ai/terms-of-service (404) | 2026-11-03 |
| Nebius | OpenAI-compatible | `http` | No | `UNVERIFIED` | Terms URL returned 404. | https://nebius.com/legal/terms-of-service (404) | 2026-11-03 |
| Novita | OpenAI-compatible | `http` | No | `UNVERIFIED` | Terms URL returned 404. | https://novita.ai/terms-of-service (404) | 2026-11-03 |
| Groq | OpenAI-compatible | `openai` (BYOK credential) | Yes | `UNVERIFIED` | `/legal/terms-of-service` returned 404; consumer terms exist but no clear wholesale/resale clause found. | https://groq.com/legal/terms-of-service (404) | 2026-11-03 |
| Cerebras | OpenAI-compatible | `openai` (BYOK credential) | Yes | `UNVERIFIED` | Terms URL returned 404. | https://www.cerebras.ai/terms-of-use (404) | 2026-11-03 |
| Fireworks | OpenAI-compatible | `openai` (BYOK credential) | Yes | `UNVERIFIED` | `/terms` returned 404; PDF at `/legal/terms` could not be fetched. | https://fireworks.ai/terms (404) | 2026-11-03 |
| SiliconFlow | OpenAI-compatible | `http` | No | `UNVERIFIED` | Terms URL returned 404. | https://siliconflow.com/terms-of-service (404) | 2026-11-03 |
| Refuseless | Unknown | — | No | `UNVERIFIED` | No terms URL located. | — | 2026-11-03 |
| Opper / Heabsy | Unknown | — | No | `UNVERIFIED` | No terms URL located. | — | 2026-11-03 |
| Modal | Modal API | `http` | No | `UNVERIFIED` | Terms URL returned 404. | https://modal.com/terms (404) | 2026-11-03 |
| Beam | REST / custom | `http` | No | `UNVERIFIED` | Not fetched. | — | 2026-11-03 |
| Prime Intellect | REST / custom | `http` | No | `UNVERIFIED` | Terms URL returned 404. | https://www.primeintellect.ai/terms (404) | 2026-11-03 |
| Self-hosted vLLM / SGLang / llama.cpp / Ollama | OpenAI-compatible | `openai` / `http` | N/A | `OWN_DEPLOYMENT` | Open-source runtimes deployed on OpenVibe-owned or customer-authorized infrastructure; no upstream resale constraint. | Various OS licenses | 2026-11-03 |

## Pool presets added 2026-11-09

These presets are seeded disabled in practice until the owner adds a provider key. Commercial access remains `UNVERIFIED` until an executed agreement explicitly permits managed resale; Together stays `RESTRICTED` because its current terms prohibit resale without authorization. `null` privacy facts mean the provider did not state them on the pages checked. A listed price is the provider's own published list price per 1M tokens, not an aggregator quote.

| Provider | Base URL | Privacy facts confirmed | Access default | Own provider listing / terms |
|---|---|---|---|---|
| Venice AI | `https://api.venice.ai/api/v1` | Venice Uncensored 1.2: private, zero retention, not used for training | `UNVERIFIED` | [Model page and price](https://docs.venice.ai/models/venice-uncensored-1-2) |
| abliteratedmodels.cc | `https://api.abliteratedmodels.cc/v1` | Retention and training unstated; its own site says lawful adult and fictional content is allowed, with minor sexual content excluded | `UNVERIFIED` | [Provider model and pricing](https://abliteratedmodels.cc/) |
| UplinkSwitch | `https://api.uplinkswitch.ai/v1` | Adult content between fictional adults permitted for 18+ where legal; no retention facts confirmed | `UNVERIFIED` | [Acceptable use](https://uplinkswitch.ai/acceptable-use) |
| Chutes | `https://llm.chutes.ai/v1` | Retention/training unstated; TEE flag is not treated as a retention promise | `UNVERIFIED` | [Pricing](https://www.chutes.ai/pricing) |
| SiliconFlow | `https://api.siliconflow.com/v1` | Retention/training unstated | `UNVERIFIED` | [Provider docs](https://docs.siliconflow.com/) |
| Nebius Token Factory | `https://api.tokenfactory.nebius.com/v1` | Retention/training unstated | `UNVERIFIED` | [Model pricing](https://nebius.com/services/token-factory/models/qwen-models-inference) |
| Together AI | `https://api.together.xyz/v1` | Retention/training unstated here; terms prohibit resale absent authorization | `RESTRICTED` | [Terms](https://www.together.ai/terms-of-service) |
| Fireworks AI | `https://api.fireworks.ai/inference/v1` | Retention/training unstated | `UNVERIFIED` | [Model catalog](https://fireworks.ai/models) |
| Groq | `https://api.groq.com/openai/v1` | Retention/training unstated | `UNVERIFIED` | [Model pricing and limits](https://console.groq.com/docs/model/openai/gpt-oss-120b) |
| Cerebras | `https://api.cerebras.ai/v1` | Retention/training unstated | `UNVERIFIED` | [Public model catalog](https://api.cerebras.ai/public/v1/models) |
| SambaNova | `https://api.sambanova.ai/v1` | Retention/training unstated | `UNVERIFIED` | [Pricing](https://cloud.sambanova.ai/plans/pricing) |
| Baseten | `https://inference.baseten.co/v1` | Retention/training unstated | `UNVERIFIED` | [Pricing](https://www.baseten.co/pricing/) |
| Hyperbolic | `https://api.hyperbolic.xyz/v1` | Retention/training unstated | `UNVERIFIED` | [Inference pricing](https://docs.hyperbolic.xyz/docs/hyperbolic-ai-inference-pricing) |

## Cheap hosted inference added 2026-11-10

Endpoints, keyless model lists and key requirements were probed on 2026-11-10 (no account, no key, no paid call). Retention, training and resale terms are unstated for all ten; NanoGPT's terms alone explicitly allow reselling PAYG access, which still keeps its default `UNVERIFIED` until an executed agreement exists. Prices are not read by the price book for these ten (it takes per-1M figures; the catalogue sync takes the per-token strings Inference.net, AtlasCloud and Friendli publish). Avian publishes per-million figures the existing sync cannot read, so its prices stay on the owner's panel.

| Provider | Base URL | Privacy facts confirmed | Access default | Own provider listing / terms |
|---|---|---|---|---|
| Parasail | `https://api.parasail.io/v1` | Retention/training unstated; model list needs a key | `UNVERIFIED` | [Model docs](https://docs.parasail.io/parasail-docs/products/overview/models) |
| Particle AI | `https://api.particle.ai/v1` | Retention/training unstated; model list needs a key | `UNVERIFIED` | [Docs](https://docs.particle.ai/) |
| Inference.net | `https://api.inference.net/v1` | Retention/training unstated; keyless model list with per-token prices | `UNVERIFIED` | [Docs](https://docs.inference.net/) |
| AtlasCloud | `https://api.atlascloud.ai/v1` | Retention/training unstated; keyless model list with per-token prices | `UNVERIFIED` | [Docs](https://www.atlascloud.ai/docs) |
| Avian | `https://api.avian.io/v1` | Retention/training unstated; keyless model list, per-million prices not readable by sync | `UNVERIFIED` | [Docs](https://avian.io/docs/) |
| NanoGPT | `https://api.nano-gpt.com/v1` | Terms allow reselling PAYG access (no markup); keyless model list carries no prices | `UNVERIFIED` | [Pricing](https://nano-gpt.com/pricing) |
| Infermatic | `https://api.totalgpt.ai/v1` | Retention/training unstated; model list needs a key | `UNVERIFIED` | [Docs](https://ui.infermatic.ai/docs) |
| ArliAI | `https://api.arliai.com/v1` | Retention/training unstated; keyless custom model list at `/model/all` | `UNVERIFIED` | [Site](https://www.arliai.com/) |
| Friendli | `https://api.friendli.ai/serverless/v1` | Retention/training unstated; keyless model list with per-token prices | `UNVERIFIED` | [Model APIs intro](https://friendli.ai/docs/guides/model-apis/introduction) |
| Scaleway | `https://api.scaleway.ai/v1` | Retention/training unstated; model list needs a key | `UNVERIFIED` | [Generative APIs](https://www.scaleway.com/en/developers/api/generative-apis) |

## Cheapest confirmed open-weight prices

These are the lowest prices confirmed among the listed provider-owned source pages; an unpriced provider is not assumed to cost more. Cached prices are `—` when the provider does not publish one.

| Model / tier | Cheapest confirmed provider | Input / cached / output USD per 1M tokens | Context | Provider source | Checked |
|---|---|---:|---:|---|---|
| GPT-OSS 120B | DeepInfra | $0.037 / — / $0.17 | 131,072 | [DeepInfra model list](https://api.deepinfra.com/v1/models) | 2026-11-06 |
| DeepSeek V4 Flash | DeepInfra | $0.09 / $0.018 / $0.18 | 1,048,576 | [DeepInfra model list](https://api.deepinfra.com/v1/models) | 2026-11-06 |
| DeepSeek V4.1 Flash 1017 | DeepInfra | $0.20 / $0.006 / $0.60 | 1,048,576 | [DeepInfra model list](https://api.deepinfra.com/v1/models) | 2026-11-06 |
| Qwen3.8-Max | DeepInfra | $1.65 / $0.206 / $4.951 | 256,000 | [DeepInfra model list](https://api.deepinfra.com/v1/models) | 2026-11-06 |
| Qwen3-14B | DeepInfra or Featherless (tie) | $0.12 / — / $0.24 | 32,768 | [DeepInfra model list](https://api.deepinfra.com/v1/models), [Featherless model list](https://api.featherless.ai/v1/models) | 2026-11-06 |
| Qwen3-30B-A3B-Instruct-2507 | Nebius Token Factory | $0.10 / — / $0.30 | 262,144 | [Nebius model pricing](https://nebius.com/services/token-factory/models/qwen-models-inference) | 2026-11-09 |
| Qwen3-32B TEE | Chutes | $0.104 / — / $0.416 | 40,000 | [Chutes pricing](https://www.chutes.ai/pricing) | 2026-11-09 |
| Llama 3.1 8B Instruct | Featherless | $0.05 / — / $0.08 | 32,768 | [Featherless model list](https://api.featherless.ai/v1/models) | 2026-11-06 |
| GLM-5.3 | DeepInfra | $0.90 / $0.20 / $4.00 | 1,048,576 | [DeepInfra model list](https://api.deepinfra.com/v1/models) | 2026-11-06 |
| Kimi K3.1 Pro | Kimi or Novita (tie) | $2.00 / $0.20 / $10.00 | 1,048,576 | [Moonshot pricing](https://platform.kimi.ai/docs/pricing/chat), [Novita model list](https://api.novita.ai/v3/openai/models) | 2026-11-06 |
| Mistral Nemo Instruct 2407 TEE | Chutes | $0.0245 / — / $0.0978 | 131,072 | [Chutes pricing](https://www.chutes.ai/pricing) | 2026-11-09 |
| Qwen3.8 Flash | Alibaba Model Studio | $0.15 / — / $0.47 | 1,048,576 | [Alibaba pricing](https://www.alibabacloud.com/help/en/model-studio/model-pricing) | 2026-11-06 |
| Uncensored API (`uncensored`) | abliteratedmodels.cc | $0.15 / — / $0.50 | 100,000 | [Provider pricing](https://abliteratedmodels.cc/) | 2026-11-09 |
| Venice Uncensored 1.2 | Venice AI | $0.20 / — / $0.90 | 131,072 | [Venice model page](https://docs.venice.ai/models/venice-uncensored-1-2) | 2026-11-09 |

## Notes

1. **BYOK in OpenVibe.AI today**: `server/credentials.js` and `server/console/presets.js` support stored credentials for `anthropic`, `openai`, `gemini`, `deepseek`, `mistral`, `xai`, `groq`, `cerebras`, `together`, `fireworks`, `openrouter`, `minimax`, and `custom`. Any OpenAI-compatible provider can also be reached via the `openai` adapter with a custom `base_url` and `x_openvibe.provider` / credential.
2. **Managed resale is blocked by default**. Only `OWN_DEPLOYMENT` and `AUTHORIZED_WHOLESALE` (with executed agreement) may be used for paid managed routes. `CUSTOMER_BYOK` is allowed where the customer is billed directly by the upstream.
3. **Unknown providers** are listed as `UNVERIFIED`. Before enabling any paid forwarding, obtain current terms, an executed commercial agreement, and legal review.
4. The comparison above records the lowest confirmed list price from provider-owned pages; these are not resale quotes. Managed prices still follow the accepted model price plus the owner-set markup, and commercial eligibility stays gated by `access_mode`.
