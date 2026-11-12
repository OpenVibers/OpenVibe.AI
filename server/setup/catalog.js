'use strict';
/**
 * The Setup page's own catalogue (OpenVibe.Network /admin/ai/setup).
 *
 * One step per job the estate needs. Each step names the registry route products already use, the
 * provider and model the network recommends, why (six words at most), and what the price means.
 * These are the provider's own published list prices, read on the day named; when the registry has
 * a model row its price wins, so the page never shows a stale number beside a live one.
 *
 * The page is a guided setup, not a second registry: it writes the provider key into
 * ai.provider_keys and the model into the route, then tests through the route's own placement.
 * server/api/setup.js is the API.
 */
const { keyPage } = require('../owner-inputs');

const CHECKED = '2026-11-12';
// Altare Inference is free until 2026-12-01 (usage does not count toward the included amount; rate limits apply), then
// Always Free includes $100 of usage a month (https://docs.altare.gg/inference/pricing): an offer worth trying first.
const ALTARE_NOTE = 'Free until December 1, then $100 of usage a month on Altare\'s free plan (60 requests a minute; 30 for its flagship models). Record the $100 as a monthly credit on Exchange → Console → Providers.';
const SOURCES = Object.freeze({
    deepseek: 'https://api-docs.deepseek.com/quick_start/pricing',
    gemini: 'https://ai.google.dev/gemini-api/docs/pricing',
    openaiImages: 'https://platform.openai.com/docs/pricing',
    openaiAudio: 'https://platform.openai.com/docs/pricing',
    googleSpeech: 'https://cloud.google.com/text-to-speech/pricing',
    polly: 'https://aws.amazon.com/polly/pricing/',
    openaiEmbed: 'https://platform.openai.com/docs/pricing',
    brave: 'https://brave.com/search/api/',
    tavily: 'https://www.tavily.com/pricing',
    serper: 'https://serper.dev/pricing',
    altare: 'https://inference.altare.global/v1/models',
    geminiDecision: 'https://blog.google/innovation-and-ai/technology/developers-tools/gemini-decisions-api/',
});

/** A price in the page's plain words; `unit` is what the number is per. */
const tokenPrice = (inPerMtok, outPerMtok, cached = null) => ({
    kind: 'tokens', in_per_mtok: inPerMtok, out_per_mtok: outPerMtok, cached_per_mtok: cached,
    unit: '1M tokens', text: `$${inPerMtok} in · $${outPerMtok} out per 1M tokens`,
});
const picturePrice = (usd) => ({ kind: 'image', per_image_usd: usd, unit: 'picture', text: `$${usd} per picture` });
const minutePrice = (usd) => ({ kind: 'minute', per_minute_usd: usd, unit: 'minute', text: `$${usd} per minute` });
const charsPrice = (usd) => ({ kind: 'characters', per_million_chars_usd: usd, unit: '1M characters', text: `$${usd} per 1M characters` });
const searchPrice = (usd) => ({ kind: 'search', per_1000_usd: usd, unit: '1,000 searches', text: `$${usd} per 1,000 searches` });
const FREE = { kind: 'free', text: 'free', unit: null };

/** One offer: where the key comes from, what it costs and whether it can be recommended. */
function offer(provider, model, label, price, source, extra = {}) {
    return { provider, model, label, price, source, checked: CHECKED, ...extra };
}

/**
 * The steps, in the order the page walks them. `route` is the route products already use;
 * `search` has no route (OpenVibe.Search picks a working engine), and `test` says what one tiny
 * real request does so the page can show the answer and its cost.
 */
