-- Up Migration
CREATE TABLE aevyra.contacts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES aevyra.organizations (id),
    normalized_phone text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT contacts_phone_e164_check CHECK (normalized_phone COLLATE "C" ~ '^[+][1-9][0-9]{1,14}$'),
    CONSTRAINT contacts_organization_phone_key UNIQUE (organization_id, normalized_phone),
    CONSTRAINT contacts_organization_id_key UNIQUE (organization_id, id)
);

CREATE TABLE aevyra.contact_imports (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES aevyra.organizations (id),
    operator_id text NOT NULL REFERENCES aevyra_auth."user" (id),
    created_at timestamptz NOT NULL DEFAULT now(),
    idempotency_key uuid NOT NULL,
    request_fingerprint text NOT NULL,
    source_sha256 text NOT NULL,
    source_format text NOT NULL,
    delimiter text,
    sheet_index integer,
    has_header boolean NOT NULL,
    phone_column integer NOT NULL,
    policy_version text NOT NULL,
    library_version text NOT NULL,
    total_records integer NOT NULL,
    excluded_empty_records integer NOT NULL,
    empty_phone integer NOT NULL,
    invalid integer NOT NULL,
    review integer NOT NULL,
    unique_valid integer NOT NULL,
    duplicate_valid integer NOT NULL,
    new_contacts integer NOT NULL,
    existing_contacts integer NOT NULL,
    CONSTRAINT contact_imports_organization_key_unique UNIQUE (organization_id, idempotency_key),
    CONSTRAINT contact_imports_organization_id_key UNIQUE (organization_id, id),
    CONSTRAINT contact_imports_hashes_check CHECK (
        request_fingerprint COLLATE "C" ~ '^[0-9a-f]{64}$' AND source_sha256 COLLATE "C" ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT contact_imports_source_check CHECK (
        phone_column BETWEEN 0 AND 49 AND (
            (source_format = 'csv' AND delimiter IS NOT NULL AND delimiter IN ('comma', 'semicolon', 'tab') AND sheet_index IS NULL)
            OR (source_format = 'xlsx' AND delimiter IS NULL AND sheet_index IS NOT NULL AND sheet_index BETWEEN 0 AND 9)
        )
    ),
    CONSTRAINT contact_imports_versions_check CHECK (
        policy_version COLLATE "C" ~ '^[A-Za-z0-9_.-]{1,64}$' AND library_version COLLATE "C" ~ '^[A-Za-z0-9_.-]{1,64}$'
    ),
    CONSTRAINT contact_imports_counts_check CHECK (
        total_records BETWEEN 1 AND 20000
        AND excluded_empty_records >= 0 AND empty_phone >= 0 AND invalid >= 0 AND review >= 0
        AND unique_valid > 0 AND duplicate_valid >= 0 AND new_contacts >= 0 AND existing_contacts >= 0
        AND total_records = excluded_empty_records::bigint + empty_phone + invalid + review + unique_valid + duplicate_valid
        AND unique_valid = new_contacts::bigint + existing_contacts
    )
);

CREATE INDEX contact_imports_operator_id_idx ON aevyra.contact_imports (operator_id);

CREATE TABLE aevyra.contact_import_contacts (
    organization_id uuid NOT NULL,
    import_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    source_record_number integer NOT NULL,
    CONSTRAINT contact_import_contacts_pkey PRIMARY KEY (organization_id, import_id, contact_id),
    CONSTRAINT contact_import_contacts_source_key UNIQUE (organization_id, import_id, source_record_number),
    CONSTRAINT contact_import_contacts_source_check CHECK (source_record_number BETWEEN 1 AND 20001),
    CONSTRAINT contact_import_contacts_import_fk FOREIGN KEY (organization_id, import_id)
        REFERENCES aevyra.contact_imports (organization_id, id),
    CONSTRAINT contact_import_contacts_contact_fk FOREIGN KEY (organization_id, contact_id)
        REFERENCES aevyra.contacts (organization_id, id)
);

CREATE INDEX contact_import_contacts_contact_idx ON aevyra.contact_import_contacts (organization_id, contact_id);
