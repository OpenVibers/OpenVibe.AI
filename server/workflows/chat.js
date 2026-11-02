'use strict';
/**
 * OpenVibe.Chat's AI members (owner 2026-09-28, Q14: friend groups and couples with AI members; Q15: a Food household's
 * chat with an AI member that knows the pantry). A room's people add an AI member with a name and how they want it to
 * be; when someone names it in the room, Chat sends this workflow the room's recent messages, the notes the room keeps
 * for it, and any shared context a linked service gave the room (Food: the household's pantry and plan), and posts
 * the answer as the AI member.
 *
 *   chat.member.reply   namespace chat (Network grants Chat ai.run.create/read on chat.*), route chat.member
 *                       (an alias of default.chat: the shared provider, falling over to the local model), text out.
 *
 * Chat renders the transcript itself (one line per message, oldest first), so the template takes plain strings.
 *
 *   chat.member.turn    the same member with tools (the owner's "modular AI conversation… tool calling"): Chat sends a
 *                       Chat Completions request (its own system message, the transcript, the tools it can run: search
 *                       the network, the time, dice, a household's pantry) and gets the choices back, tool calls
 *                       included; Chat runs the tools and sends the results in the next turn, a few turns at most.
 *                       The same passthrough as ai.complete (the prompt is not kept), in Chat's namespace and on its
 *                       route, so Chat's grant and quota apply; with a person's own key it goes to their provider.
 */
const core = require('./core');

const STR = (n) => ({ type: 'string', maxLength: n });
const OBJ = (props, required) => ({ type: 'object', additionalProperties: false, required: required || Object.keys(props), properties: props });

const templates = [
    {
        key: 'chat.member.reply', name: 'Chat: an AI member answers in a room',
        description: 'One reply from an AI member a room added, to the person who named it, from the recent messages, the room\'s notes and shared context.',
        input_schema: { type: 'object' },
        output_schema: OBJ({ text: { type: 'string' } }),
        system_prompt: [
            'You are {{ai_name}}, an AI member of the chat room "{{room}}" on OpenVibe.Chat. The people in the room added you to their conversation.',
            '{{#persona}}How they want you to be: {{persona}}{{/persona}}',
            '',
            'How you answer:',
            '- Like a member of the conversation: natural, warm and to the point, in the language the person wrote in. Usually a few sentences; a list or a recipe when that is what they asked for. Plain text, no headings.',
            '- Answer the person who named you. Use the earlier messages, the room\'s notes and the shared context when they help.',
            '- Never invent facts about the people, their plans or their things (what is in their pantry, their budget, their schedule) beyond what the messages, notes and context say. When you do not know, say so and ask.',
            '- You can only write in this chat. Do not claim to have done anything else (bought, booked, sent, saved, set a reminder).',
            '- No threats, nothing sexual involving minors, and never anyone\'s private details. Swearing in jest is fine if the room does it.',
        ].join('\n'),
        user_prompt: [
            '{{#context}}Shared context ({{context_source}}):\n{{context}}\n\n{{/context}}',
            '{{#memory}}The room\'s notes for you:\n{{memory}}\n\n{{/memory}}',
            'Recent messages, oldest first:\n{{transcript}}\n\n',
            '{{asked_by}} just wrote to you: {{message}}\n\n',
            'Write your reply as {{ai_name}}. Return only the reply.',
        ].join(''),
        default_route: 'chat.member', owner: 'chat', metadata: {},
    },
];

const workflows = [
    {
        key: 'chat.member.reply', name: 'Chat: an AI member answers in a room', namespace: 'chat',
        description: 'A room\'s AI member answers the person who named it. Chat sends the transcript, the room\'s notes and any shared context (Food\'s pantry and plan for a household room).',
        input_schema: OBJ({
            ai_name: STR(40), persona: STR(1000), room: STR(120),
            memory: STR(2000), context: STR(4000), context_source: STR(80),
            transcript: STR(12000), asked_by: STR(80), message: STR(2000),
        }, ['ai_name', 'room', 'transcript', 'asked_by', 'message']),
        output_schema: OBJ({ text: { type: 'string' } }),
        steps: [{ kind: 'llm', template: 'chat.member.reply', operation: 'chat', output: 'text', params: { max_tokens: 600, temperature: 0.7, timeout_ms: 25000 } }],
        default_route: 'chat.member', cache_mode: 'none', metadata: { seed: true },
    },
    {
        key: 'chat.vibe.listen', name: 'Chat: transcribe a short spoken message', namespace: 'chat',
        description: 'Vibe by voice in the Dock where the browser has no speech recognition: a short recording (audio/webm, audio/ogg or audio/mp4) arrives inline and whisper.cpp/Parakeet on this host (route live.stt) returns the text. The audio is never stored.',
        input_schema: OBJ({
            audio: {
                type: 'object', additionalProperties: false, required: ['data_url'],
                properties: {
                    data_url: { type: 'string', maxLength: 1500000 },
                    mime: { enum: ['audio/webm', 'audio/ogg', 'audio/mp4'] },
                },
            },
            language: { type: 'string', pattern: '^[a-z]{2}$' },
        }, ['audio']),
        output_schema: OBJ({
            text: { type: 'string' },
            language: STR(8),
            segments: { type: 'array', items: { type: 'object', required: ['start', 'end', 'text'], properties: { start: { type: 'number' }, end: { type: 'number' }, text: { type: 'string' } } } },
        }, ['text']),
        steps: [{ kind: 'transcribe', route: 'live.stt' }],
        cache_mode: 'none', metadata: { seed: true, retain_input: false },
    },
    {
        key: 'chat.member.turn', name: 'Chat: an AI member\'s turn, with tools', namespace: 'chat',
        description: 'One turn of a room\'s AI member as a Chat Completions request with the tools Chat runs (network search, the time, dice, a household\'s pantry); the choices come back with any tool calls. The prompt is not kept.',
        input_schema: core.workflows.find((w) => w.key === 'ai.complete').input_schema,
        output_schema: core.workflows.find((w) => w.key === 'ai.complete').output_schema,
        metadata: { passthrough: true, seed: true },
        steps: [{ kind: 'complete', route: 'chat.member' }], cache_mode: 'none', default_route: 'chat.member',
    },
];

module.exports = { templates, workflows };
