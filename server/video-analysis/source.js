'use strict';
/**
 * Where the video comes from, and whether the requester may read it.
 *
 * A video.analyze run reads one video, and only a video OpenVibe.Media holds:
 *
 *   media_id       a Media object. AI asks Media for a signed download URL as the run's owner; Media
 *                  answers 404 for an object that owner may not read, so Media decides who may read
 *                  what. Nothing else is asked of it.
 *   attachment_id  a composer attachment (Media's own attachments API, composer.attachment@1). Its id
 *                  is unguessable and Media serves the bytes under it; Media answers 404 when there is
 *                  no such attachment.
 *   url            a Media URL: the origin must be Media's own public origin (or the internal one the
 *                  service is configured with). Any other URL is refused: this workflow never fetches
 *                  a video from the open internet.
 *
 * The bytes are copied to the work directory before ffprobe and ffmpeg see them, under a byte cap and
 * with room on the disk checked first (a full disk stops every service, so the run refuses before it
 * downloads).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { AiError } = require('../util');

const MEDIA_ID = /^med_[0-9A-HJKMNP-TV-Z]{26}$/;

/** The origin of a URL, or null when it is not one. */
function originOf(url) {
    try { return new URL(String(url)).origin; } catch { return null; }
}

function createSource({ config = {}, mediaStore = null, fetchImpl = globalThis.fetch, log = console } = {}) {
    const media = config.media || {};
    const cfg = config.videoAnalysis || {};
    const publicOrigin = String(media.publicUrl || 'https://openvibe.media').replace(/\/+$/, '');
    const internalOrigin = media.internalUrl ? originOf(media.internalUrl) : null;

    /** Is this URL one of Media's own? */
    function isMediaUrl(url) {
        const o = originOf(url);
        if (!o) return false;
        return o === publicOrigin || (internalOrigin && o === internalOrigin);
    }

    /** The room left on the disk for the download, in bytes. */
    function roomFor(dir) {
        let free = Infinity;
        try { const st = fs.statfsSync(dir); free = st.bavail * st.bsize; } catch { /* no statfs: trust the byte cap */ }
        const reserve = cfg.reserveBytes == null ? 2 * 1024 ** 3 : cfg.reserveBytes;
        const room = free - reserve;
        if (room < 64 * 1024 ** 2) throw new AiError(503, 'media.no_space', 'not enough free disk to analyse a video right now');
        return Math.min(cfg.maxBytes || 1024 ** 3, room);
    }

    /** The bytes of a URL, into a file in the work directory. */
    async function download(url, { dir, signal = null, maxBytes }) {
        const res = await fetchImpl(url, { signal: signal || AbortSignal.timeout(cfg.fetchTimeoutMs || 20 * 60000) });
        if (res.status === 404) throw new AiError(404, 'media.not_readable', 'OpenVibe.Media does not have that video, or the requester may not read it');
        if (res.status === 401 || res.status === 403) throw new AiError(403, 'media.forbidden', 'the requester may not read this video');
        if (!res.ok) throw new AiError(503, 'media.unavailable', 'OpenVibe.Media answered ' + res.status);
        const file = path.join(dir, 'video-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.bin');
        const out = fs.createWriteStream(file);
        let size = 0;
        try {
            for await (const chunk of res.body) {
                size += chunk.length;
                if (size > maxBytes) throw new AiError(413, 'media.too_large', 'the video is larger than the read cap');
                if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
            }
        } finally {
            await new Promise((r) => out.end(r));
        }
        return { file, size };
    }

    /**
     * The video for this input: a local file, and what it came from.
     * Throws 422 for an input that is not a video AI may read; nothing is fetched from elsewhere.
     */
    async function resolve(input, { owner = null, dir, signal = null } = {}) {
        if (!dir) throw new AiError(500, 'media.unavailable', 'no work directory');
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const maxBytes = roomFor(dir);
        if (input.media_id) {
            if (!MEDIA_ID.test(String(input.media_id))) throw new AiError(422, 'input.invalid', 'media_id is not a Media object id');
            if (!mediaStore || typeof mediaStore.downloadUrl !== 'function') throw new AiError(503, 'media.unavailable', 'OpenVibe.Media is not configured on this service');
            let url;
            try { url = await mediaStore.downloadUrl(String(input.media_id), { owner }); }
            catch (err) {
                const status = err && err.status === 404 ? 404 : (err && err.status === 403 ? 403 : 503);
                const code = status === 404 ? 'media.not_readable' : (status === 403 ? 'media.forbidden' : 'media.unavailable');
                throw new AiError(status, code, err && err.message ? err.message : 'Media could not sign the video');
            }
            const got = await download(url, { dir, signal, maxBytes });
            return { file: got.file, size: got.size, mediaId: String(input.media_id), from: 'media_object' };
        }
        if (input.attachment_id) {
            const id = String(input.attachment_id);
            if (!/^[A-Za-z0-9_-]{6,80}$/.test(id)) throw new AiError(422, 'input.invalid', 'attachment_id is not an attachment id');
            const url = publicOrigin + '/a/' + encodeURIComponent(id) + '/video.mp4';
            const got = await download(url, { dir, signal, maxBytes });
            return { file: got.file, size: got.size, mediaId: null, from: 'attachment' };
        }
        if (input.url) {
            const url = String(input.url);
            if (!isMediaUrl(url)) throw new AiError(422, 'input.invalid', 'a video must be a Media object, a Media attachment or a Media URL; this one is not Media\'s');
            const got = await download(url, { dir, signal, maxBytes });
            return { file: got.file, size: got.size, mediaId: null, from: 'media_url' };
        }
        throw new AiError(422, 'input.invalid', 'a video.analyze run needs a media_id, an attachment_id or a Media url');
    }

    /** The temporary work directory for a run. */
    function workDir() {
        const dir = cfg.workDir || path.join(os.tmpdir(), 'openvibe-ai-video');
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        return dir;
    }

    return { resolve, isMediaUrl, workDir, publicOrigin, roomFor, download };
}

module.exports = { createSource, originOf, MEDIA_ID };
