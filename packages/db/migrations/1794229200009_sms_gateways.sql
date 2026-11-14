CREATE TABLE aevyra.sms_gateways (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  name text NOT NULL UNIQUE CHECK (name ~ '^[A-Z0-9][A-Z0-9-]{1,39}$'),
  base_url text NOT NULL CHECK (base_url ~ '^https?://[^[:space:]]+$'),
  username text NOT NULL CHECK (char_length(btrim(username)) BETWEEN 1 AND 120),
  password text NOT NULL CHECK (char_length(password) BETWEEN 1 AND 200),
  device_id text CHECK (device_id IS NULL OR char_length(btrim(device_id)) BETWEEN 1 AND 120),
  enabled boolean NOT NULL DEFAULT true,
  last_used_at timestamptz,
  last_checked_at timestamptz,
  last_check_status text CHECK (last_check_status IN ('OK', 'FAILED')),
  last_check_detail text CHECK (last_check_detail IS NULL OR char_length(last_check_detail) <= 400),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sms_gateways_rotation_idx
  ON aevyra.sms_gateways (enabled, last_used_at ASC NULLS FIRST, name ASC);

ALTER TABLE aevyra.message_jobs
  ADD COLUMN gateway_id uuid REFERENCES aevyra.sms_gateways (id);

ALTER TABLE aevyra.message_jobs
  ADD CHECK (gateway_id IS NULL OR channel = 'SMS');

ALTER TABLE aevyra.message_job_events
  DROP CONSTRAINT message_job_events_status_check;

ALTER TABLE aevyra.message_job_events
  ADD CONSTRAINT message_job_events_status_check
  CHECK (status IN ('QUEUED', 'PROCESSING', 'SENT', 'SIMULATED_SENT', 'FAILED', 'CANCELLED', 'SKIPPED'));
