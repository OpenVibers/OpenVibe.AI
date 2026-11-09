'use strict';
const { AiError, sha256 } = require('../util');

// A database uniqueness constraint, not a process-local lock: concurrent callers and
// restarts cannot take two key holds for the same owner's logical request.
async function claimRequest(db, owner, idempotencyKey, body) {
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey))
        throw new AiError(422, 'input.invalid', 'Idempotency-Key must be 8-128 of [A-Za-z0-9._:-]');
    const fingerprint = sha256(body);
    const claimed = await db.prepare(
        'INSERT INTO exchange_key_requests(owner,idempotency_key,request_hash) VALUES(?,?,?) ON CONFLICT DO NOTHING RETURNING owner',
    ).get(owner, idempotencyKey, fingerprint);
    const existingRun = () => db.prepare(
        "SELECT id FROM runs WHERE requester_type = 'user' AND requester_id = ? AND idempotency_key = ?",
    ).get(owner, idempotencyKey);
    if (!claimed) {
        const previous = await db.prepare(
            'SELECT request_hash,max_cost_usd FROM exchange_key_requests WHERE owner = ? AND idempotency_key = ?',
        ).get(owner, idempotencyKey);
        if (!previous || previous.request_hash !== fingerprint)
            throw new AiError(409, 'idempotency.conflict', 'Idempotency-Key was used with different input');
        const run = await existingRun();
        if (!run)
            throw new AiError(409, 'idempotency.in_progress', 'The original request is still being admitted; retry shortly');
        // runs.create verifies the input again and returns this owner's stored run.
        // Retain the original ceiling even if the key's remaining budget changed.
        return { replay: true, maxCost: previous.max_cost_usd === null ? null : Number(previous.max_cost_usd) };
    }
    // The same person may first have used their person token rather than an opaque
    // key. Their existing run is still a replay, with its original request ceiling.
    if (await existingRun()) return { replay: true, maxCost: null };
    return {
        replay: false,
        admitted: (amount) => db.prepare(
            'UPDATE exchange_key_requests SET max_cost_usd = ? WHERE owner = ? AND idempotency_key = ?',
        ).run(amount, owner, idempotencyKey),
        abandon: () => db.prepare(
            `DELETE FROM exchange_key_requests WHERE owner = ? AND idempotency_key = ?
             AND NOT EXISTS (SELECT 1 FROM runs WHERE requester_type = 'user' AND requester_id = ? AND idempotency_key = ?)`,
        ).run(owner, idempotencyKey, owner, idempotencyKey),
    };
}
module.exports = { claimRequest };
