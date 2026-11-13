CREATE TABLE aevyra.message_templates (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  organization_id uuid NOT NULL REFERENCES aevyra.organizations (id),
  purpose text NOT NULL CHECK (purpose IN ('PATIENT_INFORMATION', 'AEVYRA_MARKETING')),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  created_by_operator_id text NOT NULL REFERENCES aevyra_auth."user" (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id)
);

CREATE INDEX message_templates_org_created_idx
  ON aevyra.message_templates (organization_id, created_at DESC, id DESC);

CREATE TABLE aevyra.message_template_versions (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  template_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  version_number integer NOT NULL CHECK (version_number >= 1),
  body text NOT NULL CHECK (char_length(btrim(body)) BETWEEN 1 AND 2000),
  allowed_variables text[] NOT NULL DEFAULT '{}',
  created_by_operator_id text NOT NULL REFERENCES aevyra_auth."user" (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (template_id, organization_id) REFERENCES aevyra.message_templates (id, organization_id),
  UNIQUE (template_id, version_number),
  UNIQUE (id, organization_id)
);

CREATE INDEX message_template_versions_template_idx
  ON aevyra.message_template_versions (template_id, version_number DESC);