const STEPS = Object.freeze([
    {
        id: 'chat', name: 'Chat and writing', short: 'Chat', route: 'default.chat', 'capability': 'chat', operation: 'chat', modelType: 'chat',
        what: 'Turns text into an answer, a summary or a draft.',
        uses: 'Every AI answer on the network: chat members, the Rundown\'s writing desk, summaries and site copy.',
        recommended: offer('deepseek', 'deepseek-flash', 'DeepSeek Flash', tokenPrice(0.15, 0.6, 0.003), SOURCES.deepseek,
            { why: 'cheapest that looks good', note: 'The price is DeepSeek\'s off-peak list price; daytime is higher.' }),
        alternatives: [
            offer('altare', 'deepseek-v4.1-flash', 'DeepSeek V4.1 Flash on Altare', tokenPrice(0.3, 1.2, 0.006), SOURCES.altare, { why: 'free until December 1', note: ALTARE_NOTE }),
            offer('deepseek', 'deepseek-chat', 'DeepSeek Chat', tokenPrice(0.26, 0.38), SOURCES.deepseek),
            offer('openai', 'gpt-5-mini', 'GPT-5 mini', tokenPrice(0.25, 2), SOURCES.openaiImages),
        ],
    },
    {
        id: 'vision', name: 'Vision', short: 'Vision', route: 'default.json', 'capability': 'chat', operation: 'chat', modelType: 'chat',
        what: 'Reads a picture and answers with what is in it, usually as JSON.',
        uses: 'Food\'s pantry photos and receipts, Pics\' alt text, and Media\'s picture checks.',
        recommended: offer('gemini', 'gemini-2.5-flash', 'Gemini 2.5 Flash', tokenPrice(0.3, 2.5), SOURCES.gemini,
            { why: 'cheapest that looks good' }),
        alternatives: [
            offer('openai', 'gpt-5-mini', 'GPT-5 mini', tokenPrice(0.25, 2), SOURCES.openaiImages),
            offer('anthropic', 'claude-opus-5-5', 'Claude Opus 5.5', tokenPrice(4, 20, 0.2), 'https://platform.claude.com/docs/en/models/opus-5-5/overview'),
        ],
    },
    {
        id: 'image', name: 'Images', short: 'Images', route: 'default.image', 'capability': 'image', operation: 'image', modelType: 'image',
        what: 'Makes a picture from a description.',
        uses: 'The Rundown\'s episode pictures, Vibe\'s picture button, chat personas\' faces.',
        recommended: offer('openai', 'gpt-image-1', 'OpenAI gpt-image-1', picturePrice(0.04), SOURCES.openaiImages,
            { why: 'cheapest that looks good', note: 'A 1024 px picture at medium quality. Small sizes may be refused; the page shows it at 256 px.' }),
        alternatives: [
            offer('gemini', 'gemini-2.5-flash-image', 'Gemini 2.5 Flash Image', picturePrice(0.039), SOURCES.gemini),
            offer('xai', 'grok-2-image', 'xAI Grok Image', picturePrice(0.07), 'https://docs.x.ai/docs/models'),
        ],
    },
    {
        id: 'stt', name: 'Speech to text', short: 'Speech in', route: 'live.stt', 'capability': 'transcribe', operation: 'transcribe', modelType: 'stt',
        what: 'Turns a recording into written words with their times.',
        uses: 'Live\'s stream transcripts, Vibe\'s voice messages, and captions on clips.',
        recommended: offer('whisper', 'whisper.cpp', 'whisper.cpp on this machine', FREE, 'https://github.com/ggerganov/whisper.cpp',
            { why: 'free on our own machine', keyless: true }),
        alternatives: [
            offer('openai', 'whisper-1', 'OpenAI Whisper', minutePrice(0.006), SOURCES.openaiAudio),
            offer('mistral', 'voxtral-mini-latest', 'Mistral Voxtral', minutePrice(0.003), 'https://mistral.ai/pricing'),
        ],
    },
    {
        id: 'speech', name: 'Voices', short: 'Voices', route: 'default.speech', 'capability': 'speak', operation: 'speak', modelType: 'speech',
        what: 'Reads text aloud in a natural voice.',
        uses: 'Vibe speaking in Chat and the Dock, and read-aloud across the network.',
        recommended: offer('google-tts', 'gc_neural_chad', 'Google Neural2', charsPrice(16), SOURCES.googleSpeech,
            { why: 'natural voices, fair price', key_page: { url: 'https://console.cloud.google.com/apis/credentials', how: 'Create an API key in a Google Cloud project, then enable the Text-to-Speech API in that project.' },
              note: 'Neural2 is Google\'s mid-tier voice; Standard costs $4 per 1M characters.' }),
        alternatives: [
            offer('google-tts', 'gc_smooth_operator', 'Google Standard', charsPrice(4), SOURCES.googleSpeech),
            offer('polly', 'pl_joanna_neural', 'Amazon Polly Neural', charsPrice(16), SOURCES.polly,
                { key_page: { url: 'https://console.aws.amazon.com/iam/home#/security_credentials', how: 'Create an access key for a user that may call Polly, then paste the access key id here.' } }),
        ],
    },
    {
        id: 'embedding', name: 'Embeddings', short: 'Embeddings', route: 'default.embedding', 'capability': 'embed', operation: 'embed', modelType: 'embedding',
        what: 'Turns text into numbers so things can be found by meaning.',
        uses: 'Memory search, wiki and policy matching, and everything that finds an answer by meaning.',
        recommended: offer('openai', 'text-embedding-3-small', 'OpenAI Embedding 3 small', tokenPrice(0.02, 0), SOURCES.openaiEmbed,
            { why: 'cheapest that looks good' }),
        alternatives: [
            offer('local', 'nomic-embed-text', 'nomic-embed-text on this machine', FREE, 'https://ollama.com/library/nomic-embed-text', { keyless: true }),
            offer('gemini', 'text-embedding-004', 'Gemini Embedding', tokenPrice(0.1, 0), SOURCES.gemini),
        ],
    },
    {
        id: 'search', name: 'Web search', short: 'Search', route: null, 'capability': 'web-search', operation: 'search', modelType: null,
        what: 'Looks up the current web and brings back pages and snippets.',
        uses: 'Deep dives, research answers, and every product that needs today\'s web.',
        recommended: offer('openvibe', 'openvibe', 'OpenVibe Search', FREE, 'https://search.openvibe.network',
            { why: 'included in the network', keyless: true, note: 'Our own index is free to query and needs no key; Brave and Tavily add the wider web.' }),
        alternatives: [
            offer('brave', 'brave', 'Brave Search', searchPrice(5), SOURCES.brave),
            offer('tavily', 'tavily', 'Tavily', searchPrice(8), SOURCES.tavily),
        ],
    },
    {
        id: 'code', name: 'Code agents (plans)', short: 'Code', route: 'space.build', 'capability': 'chat', operation: 'chat', modelType: 'chat',
        what: 'Plans work and writes code that follows the plan.',
        uses: 'Codes\' plans, Space\'s app builder, and code agents working through OpenVibe.Run.',
        recommended: offer('deepseek', 'deepseek-chat', 'DeepSeek Chat', tokenPrice(0.26, 0.38), SOURCES.deepseek,
            { why: 'cheapest that looks good' }),
        alternatives: [
            offer('altare', 'glm-5.3', 'GLM-5.3 on Altare', tokenPrice(1.4, 4.4, 0.26), SOURCES.altare, { why: 'free until December 1', note: ALTARE_NOTE }),
            offer('openai', 'gpt-5-mini', 'GPT-5 mini', tokenPrice(0.25, 2), SOURCES.openaiImages),
            offer('anthropic', 'claude-opus-5-5', 'Claude Opus 5.5', tokenPrice(4, 20, 0.2), 'https://platform.claude.com/docs/en/models/opus-5-5/overview'),
        ],
    },
    {
        id: 'decide', name: 'Decisions (routing and checks)', short: 'Decisions', route: 'decide.fallback', 'capability': 'chat', operation: 'chat', modelType: 'chat',
        what: 'Answers yes/no, one-of-a-list and rubric questions about a text or a picture, with how sure it is.',
        uses: 'POST /api/v1/decisions: routing a request to the right model, moderation checks, grading and tool choice, without a full model writing an answer.',
        recommended: offer('gemini', 'gemini-decision-1', 'Gemini Decision 1', { kind: 'tokens', in_per_mtok: 0.1, out_per_mtok: 0, cached_per_mtok: null, unit: '1M tokens', text: '$0.10 per 1M input tokens, nothing for output' }, SOURCES.geminiDecision,
            { why: 'calibrated and fast', note: 'Google\'s Decisions API answers in one pass, with calibrated probabilities. It has a free tier, which may use what it reads to improve Google\'s products: test with public or synthetic data. Without a Gemini key, the cheap structured route below answers text instead, uncalibrated.' }),
        // The fallback route's own model: Gemini Decision 1 is Google's Decisions API, not a chat model, so it never sits
        // on decide.fallback; the route gets the cheap structured model and the Decisions API needs only the Gemini key.
        routeOffer: offer('deepseek', 'deepseek-flash', 'DeepSeek Flash', tokenPrice(0.15, 0.6, 0.003), SOURCES.deepseek),
        alternatives: [
            offer('altare', 'gemma-4-26b', 'Gemma 4 26B on Altare', tokenPrice(0.1, 0.3, 0.05), SOURCES.altare, { why: 'free until December 1', note: ALTARE_NOTE }),
            offer('deepseek', 'deepseek-flash', 'DeepSeek Flash', tokenPrice(0.15, 0.6, 0.003), SOURCES.deepseek),
        ],
    },
]);

const BY_ID = new Map(STEPS.map((s) => [s.id, s]));

/** What each kind is called in the defaults table, in the page's words. */
const KIND_LABELS = Object.freeze({
    chat: 'Chat and writing', vision: 'Vision', image: 'Images', stt: 'Speech to text',
    speech: 'Voices', embedding: 'Embeddings', search: 'Web search', code: 'Code agents (plans)', decide: 'Decisions',
});

function stepById(id) {
    return BY_ID.get(String(id || '')) || null;
}

/** Every offer a step shows: the recommended one first, then the alternatives. */
function offersOf(step) {
    return [step.recommended, ...(step.alternatives || [])];
}

/** The key page for an offer's provider, with the line that says what to press there. */
function keyPageOf(provider) {
    if (!provider) return null;
    try {
        const page = keyPage(provider);
        return page && page.get_it_at ? { url: page.get_it_at, how: page.get_it_how || 'Sign in, open the API keys page and create a key.' } : null;
    } catch {
        return null;
    }
}

module.exports = { STEPS, BY_ID, KIND_LABELS, stepById, offersOf, keyPageOf, CHECKED };
