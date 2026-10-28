'use strict';
/**
 * BENCH-11 (plan §4.12 and §4.7): OpenVibe.Bench's measured outcomes as routing evidence.
 *
 * Bench publishes bench.rating.changed when a board rating moves. AI keeps what it needs from each event
 * in bench_evidence — kind, category, model, provider, Elo, the confidence interval, games and the board's
 * cost per solved — and a route that opts in (learn_from_bench: true, default off) may prefer the cheapest
 * offer whose interval overlaps the leader's. A provisional rating (under 10 games) never decides a route.
 * With no evidence, select() returns the order it was given: placement is unchanged.
 *
 * The event and the board disagree about richness: bench.rating.changed@1 carries one full rating, while
 * Bench's current outbox announces `{ subjects: [...] }`. Both are accepted; when the event is sparse the
 * board endpoints (GET /api/v1/boards/:kind?type=elo|cost) fill the gap. A redelivery is a no-op through
 * the openvibe-sdk inbox (bench_event_inbox).
 */
const { createPgInbox } = require('openvibe-sdk/events');

const CONSUMER = 'ai-bench.rating';
const MIN_GAMES = 10;
const DEFAULT_CATEGORY = 'all';
const OPERATION_KIND = {
    chat: 'chat.reply',
    complete: 'chat.reply',
    generate: 'chat.reply',
    summarize: 'chat.reply',
    classify: 'chat.reply',
    extract: 'chat.reply',
    enrich: 'chat.reply',
    vision: 'vision.pair',
    transcribe: 'speech.asr',
    image: 'vision.answer',
};

const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const flag = (v) => v === true || v === 1 || /^(1|true|yes|on)$/i.test(String(v || ''));
const text = (v) => (v == null ? '' : String(v).trim());
const uniq = (xs) => [...new Set(xs.filter(Boolean))];

/** The board category (Bench's task class) a route reads; `all` is Bench's default. */
function categoryFor(route) {
    const c = (route && route.constraints) || {};
    const o = (route && route.options) || {};
    return text((route && route.bench_category) || c.bench_category || o.bench_category) || DEFAULT_CATEGORY;
}

/** The boards a route may learn from, most specific first. */
function kindCandidates(route, operation) {
    const c = (route && route.constraints) || {};
    const o = (route && route.options) || {};
    const explicit = [
        route && route.bench_kind,
        c.bench_kind, c.task_class, c.kind_id, c.kind,
        o.bench_kind, o.task_class, o.kind_id, o.kind,
    ].map(text);
    // An explicit board is authoritative: no evidence there means no evidence, never a fallback board.
    const first = explicit.find(Boolean);
    if (first) return [first];
    const out = [];
    if (route && route.key) out.push(text(route.key));
    const op = text((route && route.capability) || operation);
    if (OPERATION_KIND[op]) out.push(OPERATION_KIND[op]);
    return uniq(out);
}

function intervalOf(row) {
    const lower = num(row && row.ci_lower);
    const upper = num(row && row.ci_upper);
    if (lower == null || upper == null) return null;
    return { lower: Math.min(lower, upper), upper: Math.max(lower, upper) };
}

function provisionalOf(row) {
    return Boolean(row && row.provisional) || Number(row && row.games) < MIN_GAMES;
}

function usable(row) {
    return Boolean(row) && num(row.rating) != null && !provisionalOf(row) && intervalOf(row) != null;
}

function overlaps(a, b) {
    const x = intervalOf(a);
    const y = intervalOf(b);
    return Boolean(x && y && x.lower <= y.upper && y.lower <= x.upper);
}

/** An evidence row applies to an offer when the model matches; a known provider must match too. */
function matchesOffer(row, offer) {
    if (!row || !offer || !text(offer.model) || text(row.model) !== text(offer.model)) return false;
    return !text(row.provider) || !text(offer.provider) || text(row.provider) === text(offer.provider);
}

function viewRow(row) {
    const rating = num(row.rating);
    const interval = intervalOf(row);
    return {
        kind_id: row.kind_id,
        category: row.category,
        model: row.model,
        provider: text(row.provider) || null,
        rating,
        // `elo` is the same number under Bench's own name, so a reader of either shape finds it.
        elo: rating,
        interval,
        ci_lower: interval ? interval.lower : null,
        ci_upper: interval ? interval.upper : null,
        games: Number(row.games) || 0,
        provisional: provisionalOf(row),
        cost_per_solved: num(row.cost_per_solved),
        updated_at: row.updated_at || null,
    };
}

