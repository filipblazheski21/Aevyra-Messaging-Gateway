CREATE TABLE aevyra.message_jobs (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  organization_id uuid NOT NULL REFERENCES aevyra.organizations (id),
  campaign_id uuid NOT NULL,
  recipient_id uuid NOT NULL REFERENCES aevyra.campaign_recipients (id),
  contact_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN ('SMS', 'VIBER')),
  frozen_body text NOT NULL CHECK (char_length(btrim(frozen_body)) BETWEEN 1 AND 2000),
  idempotency_key text NOT NULL CHECK (char_length(btrim(idempotency_key)) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (campaign_id, organization_id) REFERENCES aevyra.campaigns (id, organization_id),
  FOREIGN KEY (contact_id, organization_id) REFERENCES aevyra.contacts (id, organization_id),
  UNIQUE (campaign_id, contact_id),
  UNIQUE (organization_id, idempotency_key),
  UNIQUE (id, organization_id)
);

CREATE INDEX message_jobs_org_created_idx
  ON aevyra.message_jobs (organization_id, created_at ASC, id ASC);

CREATE TABLE aevyra.message_job_events (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  job_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('QUEUED', 'PROCESSING', 'SIMULATED_SENT', 'FAILED', 'CANCELLED')),
  detail text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (job_id, organization_id) REFERENCES aevyra.message_jobs (id, organization_id)
);

CREATE INDEX message_job_events_job_idx
  ON aevyra.message_job_events (job_id, created_at DESC, id DESC);
