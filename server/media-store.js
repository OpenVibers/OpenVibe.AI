'use strict';
/**
 * Pictures into OpenVibe.Media (media.object.upload, the AI tenant): init, bytes, complete (the v2
 * object API). Every picture the image task returns is a Media reference (`med_…`), never inline
 * bytes in the run's output: the editor attaches the id, and Media owns the bytes, its visibility
 * and its licence metadata.
 *
 * A picture is uploaded for the person the run acts for (`X-OV-Subject`) when there is one; a
 * service-only find (a guest, when the owner allows it) belongs to the AI tenant. Off unless
 * OV_MEDIA_INTERNAL_URL and the service secret are both configured.
 */
const crypto = require('crypto');
const { createServiceTokenClient } = require('openvibe-sdk/auth');

const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;

function createMediaStore({ config, env = process.env, fetchImpl = globalThis.fetch, tokens = null, log = console } = {}) {
    const media = (config && config.media) || {};
    const baseUrl = String(media.internalUrl || '').replace(/\/+$/, '');
    const app = media.app || 'ai';
    let client = tokens;
    const tokenClient = () => {
        if (client) return client;
        const secret = env.OV_OAUTH_CLIENT_SECRET;
        if (!baseUrl || !secret) return null;
        client = createServiceTokenClient({
            tokenUrl: `${String(config.networkInternalUrl).replace(/\/+$/, '')}/oauth/token`,
            clientId: env.OV_OAUTH_CLIENT_ID || 'ai', clientSecret: secret,
            audience: 'openvibe.media', scope: 'media.object.upload', fetch: fetchImpl,
        });
        return client;
    };
    const configured = () => Boolean(baseUrl && (client || env.OV_OAUTH_CLIENT_SECRET || tokens));

    /** The object's public bytes URL, what a figure block and an editor preview use. */
    function publicUrl(mediaId) {
        return mediaId ? `${String(media.publicUrl || 'https://openvibe.media').replace(/\/+$/, '')}/o/${encodeURIComponent(mediaId)}` : null;
    }

    async function call(url, init, timeoutMs = 30000) {
        let res;
        try {
            res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
        } catch (err) {
            throw Object.assign(new Error(`Media did not answer: ${err && err.name === 'TimeoutError' ? 'timeout' : err && err.message}`), { status: 503, code: 'media.unavailable' });
        }
        const body = await res.json().catch(() => null);
        if (res.status < 200 || res.status > 299) {
            throw Object.assign(new Error(`Media answered ${res.status}${body && (body.code || body.title) ? ` (${body.code || body.title})` : ''}`), {
                status: res.status === 413 || res.status === 415 || res.status === 422 ? 422 : 503, code: 'media.upload_refused',
            });
        }
        return body || {};
    }

    /**
     * A picture into Media for the person the run acts for. `app` is the tenant the calling product keeps its
     * pictures in (blog, wiki, or AI's own ai); absent, the AI tenant. → { media_id, url, width, height, mime }.
     * metadata keeps where it came from (source_url, license, author) or what made it (model, ai).
     */
    async function put({ bytes, mime, filename = 'picture', owner = null, app: tenant = null, metadata = {}, visibility = 'public', timeoutMs = 30000 } = {}) {
        if (!configured()) throw Object.assign(new Error('OpenVibe.Media is not configured (OV_MEDIA_INTERNAL_URL and the AI service secret are needed)'), { status: 503, code: 'media.unavailable' });
        if (!Buffer.isBuffer(bytes) || !bytes.length) throw Object.assign(new Error('the picture has no bytes'), { status: 422, code: 'media.empty' });
        const target = tenant && /^[a-z][a-z0-9-]{1,31}$/.test(String(tenant)) ? String(tenant) : app;
        const base = `${baseUrl}/api/v2/${encodeURIComponent(target)}/objects`;
        const auth = await tokenClient().authHeaders();
        const subject = owner && SUBJECT_RE.test(owner) ? { 'X-OV-Subject': owner } : {};
        const init = await call(base, {
            method: 'POST', headers: { ...auth, ...subject, 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({
                kind: 'asset', visibility, mime_type: mime, size_bytes: bytes.length,
                filename: String(filename || 'picture').slice(0, 120), content_hash: crypto.createHash('sha256').update(bytes).digest('hex'),
                metadata,
            }),
        }, timeoutMs);
        const id = init.id || (init.object && init.object.id);
        const up = init.upload || {};
        if (!id || !up.url) throw Object.assign(new Error('Media did not give an upload address'), { status: 503, code: 'media.upload_refused' });
        // The upload and complete addresses may name Media's public origin; AI reaches it on the internal one.
        const internal = (u) => {
            const x = new URL(u, baseUrl);
            return `${baseUrl}${x.pathname}${x.search}`;
        };
        await call(internal(up.url), { method: 'PUT', headers: { ...auth, ...subject, 'Content-Type': mime, ...(up.token ? { 'X-Upload-Token': up.token } : {}) }, body: bytes }, timeoutMs);
        const done = await call(internal(up.complete_url || `${base}/${encodeURIComponent(id)}/complete`), {
            method: 'POST', headers: { ...auth, ...subject, 'Content-Type': 'application/json', Accept: 'application/json', ...(up.token ? { 'X-Upload-Token': up.token } : {}) }, body: '{}',
        }, timeoutMs);
        const object = done.object || done;
        return {
            media_id: id, url: publicUrl(id),
            width: Number.isInteger(object.width) ? object.width : null, height: Number.isInteger(object.height) ? object.height : null,
            mime: object.mime_type || mime || null,
        };
    }

    return { configured, publicUrl, put };
}

module.exports = { createMediaStore };
