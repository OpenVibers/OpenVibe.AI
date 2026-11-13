'use strict';
/**
 * Idempotency for provider side-effects that must happen once per person + asset (currently Unsplash's
 * required download event). PostgreSQL keeps the claim across processes and restarts; a caller that fails
 * before the provider accepts the event releases it, so a retry can still record it.
 */
function createAssetEvents({ db, clock = { now: () => Date.now() } }) {
    const at = () => new Date(clock.now()).toISOString();
    return {
        async once(scope, provider, eventKey) {
            const row = await db.prepare(`INSERT INTO search_asset_events (scope, provider, event_key, created_at)
                VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING scope`).get(String(scope), String(provider), String(eventKey), at());
            return { created: Boolean(row) };
        },
        async release(scope, provider, eventKey) {
            await db.prepare('DELETE FROM search_asset_events WHERE scope = ? AND provider = ? AND event_key = ?')
                .run(String(scope), String(provider), String(eventKey));
        },
    };
}
module.exports = { createAssetEvents };
