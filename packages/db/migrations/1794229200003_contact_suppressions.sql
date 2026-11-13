-- Up Migration
CREATE TABLE aevyra.contact_suppressions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    operator_id text NOT NULL REFERENCES aevyra_auth."user" (id) ON DELETE NO ACTION,
    reason text NOT NULL,
    reference text,
    recorded_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT contact_suppressions_organization_contact_key UNIQUE (organization_id, contact_id),
    CONSTRAINT contact_suppressions_contact_fk FOREIGN KEY (organization_id, contact_id)
        REFERENCES aevyra.contacts (organization_id, id) ON DELETE NO ACTION,
    CONSTRAINT contact_suppressions_reason_check CHECK (
        reason IN ('CONTACT_REQUEST', 'ORGANIZATION_REQUEST', 'INTERNAL_BLOCK')
    ),
    CONSTRAINT contact_suppressions_reference_check CHECK (
        reference IS NULL OR (
            char_length(reference) BETWEEN 1 AND 250
            AND reference ~ '[^[:space:]]'
            AND reference = btrim(reference)
        )
    )
);

CREATE INDEX contact_suppressions_operator_id_idx ON aevyra.contact_suppressions (operator_id);