function viewSelected(row, offer) {
    return {
        ...viewRow(row),
        provider: offer.provider || null,
        model: offer.model || null,
    };
}

function leaderSort(a, b) {
    return (num(b.rating) - num(a.rating))
        || (Number(b.games) - Number(a.games))
        || String(a.model).localeCompare(String(b.model))
        || String(a.provider || '').localeCompare(String(b.provider || ''));
}

/**
 * Pure tie rule: given every evidence row for one kind/category and placement's eligible order, prefer the
 * cheapest offer statistically tied with the best non-provisional rating. Returns the (possibly reordered)
 * order and everything a caller needs to explain the decision. No database or clock here.
 */
function chooseFromEvidence({ kind_id = null, category = DEFAULT_CATEGORY, evidence = [], order = [] }) {
    const rows = Array.isArray(evidence) ? evidence : [];
    const offers = Array.isArray(order) ? order : [];
    const usableRows = rows.filter(usable).sort(leaderSort);
    const base = {
        enabled: true, kind_id, category, evidence: usableRows.map(viewRow),
        leader: null, tied: [], selected: null, status: 'no_evidence',
        reason: `no bench evidence for ${kind_id || 'this route'}${category && category !== DEFAULT_CATEGORY ? ` (${category})` : ''}`,
    };
    if (!usableRows.length) {
        if (rows.length) {
            base.status = 'provisional_or_no_interval';
            base.reason = `bench evidence for ${kind_id || 'this route'} is provisional (under ${MIN_GAMES} games) or has no rating interval`;
        }
        return { order: offers, view: base };
    }
    const leader = usableRows[0];
    const leaderView = viewRow(leader);
    base.leader = leaderView;
    const tiedRows = usableRows.filter((row) => overlaps(row, leader));

    // One candidate per eligible offer; a model may appear under several providers, so pick that offer's
    // best rating first and its cheapest cost as the tie-break.
    const tied = [];
    for (let index = 0; index < offers.length; index++) {
        const offer = offers[index];
        const matched = tiedRows.filter((row) => matchesOffer(row, offer))
            .sort((a, b) => leaderSort(a, b) || (num(a.cost_per_solved) ?? Infinity) - (num(b.cost_per_solved) ?? Infinity));
        if (!matched.length) continue;
        tied.push({ ...viewSelected(matched[0], offer), index });
    }
    base.tied = tied.map(({ index, ...rest }) => rest);
    if (!tied.length) {
        base.status = 'no_tied_offer';
        base.reason = `no eligible offer is statistically tied with ${leader.model} (rating ${leaderView.rating})`;
        return { order: offers, view: base };
    }
    const priced = tied.filter((row) => row.cost_per_solved != null && row.cost_per_solved >= 0)
        .sort((a, b) => a.cost_per_solved - b.cost_per_solved || a.index - b.index);
    if (!priced.length) {
        base.status = 'no_cost';
        base.reason = `the offers tied with ${leader.model} have no cost per solved yet`;
        return { order: offers, view: base };
    }
    const winner = priced[0];
    const next = [...offers];
    if (winner.index > 0) {
        const [chosen] = next.splice(winner.index, 1);
        next.unshift(chosen);
    }
    base.status = 'selected';
    base.selected = {
        provider: winner.provider, model: winner.model,
        kind_id: winner.kind_id, category: winner.category,
        rating: winner.rating, interval: winner.interval, games: winner.games,
        cost_per_solved: winner.cost_per_solved, updated_at: winner.updated_at,
    };
    base.reason = `${winner.provider ? `${winner.provider}/` : ''}${winner.model} is the cheapest offer statistically tied with ${leader.model} `
        + `(rating ${leaderView.rating}, ${leaderView.games} games) at $${winner.cost_per_solved}/solved`;
    return { order: next, view: base };
}

