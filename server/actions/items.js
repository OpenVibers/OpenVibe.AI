'use strict';

/**
 * AI's Action Center items (plan 2026-10-28 §3.10, common.action-item@1): runs made on one person's behalf
 * (on_behalf_of), mapped from the run's own status to the five Action Center buckets. bucketFor() is exported on its
 * own so its state table can be tested.
 */

const PUBLIC_ORIGIN = 'https://ai.openvibe.services';
const ENTITIES = Object.freeze({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' });

const STATUS_BUCKET = Object.freeze({
    queued: 'running',
    running: 'running',
    waiting: 'waiting',   // reserved for a workflow that needs the person; AI has none today
    succeeded: 'done',
    cached: 'done',
    failed: 'failed',
    cancelled: 'failed',
});

function bucketFor(status) {
    return STATUS_BUCKET[status] || 'failed';
}

/**
 * What the person may do from the list (common.action-item@1.actions). The item opens the run receipt.
 * Cancel and retry are not offered: Network has no AI decide route, and AI would need a delegated
 * person principal to authorize them.
 */
function actionsFor() {
    return ['open'];
}

/** Plain text (no HTML or Markdown), single line, at most `max` characters. */
function plain(value, max = 400) {
    let s = value == null ? '' : String(value);
    s = s.replace(/```[\s\S]*?```/g, ' ').replace(/<\/?[^>]+>/g, ' ')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/&([a-zA-Z#0-9]+);/g, (m, k) => (Object.hasOwn(ENTITIES, k) ? ENTITIES[k] : m))
        .replace(/[`*_~]+/g, '').replace(/^[#>\s-]+/gm, '')
        .replace(/\s+/g, ' ').trim();
    if (s.length > max) s = `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
    return s;
}

/** The readable outcome a run's output carries, when it carries one. */
function summaryOf(output) {
    if (typeof output === 'string') return output;
    if (!output || typeof output !== 'object' || Array.isArray(output)) return '';
    for (const key of ['answer', 'text', 'summary', 'content']) if (typeof output[key] === 'string') return output[key];
    return '';
}

function runPage(id) {
    return `${PUBLIC_ORIGIN}/runs/${encodeURIComponent(id)}`;
}

function toItem(run, workflow = null) {
    const bucket = bucketFor(run.status);
    const detail = run.error ? (run.error.detail || run.error.code || '') : '';
    const summary = detail || summaryOf(run.output);
    return {
        service: 'ai',
        id: run.id,
        kind: 'ai_run',
        title: plain((workflow && workflow.name) || (run.workflow && run.workflow.key) || run.id, 160) || run.id,
        summary: summary ? plain(summary, 400) : null,
        bucket,
        state: run.status,
        agent: run.provenance && run.provenance.model ? plain(run.provenance.model, 80) : null,
        cost_usd: run.usage && Number.isFinite(Number(run.usage.cost_usd)) ? Number(run.usage.cost_usd) : null,
        steps: null,   // AI keeps token/attempt counts, not tool-call steps
        error: detail ? plain(detail, 400) : null,
        created_at: run.created_at,
        updated_at: run.finished_at || run.started_at || run.created_at,
        href: runPage(run.id),
        actions: actionsFor(bucket),
    };
}

module.exports = { PUBLIC_ORIGIN, bucketFor, actionsFor, plain, summaryOf, runPage, toItem };
