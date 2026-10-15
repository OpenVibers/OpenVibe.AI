-- phase: expand
-- Request telemetry (openvibe-sdk/telemetry telemetrySchema()): one row per aggregated sample, pruned after 30 days (server/index.js).
CREATE TABLE IF NOT EXISTS telemetry_samples (
    id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    at                    timestamptz NOT NULL,
    service               text NOT NULL,
    project               text,
    subject               text,
    resource              text,
    provider              text,
    node                  text,
    cell                  text,
    region                text,
    operation             text NOT NULL,
    latency_ms            double precision,
    queue_delay_ms        double precision,
    ttfb_ms               double precision,
    throughput_per_second double precision,
    bytes                 bigint,
    status                text,
    cache_status          text,
    cost_estimate         double precision,
    route_epoch           bigint,
    trace_id              text,
    extra                 jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS telemetry_samples_at_idx ON telemetry_samples (at);
CREATE INDEX IF NOT EXISTS telemetry_samples_service_idx ON telemetry_samples (service, operation, at);
