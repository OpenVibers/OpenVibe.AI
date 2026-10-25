'use strict';
/**
 * DeepSeek's Search and Fetch APIs (api-docs.deepseek.com/guides/search): web search with page summaries and text,
 * and any page as Markdown, fetched by DeepSeek (never from this host). $0.75 per 1,000 successful calls each, from
 * the same balance as the account's tokens; an empty search or a failed call is not billed.
 *
 * Spend is bounded twice: a daily cap on calls (AI_RESEARCH_DEEPSEEK_DAILY) and the provider standing down on its own
 * answers: 402 (balance used up) for 30 minutes, 401 (key refused) for an hour, 429 for a minute.
 */
const { clip, canonicalUrl } = require('./text');

const PRICE_PER_CALL_USD = 0.00075;

function createDeepseek({ http, key, base = 'https://api.deepseek.com', dailyCap = 1500, now = () => Date.now(), log = console }) {
    const state = { day: '', used: 0, downUntil: 0, reason: null };
    const today = () => new Date(now()).toISOString().slice(0, 10);

    function available() {
        if (!key) return false;
        if (state.day !== today()) { state.day = today(); state.used = 0; }
        return now() >= state.downUntil && state.used < dailyCap;
    }

    function status() {
        if (!key) return { configured: false };
        available();
        return { configured: true, used_today: state.used, daily_cap: dailyCap, down_until: state.downUntil > now() ? new Date(state.downUntil).toISOString() : null, reason: state.downUntil > now() ? state.reason : null };
    }

    function standDown(ms, reason) {
        state.downUntil = now() + ms;
        state.reason = reason;
        log.warn && log.warn(`[research] deepseek stands down for ${Math.round(ms / 1000)} s: ${reason}`);
    }

    async function call(path, body, signal) {
        if (!available()) throw Object.assign(new Error(state.reason || 'daily cap reached'), { status: 503 });
        state.used += 1;
        const r = await http.request(`${base}${path}`, { method: 'POST', body, headers: { Authorization: `Bearer ${key}` }, signal, timeout: 20000 });
        if (r.status === 402) { standDown(30 * 60000, 'balance used up'); throw Object.assign(new Error('DeepSeek balance used up'), { status: 402 }); }
        if (r.status === 401) { standDown(60 * 60000, 'key refused'); throw Object.assign(new Error('DeepSeek refused the key'), { status: 401 }); }
        if (r.status === 429) { standDown(60000, 'rate limited'); throw Object.assign(new Error('DeepSeek rate limit'), { status: 429 }); }
        if (r.status !== 200 || !r.json) throw Object.assign(new Error(`DeepSeek answered ${r.status}`), { status: r.status });
        return r.json;
    }

    /** Web search: [{ url, title, site, snippet, summary, content, date, authority, score }]. */
    async function search(query, { count = 8, needContent = true, question = null, signal } = {}) {
        const body = { query: String(query).slice(0, 128), count, need_content: needContent };
        if (question) body.ori_question = String(question).slice(0, 128);
        const j = await call('/v1/tools/search', body, signal);
        // DeepSeek numbers repeated hits on one page with a fragment ("…#1"): the page is the same without it.
        return (j.results || []).filter((r) => r && canonicalUrl(r.url)).map((r) => ({
            url: String(r.url).replace(/#\d+$/, ''),
            title: String(r.title || '').slice(0, 300),
            site: r.site_name || null,
            snippet: String(r.snippet || '').slice(0, 400),
            summary: String(r.summary || ''),
            content: String(r.content || ''),
            date: r.date || null,
            authority: Number.isInteger(r.authority) ? r.authority : -1,
            score: Number(r.rerank_score) || 0,
        }));
    }

    /** One page as Markdown, fetched by DeepSeek. */
    async function fetchPage(url, { chars = 6000, signal } = {}) {
        const j = await call('/v1/tools/fetch', { url }, signal);
        return { title: String(j.title || ''), content: clip(String(j.content || ''), chars) };
    }

    return { available, status, search, fetchPage, PRICE_PER_CALL_USD };
}

module.exports = { createDeepseek, PRICE_PER_CALL_USD };
