'use strict';
/** Text helpers for research: HTML to readable text, clipping at a boundary, canonical URLs, image licences. */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', middot: '·', times: '×' };

function decodeEntities(s) {
    return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
        if (e[0] === '#') {
            const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
            return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
        }
        return ENTITIES[e.toLowerCase()] ?? m;
    });
}

function stripTags(html) {
    return decodeEntities(String(html || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * MediaWiki article HTML (Fandom's parse output) to readable text: infobox rows become "Label: value" lines, headings
 * become "## Heading", list items "- item"; scripts, references, navigation boxes and tables of contents are dropped.
 */
function articleText(html) {
    let h = String(html || '');
    h = h.replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<sup\b[^>]*class="[^"]*reference[^"]*"[\s\S]*?<\/sup>/gi, '')
        .replace(/<(table|div|nav)\b[^>]*class="[^"]*\b(navbox|toc|mw-references-wrap|references|printfooter|catlinks|mbox)\b[^"]*"[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<h[23]\b[^>]*class="[^"]*pi-(?:data-label|secondary-heading)[^"]*"[^>]*>([\s\S]*?)<\/h[23]>\s*<div\b[^>]*class="[^"]*pi-data-value[^"]*"[^>]*>([\s\S]*?)<\/div>/gi,
            (_m, label, value) => `\n${stripTags(label)}: ${stripTags(value.replace(/<br\s*\/?>/gi, ', ').replace(/<\/li>/gi, ', ')).replace(/,\s*$/, '')}\n`)
        .replace(/<h2\b[^>]*class="[^"]*pi-title[^"]*"[^>]*>([\s\S]*?)<\/h2>/gi, (_m, t) => `\n${stripTags(t)}\n`)
        .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n, t) => `\n\n${'#'.repeat(Math.min(Math.max(Number(n), 2), 4))} ${stripTags(t)}\n`)
        .replace(/<li\b[^>]*>/gi, '\n- ')
        .replace(/<\/(p|div|tr|ul|ol|table|aside|figure|blockquote|dd|dt)>/gi, '\n')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/t[dh]>/gi, ' · ');
    const lines = decodeEntities(h.replace(/<[^>]*>/g, '')).split('\n').map((l) => l.replace(/[ \t ]+/g, ' ').replace(/(?: · )+$/, '').trim());
    const out = [];
    for (const l of lines) {
        if (!l) { if (out.length && out[out.length - 1] !== '') out.push(''); continue; }
        if (/^#{2,4} (?:References|Notes|External links|See also|Gallery|Navigation|Sources|Appearances)$/i.test(l)) { out.push(l); continue; }
        out.push(l);
    }
    // Drop the trailing reference-ish sections entirely: they are lists of links, not facts.
    const text = out.join('\n').replace(/\n#{2,4} (?:References|Notes|External links|Navigation|Sources)\n[\s\S]*?(?=\n#{2,4} |$)/gi, '\n');
    return text.replace(/\n{3,}/g, '\n\n').trim();
}

/** MediaWiki plain extract with exsectionformat=wiki ("== Heading ==") to "## Heading" Markdown-ish text. */
function extractText(text) {
    return String(text || '')
        .replace(/^(={2,5})\s*(.+?)\s*\1\s*$/gm, (_m, eq, t) => `${'#'.repeat(Math.min(eq.length, 4))} ${t}`)
        .replace(/\n#{2,4} (?:References|Notes|External links|Further reading|Citations|Sources|Bibliography)\n[\s\S]*?(?=\n#{2,4} |$)/gi, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/** Cut text at about n characters, at the last paragraph or sentence end before it. */
function clip(text, n) {
    const t = String(text || '').trim();
    if (t.length <= n) return t;
    const cut = t.slice(0, n);
    const para = cut.lastIndexOf('\n\n');
    if (para > n * 0.6) return cut.slice(0, para).trim();
    const sentence = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('.\n'), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    if (sentence > n * 0.6) return cut.slice(0, sentence + 1).trim();
    return `${cut.replace(/\s+\S*$/, '')}…`;
}

/** One spelling per page: https, lowercase host without www. or a Wikipedia mobile prefix, no fragment or tracking query. */
function canonicalUrl(u) {
    try {
        const url = new URL(String(u));
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
        url.protocol = 'https:';
        url.hash = '';
        url.hostname = url.hostname.toLowerCase().replace(/^www\./, '').replace(/^([a-z-]+)\.m\.(wikipedia|wiktionary|wikiquote)\.org$/, '$1.$2.org');
        for (const k of [...url.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$|ref$|ref_src$)/i.test(k)) url.searchParams.delete(k);
        return url.toString().replace(/\/$/, '');
    } catch { return null; }
}

function hostOf(u) {
    try { return new URL(String(u)).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

// Licences anyone may reuse with credit (commercial use and unchanged copies included): CC0, public domain, CC BY,
// CC BY-SA, GFDL and the like. NonCommercial and NoDerivatives licences are not counted as free here.
const FREE_LICENSE = /^(cc0|cc[- ]?zero|public domain|pd(?:m|-|\b)|no restrictions|attribution|cc[- ]by(?:-sa)?(?![- ]?n[cd])\b|gfdl|fal\b|free art|ogl|copyrighted free use)/i;

function isFreeLicense(name) {
    const n = String(name || '').trim();
    return Boolean(n) && FREE_LICENSE.test(n) && !/\b(nc|nd|non-?commercial|no ?deriv)/i.test(n) && !/fair use|non-?free/i.test(n);
}

module.exports = { decodeEntities, stripTags, articleText, extractText, clip, canonicalUrl, hostOf, isFreeLicense };
