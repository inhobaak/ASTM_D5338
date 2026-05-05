-- ASTM D5338 CO2 Monitor - Seed Data
-- Run this file AFTER schema.sql
-- Three comparison channels: blank, cellulose positive control, and sample

INSERT INTO channels (channel_id, label, location, is_active) VALUES
    ('pico-ch-01', 'Blank', 'Background reference vessel', true),
    ('pico-ch-02', 'Cellulose', 'Positive control vessel', true),
    ('pico-ch-03', 'Sample', 'Test material vessel', true)
ON CONFLICT (channel_id) DO UPDATE SET
    label = EXCLUDED.label,
    location = EXCLUDED.location,
    is_active = true;

UPDATE channels
SET is_active = false
WHERE channel_id NOT IN ('pico-ch-01', 'pico-ch-02', 'pico-ch-03');

-- Default alert rule: warn when measured CO2 exceeds 1000 ppm on any channel.
-- Adjust threshold for the incubator and test protocol as needed.
DELETE FROM alert_rules
WHERE channel_id IS NULL
  AND metric = 'co2_ppm'
  AND threshold = 1000
  AND direction = 'above';

INSERT INTO alert_rules (channel_id, metric, threshold, direction)
VALUES (NULL, 'co2_ppm', 1000, 'above');
