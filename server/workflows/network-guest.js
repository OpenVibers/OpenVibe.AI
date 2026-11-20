'use strict';
/**
 * network.guest_answer (2026-11-20; the plan's §V.1 guests, the owner's register #801 "anons should be able to … use AI
 * features with abuse prevention, severe rate limits … a global cap"): a short answer for a visitor who is not signed
 * in, asked from the menu's box. OpenVibe.Network runs it with its own service token (namespace network.*) and does the
 * gate around it: a human check, three questions a day per guest and ten per address, and a daily budget for all
 * guests. Here: the cheapest interactive route, a hard output limit, no tools, no search, no files, plain text, and the
 * same question on the same page answered once an hour for everyone (cache by service).
 */
const STR = (n) => ({ type: 'string', maxLength: n });
const SYSTEM = [
    'You are Vibe, the assistant of OpenVibe: an open-source, community-run network of sites (live streaming on',
    'openvibe.live, chat, a community forum, video, online tools, games and more). You are answering a visitor who is not',
    'signed in. Answer the question directly and helpfully in at most 120 words, in the language the visitor used. Plain',
    'text: no headings, no tables. Do not invent facts, prices, links or features of OpenVibe; when unsure, say so in a',
    'few words. If the question needs the visitor\'s own account, messages, money or anything private, or web search, a',
    'file, a tool or a long piece of work, answer what you can and add one short sentence that signing in (free) lets',
    'Vibe do that. Never write sexual content involving minors, hate against a group, or instructions that help someone',
    'cause harm.',
    // 11-20: the first answer in production did not know OpenVibe ("I'm not sure of the exact browser go-live flow"):
    // the facts a visitor asks about most, so the cheapest model answers them right.
    'Facts you may use (only these; do not name other OpenVibe sites or features): Anyone can go live from the browser on',
    'openvibe.live: press Go live, allow the camera and microphone (or share a screen) and start; no OBS, no download and',
    'no follower minimum. OBS and other encoders also work (RTMP or WHIP), and the guide is',
    'https://openvibe.live/docs/go-live-in-your-browser. One free account works on every OpenVibe site; sign in from the',
    'menu (the round button at the top of every site), which also searches every site and asks Vibe. Visitors may ask',
    'Vibe three questions a day; a free account asks up to 100 a day and keeps its history. The sites: openvibe.live (live',
    'streams, replays and clips), openvibe.chat (chat rooms, messages and Vibe), openvibe.games (games), openvibe.tools',
    '(online tools), openvibe.codes (writing code with AI), openvibe.actor (AI agents that work for you), openvibe.network',
    '(your account and wallet).',
].join(' ');
const template = {
    key: 'network.guest_answer', name: 'Network: a guest\'s question', owner: 'network', visibility: 'internal',
    description: 'A short, plain answer for a signed-out visitor from the menu\'s box. Network gates who may ask and how often.',
    input_schema: { type: 'object', additionalProperties: false, required: ['question'], properties: { question: STR(1000), context: STR(2000), site: STR(40) } },
    output_schema: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string' } } },
    system_prompt: SYSTEM,
    user_prompt: 'OpenVibe site the visitor is on: {{site}}\nWhat they are looking at (may be empty): {{context}}\n\nTheir question: {{question}}',
    default_route: 'network.guest',
};
const workflow = {
    key: 'network.guest_answer', name: 'A short answer for a signed-out visitor', namespace: 'network', owner: 'network',
    description: 'One question, one short plain answer on the cheapest interactive route; no tools, search or files.',
    input_schema: template.input_schema, output_schema: template.output_schema, default_route: 'network.guest',
    steps: [{ kind: 'llm', template: 'network.guest_answer', operation: 'generate', output: 'text', params: { max_tokens: 450, temperature: 0.3, timeout_ms: 30000 } }],
    cache_mode: 'service', cache_ttl_sec: 3600,
    // Low effort: a reasoning model on the default (medium) spent its tokens thinking (products.js, 11-14), and the first
    // guest answer took 10 s on gpt-5-nano.
    metadata: { effort: 'low' },
};
/** The route's pool settings (seed.js): cheapest model that answers interactively, 450 tokens at most. */
const ROUTE = { timeoutMs: 30000, settings: { constraints: { objective: 'cheapest', latency_class: 'interactive' }, options: { temperature: 0.3 }, max_output_tokens: 450 } };

module.exports = { templates: [template], workflows: [workflow], ROUTE, SYSTEM };
