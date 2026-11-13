CREATE TABLE aevyra.campaign_control_events (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  campaign_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('START', 'STOP', 'RESUME', 'CANCEL')),
  operator_id text NOT NULL REFERENCES aevyra_auth."user" (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (campaign_id, organization_id) REFERENCES aevyra.campaigns (id, organization_id)
);

CREATE INDEX campaign_control_events_campaign_idx
  ON aevyra.campaign_control_events (campaign_id, created_at DESC, id DESC);
