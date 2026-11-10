'use strict';
/**
 * The network changelog's tagger (rich-content plan §9): one run reads a batch of shipped commit
 * subjects and answers, for each, what kind of change it is, one to three areas from OpenVibe's
 * fixed list and the subject in plain words (no PR number, no stage tag). OpenVibe.Blog calls it
 * through the AI task `blog.changelog.tag`, so the owner's choice for that task decides the model
 * (the cheapest good one by default) and the person can change it on Exchange.
 *
 * Housekeeping never reaches this workflow: Blog classifies library pins, merges and test-only,
 * docs-only or CI-only commits as internal itself (server/changelog/tags.js).
 */
const STR = (n) => ({ type: 'string', maxLength: n });
const OBJ = (props, required = []) => ({ type: 'object', additionalProperties: false, properties: props, required });
const AREAS = [
    'phone', 'chat', 'go-live', 'video', 'menu', 'accessibility', 'speed', 'sign-in', 'wallet', 'ai',
    'search', 'files', 'pictures', 'games', 'design', 'developer', 'machines', 'money', 'privacy', 'moderation',
    'notifications', 'feed', 'wiki', 'blog', 'community', 'meme', 'shop', 'tools', 'exchange', 'git',
];
const KINDS = ['new', 'better', 'fixed', 'internal'];

const ENTRY = OBJ({
    id: STR(80),
    service: STR(40),
    subject: STR(300),
    repo: STR(200),
    plain: STR(240),
}, ['id', 'service', 'subject']);

const template = {
    key: 'blog.changelog.tag',
    name: 'Blog: tag a shipped change',
    owner: 'blog',
    visibility: 'internal',
    description: 'Tag shipped commit subjects for the OpenVibe changelog: kind, areas and plain words.',
    input_schema: OBJ({ entries: { type: 'array', minItems: 1, maxItems: 25, items: ENTRY } }, ['entries']),
    output_schema: OBJ({ tags: { type: 'array', maxItems: 25, items: OBJ({
        id: STR(80),
        kind: { enum: KINDS },
        areas: { type: 'array', minItems: 1, maxItems: 3, uniqueItems: true, items: { enum: AREAS } },
        plain: STR(240),
    }, ['id', 'kind', 'areas', 'plain']) } }, ['tags']),
    system_prompt: `You tag the changes OpenVibe ships, for the public "recent changes" feed. For every entry, answer:
- kind: "new" when people can now do something they could not before; "better" when an existing thing was improved; "fixed" when a defect was repaired; "internal" only for housekeeping a person would not notice (never for a feature or a fix).
- areas: one to three of exactly these ids, the parts of the product the change touches: ${AREAS.join(', ')}. Choose the closest; never invent one. A change can be about one area only.
- plain: the subject in plain words a member would understand, without the pull request number ("(#714)"), without a stage tag ("[A6]", "[C2]"), without a version prefix and without hype. Keep the names, numbers and facts the subject states; add none. At most 240 characters, one line.
Answer with JSON only: {"tags":[{"id":"<the entry's id>","kind":"...","areas":["..."],"plain":"..."}]}, one object per entry, in the same order. Never drop or add an entry.`,
    user_prompt: 'Entries to tag:\n{{json entries}}\n\nAnswer with the JSON object only.',
    default_route: 'default.json',
    metadata: { json_name: 'tags' },
};

const workflow = {
    key: 'blog.changelog.tag',
    name: 'Tag a batch of shipped changes',
    namespace: 'blog',
    owner: 'blog',
    description: 'Tag up to 25 shipped commit subjects with a kind, one to three areas and plain words.',
    input_schema: template.input_schema,
    output_schema: template.output_schema,
    default_route: 'default.json',
    steps: [{ kind: 'llm', template: 'blog.changelog.tag', operation: 'generate', output: 'json', params: { max_tokens: 2200, temperature: 0 } }],
    metadata: { internal: true },
};

module.exports = { templates: [template], workflows: [workflow], KINDS, AREAS };
