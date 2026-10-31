'use strict';
/**
 * A tiny, in-process memory of the provider that last answered a prompt (L36 Y7: prefer the provider whose
 * prompt cache is already warm). The key is the person or app plus a hash of the first 2 KB of the leading
 * prompt; the value is the provider key; it expires after five minutes. Nothing is persisted, nothing leaves
 * the process, and the map is capped so it can never grow into a cache.
 */
const crypto = require('crypto');

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX = 256;
const PROMPT_BYTES = 2048;

/** A hash of the first 2 KB of a prompt. */
const hashOf = (text) => crypto.createHash('sha256').update(String(text || '').slice(0, PROMPT_BYTES)).digest('hex');

function createWarmCache({ ttlMs = DEFAULT_TTL_MS, max = DEFAULT_MAX, now = () => Date.now() } = {}) {
    const entries = new Map();   // key → { provider, at }

    function remember(subject, prompt, provider) {
        if (!provider) return;
        const key = String(subject || 'anonymous') + '|' + hashOf(prompt);
        entries.set(key, { provider, at: now() });
        while (entries.size > max) entries.delete(entries.keys().next().value);   // the oldest goes first
    }

    function get(subject, prompt) {
        const key = String(subject || 'anonymous') + '|' + hashOf(prompt);
        const hit = entries.get(key);
        if (!hit) return null;
        if (now() - hit.at > ttlMs) { entries.delete(key); return null; }
        return hit.provider;
    }

    return { remember, get, hashOf, size: () => entries.size, clear: () => entries.clear() };
}

module.exports = { createWarmCache, hashOf, DEFAULT_TTL_MS, DEFAULT_MAX, PROMPT_BYTES };
