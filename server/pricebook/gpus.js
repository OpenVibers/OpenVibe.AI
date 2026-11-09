'use strict';
// Recorded public listings enter as bytes, like the other price-book parsers. This never calls a marketplace.
function parseGpuQuotes(bytes) {
    const rows = JSON.parse(String(bytes));
    if (!Array.isArray(rows)) throw new Error('GPU listing must be an array');
    return rows.map((r) => {
        if (
            !['vast', 'runpod'].includes(r.provider) ||
            typeof r.gpu !== 'string' ||
            typeof r.region !== 'string' ||
            !Number.isFinite(r.hourly_usd) ||
            r.hourly_usd <= 0 ||
            !Number.isInteger(r.vram_mb) ||
            r.vram_mb <= 0 ||
            !/^https:\/\//.test(r.source) ||
            !Number.isFinite(Date.parse(r.observed_at))
        )
            throw new Error('Invalid GPU price-book observation');
        return {
            provider: r.provider,
            gpu: r.gpu,
            region: r.region,
            hourly_usd: r.hourly_usd,
            vram_mb: r.vram_mb,
            source: r.source,
            observed_at: r.observed_at,
        };
    });
}
async function recordGpuQuotes(db, bytes) {
    const rows = parseGpuQuotes(bytes);
    for (const r of rows)
        await db
            .prepare(
                'INSERT INTO gpu_price_book(provider,gpu,region,hourly_usd,vram_mb,source,observed_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(provider,gpu,region) DO UPDATE SET hourly_usd=excluded.hourly_usd,vram_mb=excluded.vram_mb,source=excluded.source,observed_at=excluded.observed_at WHERE excluded.observed_at > gpu_price_book.observed_at',
            )
            .run(
                r.provider,
                r.gpu,
                r.region,
                r.hourly_usd,
                r.vram_mb,
                r.source,
                r.observed_at,
            );
    return rows.length;
}
module.exports = { parseGpuQuotes, recordGpuQuotes };
