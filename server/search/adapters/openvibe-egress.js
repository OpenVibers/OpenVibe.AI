'use strict';
/**
 * OpenVibe's own page reader (free): one public page as text, through the guarded fetch (public addresses only, checked
 * at connect time, 8 MB cap).
 *
 * 11-20 on production: most standard searches read no page at all. The reader sent no User-Agent (Wikipedia refuses
 * those), treated every redirect as a failure (the guarded fetch follows none), could not read an http:// result, and
 * each page that refused it tripped the breaker of the whole reader for a minute, so one picky site switched page
 * reading off for every search. Now:
 *   - it names itself (OpenVibeReader, with the page it is for);
 *   - http:// is read as https://, and up to 4 redirects are followed, each hop through the guarded fetch again (so a
 *     redirect can never lead it inside the network);
 *   - a page that refuses (a status, a redirect loop, a page too large) fails that read only: the error carries
 *     `target`, which the breaker does not count. A failure of the reader itself (the network, a timeout) still does.
 */
const { guardedFetch } = require('../../providers/guarded-fetch');

const UA = 'Mozilla/5.0 (compatible; OpenVibeReader/1.0; +https://openvibe.exchange/search)';
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_HOPS = 4;
const pageRefused = (message) => Object.assign(new Error(message), { target: true, unbilled: true });

/** The page's URL as the reader asks for it: https, never credentials. */
function httpsOf(raw) {
    let u;
    try { u = new URL(String(raw)); } catch { return null; }
    if (u.protocol === 'http:') u.protocol = 'https:';
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    return u;
}

module.exports = {
    id: 'openvibe-egress', kinds: ['fetch'], class: 'page_reader', byok: false,
    source: 'https://openvibe.exchange', freshness: [],
    async read(b, { fetchImpl = guardedFetch }) {
        let url = httpsOf(b.url);
        if (!url) throw pageRefused('The page is not a public web address');
        const signal = AbortSignal.timeout(10000);
        for (let hop = 0; ; hop++) {
            let r;
            try {
                r = await fetchImpl(url.href, { signal, redirect: 'manual', headers: { accept: 'text/html,text/plain;q=0.9,*/*;q=0.5', 'accept-language': 'en;q=0.9,*;q=0.5', 'user-agent': UA } });
            } catch (err) {
                // The guard refusing an address, or a page past the size cap, is the page's doing; anything else is the reader's.
                if (err && (err.code === 'EADDRNOTPUBLIC' || err.code === 'EBADSTATUS' || /too large/.test(err.message || ''))) throw pageRefused(err.message);
                throw err;
            }
            if (REDIRECTS.has(r.status)) {
                const to = r.headers.get('location');
                if (!to || hop >= MAX_HOPS) throw pageRefused(hop >= MAX_HOPS ? 'The page redirected too many times' : 'The page redirected nowhere');
                url = httpsOf(new URL(to, url).href);
                if (!url) throw pageRefused('The page redirected off the public web');
                continue;
            }
            if (!r.ok) throw pageRefused(`The page answered ${r.status}`);
            const type = (r.headers.get('content-type') || '').toLowerCase();
            if (type && !/text\/|html|xml|json/.test(type)) throw pageRefused('The page is not text');
            const html = await r.text();
            return {
                text: html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
                    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|br)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n')
                    .replace(/<[^>]*>/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n'),
                cost: 0,
                url: url.href,
            };
        }
    },
    _test: { httpsOf, UA },
};
