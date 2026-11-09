'use strict';
/**
 * A run started from an AI task: one source answers every model step, in the order the resolved choice names.
 * A fallback is explicit and tried only when the one before it failed before it produced any text; a streamed delta
 * or a content-floor refusal ends the run, because a second voice after the first one's words would be a lie.
 */
const { AiError } = require('../util');
const { canonicalOf } = require('../exchange/catalog');
const { pricesOf } = require('../providers/rate-cards');

async function executeChoice({ execute, registry, poolRates, maxAttempts = 1, route, operation, req, ctx }) {
    const plan = ctx.taskChoice;
    const candidates = [plan.choice, ...plan.fallbacks];
    let streamed = false;
    let last = null;
    const onDelta = ctx.onDelta ? (...args) => { streamed = true; return ctx.onDelta(...args); } : undefined;

    for (let i = 0; i < candidates.length; i += 1) {
        const picked = candidates[i];
        try {
            // One attempt: the choice owns the source, so the person's other keys, their kind default, a community
            // offer and a soft preference are all set aside for this step.
            const next = { ...ctx, taskChoice: null, selfCredentials: [], selfPreferences: null, communityOptIn: false, prefer: null, ...(onDelta ? { onDelta } : {}) };
            let offers = [];

            if (picked.source === 'machines') {
                if (!ctx.onBehalfOf) throw new AiError(401, 'choice.sign_in', 'a machine choice needs a person');
                next.credential = { provider: 'node', providerKey: `byo:self:${ctx.onBehalfOf}:node`, owner: 'self', subject: ctx.onBehalfOf, machine: picked.machine, models: { chat: picked.model } };
            } else {
                const isImage = operation === 'image';
                const [rows, providers] = await Promise.all([registry.listModels(), registry.listProviders()]);
                const byKey = new Map(providers.map((p) => [p.key, p]));
                const dynamic = picked.model.startsWith('openvibe/');
                for (const row of rows) {
                    const provider = byKey.get(row.provider_key);
                    if (!provider || provider.status !== 'active' || row.status !== 'active') continue;
                    if (isImage ? row.type !== 'image' : row.type === 'image') continue;
                    const id = canonicalOf(row, provider);
                    if (!dynamic && id !== picked.model && row.model_key !== picked.model) continue;
                    const adult = Boolean(row.metadata?.uncensored) || /uncensor|abliterat/i.test(`${id} ${row.metadata?.variant || ''}`);
                    // A dynamic choice picks among the standard offers; an uncensored model is never chosen in silence.
                    if (dynamic && adult) continue;
                    if (adult) next.contentPolicy = 'uncensored';
                    offers.push({ provider: provider.key, model: row.model_key });
                }
                if (picked.source === 'keys') {
                    // The person's own key: only a provider they have a key for may answer, and their key pays.
                    const provider = picked.model.split('/')[0];
                    const cred = (ctx.selfCredentials || []).find((k) => k.provider === provider || offers.some((o) => o.provider === k.provider));
                    if (!cred) throw new AiError(422, 'ai.needs_key', 'add your key for this model on Exchange');
                    const model = (offers.find((o) => o.provider === cred.provider) || {}).model || picked.model.slice(provider.length + 1);
                    next.credential = { ...cred, models: { chat: model } };
                } else {
                    if (!offers.length) throw new AiError(422, 'choice.unavailable', `no deployment of ${picked.model} is available`);
                    if (picked.model === 'openvibe/cheapest') {
                        const priced = await Promise.all(offers.map(async (o) => {
                            const card = await poolRates(o.provider, o.model);
                            if (!card) return { o, price: Infinity };
                            const prices = pricesOf(card);
                            return { o, price: prices.in + prices.out };
                        }));
                        offers = priced.sort((a, b) => a.price - b.price).map((x) => x.o);
                    }
                    // openvibe/auto means the network's own router decides; every other choice pins exactly its model.
                    if (picked.model !== 'openvibe/auto') next.exact = { id: picked.model, offers };
                }
            }

            if (plan.max_cost_usd != null && picked.source === 'openvibe') {
                if (operation === 'image') throw new AiError(402, 'choice.cost_ceiling', 'a priced image offer needs a per-image upper bound before it can use this ceiling');
                const remaining = plan.max_cost_usd - (ctx.choiceBudget.used || 0);
                const inputTokens = Buffer.byteLength(JSON.stringify(req));
                const outputTokens = Number(req.maxTokens || (req.openai && req.openai.max_tokens) || 4096);
                // Reserve a conservative upper bound for this step, attempts included. An unrated paid model is refused
                // rather than guessed at, and a local or stub provider costs nothing.
                const rated = await Promise.all(offers.map(async (o) => {
                    const card = await poolRates(o.provider, o.model);
                    const prices = card ? pricesOf(card) : null;
                    const provider = prices ? null : await registry.getProvider(o.provider);
                    const cost = prices ? maxAttempts * (inputTokens * prices.in + outputTokens * prices.out) / 1e6
                        : provider && ['local', 'stub'].includes(provider.kind) ? 0 : Infinity;
                    return { ...o, cost };
                }));
                const admitted = rated.filter((o) => Number.isFinite(o.cost) && o.cost <= remaining);
                if (!admitted.length) throw new AiError(402, 'choice.cost_ceiling', 'no selected model fits the remaining task cost ceiling');
                // Every deployment of a pinned model can be attempted, so all of their bounds are reserved together.
                const limited = [];
                let reserved = 0;
                for (const o of admitted) {
                    if (reserved + o.cost > remaining) continue;
                    limited.push(o);
                    reserved += o.cost;
                }
                ctx.choiceBudget.used = (ctx.choiceBudget.used || 0) + reserved;
                next.exact = { id: picked.model, offers: limited.sort((a, b) => a.cost - b.cost).map(({ provider, model }) => ({ provider, model })) };
            }

            const forwarded = onDelta && req.onDelta ? { ...req, onDelta: (...args) => { streamed = true; return req.onDelta(...args); } } : req;
            const answer = await execute(route, operation, forwarded, next);
            answer.explain = {
                ...(answer.explain || {}),
                task_choice: {
                    task: plan.task.name,
                    requested: plan.choice,
                    answered: { model: answer.model || picked.model, source: picked.source, ...(picked.machine ? { machine: picked.machine } : {}) },
                    why: plan.why,
                    fallback_index: i,
                },
            };
            answer.fallbackUsed = answer.fallbackUsed || i > 0;
            return answer;
        } catch (err) {
            last = err;
            if (streamed || (ctx.signal && ctx.signal.aborted) || /^policy\./.test(err.code || '') || err.status === 403) throw err;
        }
    }
    throw last || new AiError(503, 'choice.unavailable', 'no choice could answer');
}

module.exports = { executeChoice };
