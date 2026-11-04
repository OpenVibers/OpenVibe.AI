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

## Notes

1. **BYOK in OpenVibe.AI today**: `server/credentials.js` and `server/console/presets.js` support stored credentials for `anthropic`, `openai`, `gemini`, `deepseek`, `mistral`, `xai`, `groq`, `cerebras`, `together`, `fireworks`, `openrouter`, `minimax`, and `custom`. Any OpenAI-compatible provider can also be reached via the `openai` adapter with a custom `base_url` and `x_openvibe.provider` / credential.
2. **Managed resale is blocked by default**. Only `OWN_DEPLOYMENT` and `AUTHORIZED_WHOLESALE` (with executed agreement) may be used for paid managed routes. `CUSTOMER_BYOK` is allowed where the customer is billed directly by the upstream.
3. **Unknown providers** are listed as `UNVERIFIED`. Before enabling any paid forwarding, obtain current terms, an executed commercial agreement, and legal review.
4. Prices are **not** recorded in this matrix per PLAN instructions; they must be obtained as live quotes from official sources and versioned in `platform.rate-card@1` before use.
