-- Up Migration
CREATE SCHEMA aevyra;

CREATE TABLE aevyra.organizations (
    id uuid DEFAULT gen_random_uuid(),
    kind text NOT NULL,
    name text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT organizations_pkey PRIMARY KEY (id),
    CONSTRAINT organizations_kind_check CHECK (kind IN ('CLINIC', 'MARKETING')),
    CONSTRAINT organizations_name_not_blank CHECK (name ~ '[^[:space:]]')
);
