'use strict';
/**
 * The models the GPU provisioner knows how to serve, and what each one needs from a GPU.
 *
 * The first two are the design's starting point: a DeepSeek R1 32B distill at Q4 on one RTX 3090 or
 * 4090 - once with the refusal training removed (abliterated) and once plain. A 32B Q4_K_M quant is
 * about 20 GB of weights, so it fits one 24 GB card.
 *
 * The weights URL, the image and the command are data, not code: they are what the owner's first
 * launch really runs, so they are shown on the console's GPU page and in the audit row. The owner
 * checks them before the first launch and corrects them here.
 *
 *   vram_mb     the VRAM the weights and the KV cache need (the marketplace's filter)
 *   disk_gb     the disk the image and the weights need
 *   gpu_names   the cards that fit the model
 *   throughput  the tokens an hour the card is expected to serve (a planning estimate; it prices the
 *               offer for the router)
 */
const MODELS = Object.freeze([
    {
        key: 'deepseek-r1-32b-abliterated',
        display_name: 'DeepSeek R1 32B distill (abliterated), Q4',
        provider_key: 'gpu.deepseek-r1-32b-abliterated',
        model_key: 'deepseek-r1-32b-abliterated',
        marketplace: 'vast',
        context_window: 8192,
        throughput_tokens_per_hour: 180000,
        requirements: { vram_mb: 22000, disk_gb: 60, gpu_names: ['RTX 3090', 'RTX 4090'], num_gpus: 1, min_reliability: 0.99 },
        runtime: {
            kind: 'llama.cpp',
            image: 'ghcr.io/ggml-org/llama.cpp:server-cuda',
            port: 8000,
            weights: {
                repo: 'mradermacher/DeepSeek-R1-Distill-Llama-32B-abliterated-GGUF',
                file: 'DeepSeek-R1-Distill-Llama-32B-abliterated-Q4_K_M.gguf',
            },
            // The container's command: fetch the weights, then serve them with the OpenAI API.
            command: 'mkdir -p /models && curl -fL --retry 3 -o /models/{file} {weights_url} '
                + '&& exec /app/llama-server --model /models/{file} --host 0.0.0.0 --port {port} '
                + '--alias {model} --ctx-size {ctx} --n-gpu-layers 999',
        },
    },
    {
        key: 'deepseek-r1-32b',
        display_name: 'DeepSeek R1 32B distill, Q4',
        provider_key: 'gpu.deepseek-r1-32b',
        model_key: 'deepseek-r1-32b',
        marketplace: 'vast',
        context_window: 8192,
        throughput_tokens_per_hour: 180000,
        requirements: { vram_mb: 22000, disk_gb: 60, gpu_names: ['RTX 3090', 'RTX 4090'], num_gpus: 1, min_reliability: 0.99 },
        runtime: {
            kind: 'llama.cpp',
            image: 'ghcr.io/ggml-org/llama.cpp:server-cuda',
            port: 8000,
            weights: {
                repo: 'bartowski/DeepSeek-R1-Distill-Llama-32B-GGUF',
                file: 'DeepSeek-R1-Distill-Llama-32B-Q4_K_M.gguf',
            },
            command: 'mkdir -p /models && curl -fL --retry 3 -o /models/{file} {weights_url} '
                + '&& exec /app/llama-server --model /models/{file} --host 0.0.0.0 --port {port} '
                + '--alias {model} --ctx-size {ctx} --n-gpu-layers 999',
        },
    },
]);

const byKey = new Map(MODELS.map((m) => [m.key, m]));

/** The model a key names, or null. */
function find(key) {
    return byKey.get(String(key || '')) || null;
}

/** Every model the provisioner knows. */
function list() {
    return [...MODELS];
}

/** The URL the weights come from (a public Hugging Face file). */
function weightsUrl(spec) {
    const w = (spec && spec.runtime && spec.runtime.weights) || {};
    if (!w.repo || !w.file) return '';
    return 'https://huggingface.co/' + w.repo + '/resolve/main/' + w.file;
}

/** The container command of a model, with its placeholders filled in. */
function commandOf(spec) {
    const r = (spec && spec.runtime) || {};
    return String(r.command || '')
        .replace(/\{file\}/g, (r.weights && r.weights.file) || '')
        .replace(/\{weights_url\}/g, weightsUrl(spec))
        .replace(/\{port\}/g, String(r.port || 8000))
        .replace(/\{model\}/g, (spec && spec.model_key) || '')
        .replace(/\{ctx\}/g, String((spec && spec.context_window) || 8192));
}

module.exports = { MODELS, find, list, weightsUrl, commandOf };
