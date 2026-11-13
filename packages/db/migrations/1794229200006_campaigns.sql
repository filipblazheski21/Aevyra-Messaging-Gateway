CREATE TABLE aevyra.campaigns (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  organization_id uuid NOT NULL REFERENCES aevyra.organizations (id),
  purpose text NOT NULL CHECK (purpose IN ('PATIENT_INFORMATION', 'AEVYRA_MARKETING')),
  channel text NOT NULL CHECK (channel IN ('SMS', 'VIBER')),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  template_version_id uuid NOT NULL,
  created_by_operator_id text NOT NULL REFERENCES aevyra_auth."user" (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (template_version_id, organization_id) REFERENCES aevyra.message_template_versions (id, organization_id),
  UNIQUE (id, organization_id)
);

CREATE INDEX campaigns_org_created_idx
  ON aevyra.campaigns (organization_id, created_at DESC, id DESC);

CREATE TABLE aevyra.campaign_recipients (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  campaign_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  frozen_body text NOT NULL CHECK (char_length(btrim(frozen_body)) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (campaign_id, organization_id) REFERENCES aevyra.campaigns (id, organization_id),
  FOREIGN KEY (contact_id, organization_id) REFERENCES aevyra.contacts (id, organization_id),
  UNIQUE (campaign_id, contact_id)
);

CREATE TABLE aevyra.campaign_approvals (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  campaign_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  decision text NOT NULL CHECK (decision IN ('APPROVED', 'REVOKED')),
  operator_id text NOT NULL REFERENCES aevyra_auth."user" (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (campaign_id, organization_id) REFERENCES aevyra.campaigns (id, organization_id)
);

CREATE INDEX campaign_approvals_campaign_idx
  ON aevyra.campaign_approvals (campaign_id, created_at DESC, id DESC);
