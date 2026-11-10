'use strict';
function durationMs(started, finished) {
    const time = (v) => typeof v === 'number' ? v : v == null ? NaN : Date.parse(v);
    const start = time(started), end = time(finished);
    return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null;
}
function latencyOf(row) {
    const value = row.latency_ms;
    if (value != null && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0) return Number(value);
    return durationMs(row.started_at, row.finished_at);
}
module.exports = { durationMs, latencyOf };
