-- phase: expand
-- Plan E5 (abuse prevention): allowances by trust, device and network signals, proof of work and anomaly
-- throttling (server/abuse/). Nothing here is a raw client address or a raw device id: the rows hold only a
-- keyed hash of a /24 or /48 prefix, the ASN that prefix belonged to, and a keyed hash of the device id.
-- Every row has an expiry or is a counter that is pruned by the module's own housekeeping.
--
--   abuse_daily_usage   free tokens a person (or the accounts sharing one device) spent on a UTC day
--   abuse_devices       accounts seen on one device, and the allowance tier each one gave the device
--   abuse_network_seen  an ASN and a keyed /24 or /48 hash, for 24 h, so a repeated request is not looked up twice
--   abuse_velocity      free tokens per minute per ASN, device and input bucket (the anomaly baseline)
--   abuse_pow           an issued hashcash challenge (its hash only), single use
--
-- Expand only: an older release never reads these tables and nothing here changes an existing one.
CREATE TABLE IF NOT EXISTS abuse_daily_usage (
    subject    text COLLATE "C" NOT NULL,   -- user:<subject> | device:<keyed device hash> | anon:<keyed hash>
    day        text COLLATE "C" NOT NULL,   -- UTC date, YYYY-MM-DD
    tokens     bigint NOT NULL DEFAULT 0,   -- free tokens claimed, input + output
    updated_at text COLLATE "C" NOT NULL,
    PRIMARY KEY (subject, day)
);

CREATE TABLE IF NOT EXISTS abuse_devices (
    device_hash text COLLATE "C" NOT NULL,  -- keyed hash of the device id, never the id
    subject     text COLLATE "C" NOT NULL,  -- usr_…
    tier_tokens bigint,                     -- the allowance this account gave the device (null until it used free capacity)
    first_seen  text COLLATE "C" NOT NULL,
    last_seen   text COLLATE "C" NOT NULL,
    PRIMARY KEY (device_hash, subject)
);
CREATE INDEX IF NOT EXISTS idx_abuse_devices_last_seen ON abuse_devices (last_seen);

CREATE TABLE IF NOT EXISTS abuse_network_seen (
    prefix_hash text COLLATE "C" PRIMARY KEY, -- keyed hash of the IPv4 /24 or IPv6 /48, never the address
    asn         bigint,
    hosting     bigint NOT NULL DEFAULT 0,
    first_seen  text COLLATE "C" NOT NULL,
    last_seen   text COLLATE "C" NOT NULL,
    expires_at  text COLLATE "C" NOT NULL    -- the row is kept for 24 h, then pruned
);
CREATE INDEX IF NOT EXISTS idx_abuse_network_expires ON abuse_network_seen (expires_at);

CREATE TABLE IF NOT EXISTS abuse_velocity (
    kind      text COLLATE "C" NOT NULL,     -- asn | device | input
    key_hash  text COLLATE "C" NOT NULL,     -- keyed hash of the ASN, the device id or the run's input hash
    minute    bigint NOT NULL,               -- epoch ms truncated to the minute
    tokens    bigint NOT NULL DEFAULT 0,
    updated_at text COLLATE "C" NOT NULL,
    PRIMARY KEY (kind, key_hash, minute)
);
CREATE INDEX IF NOT EXISTS idx_abuse_velocity_minute ON abuse_velocity (minute);

CREATE TABLE IF NOT EXISTS abuse_pow (
    challenge_hash text COLLATE "C" PRIMARY KEY, -- sha256 of the issued challenge
    device_hash    text COLLATE "C",
    prefix_hash    text COLLATE "C",
    issued_at      text COLLATE "C" NOT NULL,
    expires_at     text COLLATE "C" NOT NULL,
    used_at        text COLLATE "C"              -- single use: the first accepted solution sets it
);
CREATE INDEX IF NOT EXISTS idx_abuse_pow_expires ON abuse_pow (expires_at);
