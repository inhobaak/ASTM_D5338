-- CO2 Monitor Database Schema
-- Run this entire file in the Supabase SQL Editor (supabase.com > your project > SQL Editor)

-- ============================================================
-- TABLES
-- ============================================================

CREATE TABLE channels (
    channel_id  TEXT PRIMARY KEY,
    label       TEXT NOT NULL,
    location    TEXT,
    created_at  TIMESTAMPTZ DEFAULT now(),
    is_active   BOOLEAN DEFAULT true
);

CREATE TABLE readings (
    id           BIGSERIAL PRIMARY KEY,
    channel_id   TEXT NOT NULL REFERENCES channels(channel_id),
    co2_ppm      REAL NOT NULL,
    temp_c       REAL NOT NULL,
    humidity_rh  REAL NOT NULL,
    recorded_at  TIMESTAMPTZ NOT NULL,
    received_at  TIMESTAMPTZ DEFAULT now(),
    CONSTRAINT valid_co2  CHECK (co2_ppm >= 0 AND co2_ppm <= 40000),
    CONSTRAINT valid_temp CHECK (temp_c >= -40 AND temp_c <= 70),
    CONSTRAINT valid_rh   CHECK (humidity_rh >= 0 AND humidity_rh <= 100)
);

CREATE TABLE alert_rules (
    id          SERIAL PRIMARY KEY,
    channel_id  TEXT REFERENCES channels(channel_id),  -- NULL = all channels
    metric      TEXT NOT NULL CHECK (metric IN ('co2_ppm', 'temp_c', 'humidity_rh')),
    threshold   REAL NOT NULL,
    direction   TEXT NOT NULL CHECK (direction IN ('above', 'below')),
    is_active   BOOLEAN DEFAULT true,
    created_at  TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- INDEXES
-- ============================================================

CREATE INDEX idx_readings_channel_time ON readings (channel_id, recorded_at DESC);
CREATE INDEX idx_readings_received_at  ON readings (received_at);
CREATE INDEX idx_readings_recorded_at  ON readings (recorded_at);

-- ============================================================
-- VIEWS
-- ============================================================

CREATE OR REPLACE VIEW channel_status AS
SELECT
    c.channel_id,
    c.label,
    c.location,
    c.is_active,
    r.last_reading_at,
    r.last_co2_ppm,
    r.last_temp_c,
    r.last_humidity_rh,
    CASE
        WHEN r.last_reading_at > now() - INTERVAL '2 minutes'  THEN 'online'
        WHEN r.last_reading_at > now() - INTERVAL '10 minutes' THEN 'stale'
        ELSE 'offline'
    END AS status
FROM channels c
LEFT JOIN LATERAL (
    SELECT
        recorded_at  AS last_reading_at,
        co2_ppm      AS last_co2_ppm,
        temp_c       AS last_temp_c,
        humidity_rh  AS last_humidity_rh
    FROM readings
    WHERE readings.channel_id = c.channel_id
    ORDER BY recorded_at DESC
    LIMIT 1
) r ON true
WHERE c.is_active = true;

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

ALTER TABLE channels    ENABLE ROW LEVEL SECURITY;
ALTER TABLE readings    ENABLE ROW LEVEL SECURITY;
ALTER TABLE alert_rules ENABLE ROW LEVEL SECURITY;

-- Allow anonymous reads and inserts (Pico devices + dashboard use anon key)
CREATE POLICY "anon_read_channels"    ON channels    FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read_readings"    ON readings    FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_readings"  ON readings    FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_read_alert_rules" ON alert_rules FOR SELECT TO anon USING (true);

GRANT SELECT ON channel_status TO anon;

-- ============================================================
-- REALTIME
-- ============================================================

-- Enable Supabase Realtime for live dashboard updates
ALTER PUBLICATION supabase_realtime ADD TABLE readings;

-- ============================================================
-- DATA RETENTION
-- ============================================================

-- Call this function periodically to keep the database under 500 MB.
-- Recommended: run once daily (use Supabase cron extension or call manually).
-- At 5 channels / 30s intervals, 90-day retention = ~130 MB, well under the 500 MB free limit.
CREATE OR REPLACE FUNCTION prune_old_readings()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    DELETE FROM readings WHERE received_at < now() - INTERVAL '90 days';
END;
$$;
