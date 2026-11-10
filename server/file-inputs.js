'use strict';
const { AiError } = require('./util');

const MAX_FILES = 10;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;
const MEDIA_ID = /^med_[0-9A-HJKMNP-TV-Z]{26}$/;

/** Resolve bounded Media references into model message content. File bytes never enter run storage. */
async function attachFiles(input, fetcher, { signal } = {}) {
    const files = Array.isArray(input.files) ? input.files : [];
    if (!files.length) return input;
    if (files.length > MAX_FILES) throw new AiError(413, 'files.too_many', `at most ${MAX_FILES} files may be attached to a turn`);
    let total = 0;
    const additions = [];
    for (const file of files) {
        const id = String(file && (file.media_id || file.id) || '');
        const name = String(file && file.name || 'unnamed file').slice(0, 255);
        const declaredType = String(file && (file.media_type || file.type) || 'application/octet-stream').slice(0, 255);
        if (!MEDIA_ID.test(id)) throw new AiError(422, 'files.invalid', `file ${name} must reference a stored Media object`);
        const { buffer, contentType } = await fetcher.fetchUrl(fetcher.mediaRefUrl({ media_id: id }), { signal, maxBytes: MAX_FILE_BYTES, timeoutMs: 30000 });
        total += buffer.length;
        if (total > MAX_TOTAL_BYTES) throw new AiError(413, 'files.too_large', 'attached files exceed the 25 MiB total limit');
        const type = (contentType || declaredType).split(';')[0].toLowerCase();
        if (/^(text\/(plain|markdown|csv|javascript|x-python)|application\/(json|javascript|xml)|text\/x-)/.test(type) || /\.(txt|md|csv|json|js|ts|py|html|css|xml|yaml|yml|log)$/i.test(name)) {
            additions.push({ type: 'text', text: `\n\n[Attached file: ${name} (${type})]\n${buffer.toString('utf8').slice(0, 200000)}` });
        } else if (/^image\/(png|jpeg|webp|gif)$/.test(type)) {
            additions.push({ type: 'image_url', image_url: { url: `data:${type};base64,${buffer.toString('base64')}` } });
        } else {
            additions.push({ type: 'text', text: `\n\n[Attached file: ${name} (${type}); could not read this type.]` });
        }
    }
    const messages = Array.isArray(input.messages) ? input.messages.map(x => ({ ...x })) : [];
    let index = messages.map(x => x.role).lastIndexOf('user');
    if (index < 0) { messages.push({ role: 'user', content: '' }); index = messages.length - 1; }
    const content = messages[index].content;
    messages[index].content = Array.isArray(content)
        ? [...content, ...additions]
        : [{ type: 'text', text: String(content || '') }, ...additions];
    return { ...input, messages };
}

module.exports = { attachFiles, MAX_FILES, MAX_FILE_BYTES, MAX_TOTAL_BYTES };