function createBenchEvidence({ db, registry = null, config = {}, clock = { now: () => Date.now() }, fetchImpl = globalThis.fetch, log = console } = {}) {
    const table = 'bench_evidence';
    const inbox = createPgInbox(db, { table: 'bench_event_inbox', now: () => clock.now() });
    const benchUrl = text(config.bench && config.bench.url).replace(/\/+$/, '');
    const timeoutMs = Math.max(1000, Number(config.bench && config.bench.timeoutMs) || 15000);

    const selectRows = db.prepare(`SELECT * FROM ${table} WHERE kind_id = ? AND category = ? ORDER BY rating DESC, games DESC, model ASC, provider ASC`);
    async function list(kindId, category = DEFAULT_CATEGORY) {
        if (!kindId) return [];
        return await selectRows.all(text(kindId), text(category) || DEFAULT_CATEGORY);
    }

    async function fetchBoard(kindId, type) {
        if (!benchUrl) throw new Error('AI_BENCH_URL is not set');
        const url = `${benchUrl}/api/v1/boards/${encodeURIComponent(kindId)}?type=${encodeURIComponent(type)}`;
        const res = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) throw new Error(`bench board ${kindId} ${type}: ${res.status}`);
        const body = await res.json();
        const board = body && body.board ? body.board : body;
        if (!board || !Array.isArray(board.rows)) throw new Error(`bench board ${kindId} ${type}: no rows`);
        return board.rows;
    }

    /** A model's provider from AI's registry, when exactly one provider offers it; Bench rates the model, not the seller. */
    async function providerMap() {
        const out = new Map();
        if (!registry || typeof registry.listModels !== 'function') return out;
        try {
            for (const m of await registry.listModels()) {
                if (!out.has(m.model_key)) out.set(m.model_key, new Set());
                out.get(m.model_key).add(m.provider_key);
            }
        } catch (err) {
            log.warn(`[bench] provider lookup failed: ${err.message}`);
        }
        return out;
    }

    function ratingsFromPayload(payload) {
        const source = Array.isArray(payload.ratings) ? payload.ratings
            : Array.isArray(payload.rows) ? payload.rows
                : Array.isArray(payload.subjects) ? payload.subjects
                    : (payload.subject || payload.model) ? [payload] : [];
        return source.map((raw) => {
            const r = raw && typeof raw === 'object' ? raw : { subject: raw };
            const subject = r.subject && typeof r.subject === 'object' ? r.subject.id : r.subject;
            return {
                model: text(r.model || subject || r.id),
                provider: text(r.provider),
                rating: num(r.rating != null ? r.rating : r.elo),
                ci_lower: num(r.ci_lower),
                ci_upper: num(r.ci_upper),
                games: num(r.games),
                provisional: r.provisional === undefined ? null : flag(r.provisional),
                cost_per_solved: num(r.cost_per_solved),
                updated_at: r.updated_at || r.at || null,
            };
        }).filter((r) => r.model);
    }

    /** Fill a sparse event from Bench's boards; a full rating still gets the board's cost when it is reachable. */
    async function hydrate(payload, rows) {
        const kindId = text(payload.kind_id);
        const missingRating = rows.some((r) => r.rating == null || r.games == null || r.ci_lower == null || r.ci_upper == null);
        let eloRows = null;
        if (missingRating) {
            eloRows = await fetchBoard(kindId, 'elo');   // a sparse event is useless without it: let Events retry
            for (const row of rows) {
                const b = eloRows.find((x) => text(x.subject || x.model) === row.model);
                if (!b) continue;
                if (row.rating == null) row.rating = num(b.elo != null ? b.elo : b.rating);
                if (row.games == null) row.games = num(b.games);
                if (row.ci_lower == null) row.ci_lower = num(b.ci_lower);
                if (row.ci_upper == null) row.ci_upper = num(b.ci_upper);
                if (row.provisional == null) row.provisional = b.provisional === undefined ? null : flag(b.provisional);
            }
        }
        if (rows.some((r) => r.cost_per_solved == null)) {
            try {
                const costRows = await fetchBoard(kindId, 'cost');
                for (const row of rows) {
                    const b = costRows.find((x) => text(x.subject || x.model) === row.model);
                    if (b && row.cost_per_solved == null) row.cost_per_solved = num(b.cost_per_solved);
                }
            } catch (err) {
                // A rating without a price is still evidence; the next rating change fills the cost in.
                if (rows.some((r) => r.rating == null)) throw err;
                log.warn(`[bench] cost per solved unavailable for ${kindId}: ${err.message}`);
            }
        }
        return rows;
    }

    /**
     * Apply one bench.rating.changed envelope, exactly once. Returns { duplicate, stored }.
     * Only source `bench` and the rating topic are ours; anything else is acknowledged and ignored.
     */
    async function applyEvent(event) {
        if (!event || event.event_type !== 'bench.rating.changed') return { ignored: true, reason: 'not bench.rating.changed' };
        if (event.source && event.source !== 'bench') return { ignored: true, reason: `source ${event.source}` };
        if (!event.event_id) throw new Error('bench.rating.changed has no event_id');
        const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
        const kindId = text(payload.kind_id);
        if (!kindId) throw new Error('bench.rating.changed has no payload.kind_id');
        const category = text(payload.category) || DEFAULT_CATEGORY;
        const eventAt = text(payload.at || event.timestamp);
        const when = eventAt && !Number.isNaN(new Date(eventAt).getTime()) ? new Date(eventAt).toISOString() : new Date(clock.now()).toISOString();
        // A redelivery is common (Events retries); do not call Bench's boards for an event already applied.
        if (await inbox.seen(CONSUMER, String(event.event_id))) return { duplicate: true, stored: 0 };
        const rows = await hydrate(payload, ratingsFromPayload(payload));
        const providers = await providerMap();

        const receipt = await inbox.once(CONSUMER, String(event.event_id), async (t) => {
            let stored = 0;
            for (const row of rows) {
                if (row.rating == null) continue;                 // a board with no rating yet is not evidence
                const known = providers.get(row.model);
                const provider = row.provider || (known && known.size === 1 ? [...known][0] : '');
                const provisional = row.provisional == null ? (Number(row.games) || 0) < MIN_GAMES : row.provisional || (Number(row.games) || 0) < MIN_GAMES;
                await t.exec(
                    `INSERT INTO ${table} (kind_id, category, model, provider, rating, ci_lower, ci_upper, games, provisional, cost_per_solved, updated_at)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                     ON CONFLICT (kind_id, category, model, provider) DO UPDATE SET
                       rating = excluded.rating, ci_lower = excluded.ci_lower, ci_upper = excluded.ci_upper,
                       games = excluded.games, provisional = excluded.provisional,
                       cost_per_solved = COALESCE(excluded.cost_per_solved, ${table}.cost_per_solved),
                       updated_at = excluded.updated_at
                     WHERE excluded.updated_at >= ${table}.updated_at`,
                    [kindId, category, row.model, provider, row.rating, row.ci_lower, row.ci_upper,
                        Number(row.games) || 0, provisional ? 1 : 0, row.cost_per_solved, when],
                );
                stored++;
            }
            return { stored };
        });
        return receipt.duplicate ? { duplicate: true, stored: 0 } : { duplicate: false, ...(receipt.result || {}) };
    }

    /** The order a route should try, with the evidence and reason that changed (or left) it. */
    async function select({ route, order = [], operation = null } = {}) {
        const enabled = Boolean(route && route.learn_from_bench);
        const kinds = kindCandidates(route, operation);
        const category = categoryFor(route);
        if (!enabled) {
            return {
                order,
                view: {
                    enabled: false, kind_id: kinds[0] || null, category, evidence: [],
                    leader: null, tied: [], selected: null, status: 'off',
                    reason: 'route does not opt in (learn_from_bench is false)',
                },
            };
        }
        for (const kindId of kinds) {
            const evidence = await list(kindId, category);
            if (!evidence.length) continue;
            const picked = chooseFromEvidence({ kind_id: kindId, category, evidence, order });
            return { order: picked.order, view: picked.view };
        }
        return {
            order,
            view: {
                enabled: true, kind_id: kinds[0] || null, category, evidence: [],
                leader: null, tied: [], selected: null, status: 'no_evidence',
                reason: kinds[0]
                    ? `no bench evidence for ${kinds[0]}${category !== DEFAULT_CATEGORY ? ` (${category})` : ''}`
                    : 'no bench kind on this route (set bench_kind or use a route key that names one)',
            },
        };
    }

    async function view({ route, order = [], operation = null } = {}) {
        return (await select({ route, order, operation })).view;
    }

    return { applyEvent, select, view, list, kindCandidates, categoryFor, CONSUMER, MIN_GAMES };
}

module.exports = {
    createBenchEvidence, chooseFromEvidence, kindCandidates, categoryFor,
    intervalOf, usable, overlaps, matchesOffer, viewRow, MIN_GAMES, DEFAULT_CATEGORY, CONSUMER,
};
