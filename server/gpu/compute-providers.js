'use strict';
/**
 * The capacity we rent ourselves (2026-11-10, part 3 of the provider wave): Runpod and Vast.ai GPU hours,
 * read from the providers' own public pages on the day named, and the owner's choice to run an open model
 * on one of them through an OpenAI-compatible vLLM endpoint.
 *
 * Nothing here rents, starts or stops anything, and no account is created: the provisioner
 * (server/gpu/provisioner.js) does that only when the owner asks, with the owner's key. The per-million
 * token price of a rented card is hourly USD × 1,000,000 / the model's measured tokens an hour
 * (server/gpu/token-cost.js); a number nobody measured is not invented here.
 */
const CHECKED = '2026-11-10';

const COMPUTE_PROVIDERS = Object.freeze([
    {
        key: 'runpod',
        display_name: 'Runpod',
        kind: 'gpu',
        billing: 'Pods per second; serverless per second rounded up from worker start to full stop',
        docs_url: 'https://docs.runpod.io/',
        endpoint: {
            kind: 'openai-compatible vLLM',
            base_url_pattern: 'https://{pod_id}-{port}.proxy.runpod.io/v1 or https://api.runpod.ai/v2/{endpoint_id}/openai/v1',
            note: 'the owner adds the endpoint URL and its key; the price is the GPU hour, shown per million tokens from the measured throughput',
        },
        pods: [
            { gpu: 'RTX A5000 24GB', hourly_usd: 0.27, vram_mb: 24576 },
            { gpu: 'RTX 3090 24GB', hourly_usd: 0.50, vram_mb: 24576 },
            { gpu: 'A40 48GB', hourly_usd: 0.59, vram_mb: 49152 },
            { gpu: 'RTX 4090 24GB', hourly_usd: 0.89, vram_mb: 24576 },
            { gpu: 'L40S 48GB', hourly_usd: 1.09, vram_mb: 49152 },
            { gpu: 'A100 80GB', hourly_usd: 1.79, vram_mb: 81920 },
            { gpu: 'H100 80GB PCIe', hourly_usd: 2.89, vram_mb: 81920 },
        ],
        serverless: [
            { gpu: 'RTX 5090 32GB', hourly_usd: 1.58 },
            { gpu: 'H200 141GB', hourly_usd: 5.93 },
            { gpu: 'B200 192GB', hourly_usd: 8.64 },
        ],
        storage: { container_usd_per_gb_month: 0.10, network_volume_usd_per_gb_month: 0.07, egress: 'no ingress/egress fees reported by the providers we read' },
        credits: {
            starter_usd: 1000, starter_eligibility: 'raised under $1M', venture_usd: 5000, venture_eligibility: 'backed by a verified VC (a16z, Neo, South Park Commons), raised under $5M',
            growth: [{ commit_usd: 25000, bonus_usd: 10000 }, { commit_usd: 50000, bonus_usd: 25000 }],
            expires: 'one year after issue', note: 'the owner applies; nothing was applied for here',
        },
        source: 'https://www.runpod.io/pricing',
        credits_source: 'https://www.runpod.io/startup-program',
        checked: CHECKED,
    },
    {
        key: 'vast',
        display_name: 'Vast.ai',
        kind: 'gpu',
        billing: 'per second on demand; interruptible offers are preemptible',
        docs_url: 'https://docs.vast.ai/',
        endpoint: {
            kind: 'openai-compatible vLLM or llama.cpp',
            base_url_pattern: 'http://{host}:{port}/v1',
            note: 'the owner adds the instance URL and its key; spot capacity is interruptible, so it is background only',
        },
        // On-demand median and the spot floor from the public GPU index; both are marketplace readings, not a
        // list price. The price book's live reader (server/gpu/market.js) replaces them when it next runs.
        pods: [
            { gpu: 'RTX 3090 24GB', hourly_usd: 0.177, spot_usd: 0.12, vram_mb: 24576 },
            { gpu: 'RTX 4090 24GB', hourly_usd: 0.470, spot_usd: 0.14, vram_mb: 24576 },
            { gpu: 'L40S 48GB', hourly_usd: 0.734, vram_mb: 49152 },
            { gpu: 'A100 80GB', hourly_usd: 0.843, spot_usd: null, vram_mb: 81920 },
            { gpu: 'H100 80GB', hourly_usd: 2.401, spot_usd: 1.73, vram_mb: 81920 },
            { gpu: 'H200 141GB', hourly_usd: 5.054, vram_mb: 141312 },
            { gpu: 'B200 192GB', hourly_usd: 8.751, vram_mb: 196608 },
        ],
        storage: null,
        credits: { match: 'dollar-for-dollar credit match on spend', note: 'the owner applies; nothing was applied for here' },
        source: 'https://www.darkcompute.cfd/gpu-index',
        credits_source: 'https://www.vast.ai/startup',
        checked: CHECKED,
        traits: { latency_classes: ['background', 'batch'], interruptible: true },
    },
]);

const byKey = new Map(COMPUTE_PROVIDERS.map((p) => [p.key, p]));

/** One record, or null. */
function get(key) {
    return byKey.get(String(key || '')) || null;
}

/** The cheapest GPU hour each provider lists, for a one-line summary. */
function cheapest(provider) {
    const prices = (provider.pods || []).map((p) => Number(p.hourly_usd)).filter((n) => Number.isFinite(n) && n > 0);
    return prices.length ? Math.min(...prices) : null;
}

module.exports = { COMPUTE_PROVIDERS, CHECKED, get, cheapest };
