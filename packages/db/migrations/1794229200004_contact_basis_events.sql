-- Up Migration
CREATE TABLE aevyra.contact_basis_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    purpose text NOT NULL,
    channel text NOT NULL,
    event_type text NOT NULL,
    operator_id text NOT NULL REFERENCES aevyra_auth."user" (id) ON DELETE NO ACTION,
    recorded_at timestamptz NOT NULL DEFAULT now(),
    revision integer NOT NULL,
    idempotency_key uuid NOT NULL,
    request_fingerprint text NOT NULL,
    basis_type text,
    reference text,
    expires_at timestamptz,
    CONSTRAINT contact_basis_events_contact_fk FOREIGN KEY (organization_id, contact_id)
        REFERENCES aevyra.contacts (organization_id, id) ON DELETE NO ACTION,
    CONSTRAINT contact_basis_events_scope_revision_key
        UNIQUE (organization_id, contact_id, purpose, channel, revision),
    CONSTRAINT contact_basis_events_organization_idempotency_key
        UNIQUE (organization_id, idempotency_key),
    CONSTRAINT contact_basis_events_purpose_check CHECK (
        purpose IN ('PATIENT_INFORMATION', 'AEVYRA_MARKETING')
    ),
    CONSTRAINT contact_basis_events_channel_check CHECK (
        channel IN ('SMS', 'VIBER')
    ),
    CONSTRAINT contact_basis_events_event_type_check CHECK (
        event_type IN ('RECORD', 'WITHDRAW')
    ),
    CONSTRAINT contact_basis_events_revision_check CHECK (revision > 0),
    CONSTRAINT contact_basis_events_fingerprint_check CHECK (
        request_fingerprint COLLATE "C" ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT contact_basis_events_reference_check CHECK (
        reference IS NULL OR (
            char_length(reference) BETWEEN 1 AND 250
            AND reference ~ '[^[:space:]]'
            AND reference = btrim(reference)
        )
    ),
    CONSTRAINT contact_basis_events_payload_check CHECK (
        (
            event_type = 'RECORD'
            AND basis_type IS NOT NULL
            AND basis_type IN ('CONSENT', 'DOCUMENTED_BASIS')
            AND reference IS NOT NULL
            AND (expires_at IS NULL OR expires_at > recorded_at)
        ) OR (
            event_type = 'WITHDRAW'
            AND basis_type IS NULL
            AND expires_at IS NULL
        )
    )
);

CREATE INDEX contact_basis_events_operator_id_idx
    ON aevyra.contact_basis_events (operator_id);
