'use strict';
/**
 * Files a model produced on a turn, returned as stored files (ai.file@1, role 'artifact').
 *
 * A provider can answer with files beside its text: each entry names a Media object it already stored
 * (the reference shape), which is returned as it is. A provider that hands back the bytes themselves
 * (`data`/`b64`) needs a Media store in this service: `store.put({ name, media_type, bytes, subject })`
 * returns the stored ai.file@1. When no store is configured such a file is REFUSED with
 * files.store_unavailable, never dropped and never put in the run output as inline bytes. The store is
 * configured by the operator (a Media tenant AI may write to); nothing here pretends to have one.
 */
const { AiError } = require('./util');

const MAX_ARTIFACTS = 10;
const MEDIA_ID = /^med_[0-9A-HJKMNP-TV-Z]{26}$/;

function storedRef(file) {
    const id = String((file && file.id) || (file && file.storage && file.storage.key) || '');
    if (!MEDIA_ID.test(id)) return null;
    const name = String((file && file.name) || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 255) || 'file';
    const mediaType = String((file && file.media_type) || 'application/octet-stream').split(';')[0].trim().slice(0, 255) || 'application/octet-stream';
    const size = Math.max(0, Math.floor(Number(file && file.size) || 0));
    return {
        id, name, media_type: mediaType, size,
        storage: { provider: 'media', key: id },
        access: { readers: Array.isArray(file && file.access && file.access.readers) && file.access.readers.length ? file.access.readers.map(String).slice(0, 50) : [] },
        read: { method: 'not_readable', reason: 'Stored by Media; read it by reference.' },
        role: 'artifact',
    };
}

/** The store a run may write to (config.media.artifactStore with put(), or null). */
function storeOf(config) {
    const s = config && config.media && config.media.artifactStore;
    return s && typeof s.put === 'function' ? s : null;
}

/**
 * The files a provider's message carries, as stored ai.file@1 artifacts.
 * message.artifacts (or message.files) is the list; each is either a Media reference or inline bytes.
 */
async function collectArtifacts(message, { store = null, subject = null } = {}) {
    const raw = message && (Array.isArray(message.artifacts) ? message.artifacts : Array.isArray(message.files) ? message.files : []);
    if (!raw.length) return [];
    if (raw.length > MAX_ARTIFACTS) throw new AiError(413, 'files.too_many', `a model may return at most ${MAX_ARTIFACTS} files`);
    const out = [];
    for (const file of raw) {
        const ref = storedRef(file);
        if (ref) { out.push(ref); continue; }
        const bytes = Buffer.isBuffer(file && file.bytes) ? file.bytes
            : typeof (file && (file.data || file.b64)) === 'string' ? Buffer.from(file.data || file.b64, file.encoding === 'utf8' ? 'utf8' : 'base64')
                : null;
        if (!bytes) throw new AiError(422, 'files.invalid', `a model returned a file without bytes or a Media reference: ${String((file && file.name) || 'unnamed').slice(0, 80)}`);
        if (!store) throw new AiError(503, 'files.store_unavailable', 'a model produced a file but AI has no Media store configured to keep it');
        out.push(await store.put({ name: file.name, media_type: file.media_type || file.type, bytes, subject }));
    }
    return out;
}

module.exports = { collectArtifacts, storeOf, MAX_ARTIFACTS };
