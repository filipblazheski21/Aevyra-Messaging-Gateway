import { ServerConfigError } from "@aevyra/config";
import { PG_MIGRATE_LOCK_ID } from "node-pg-migrate";
import pg from "pg";
import { withPostgresClient } from "./admin-client.ts";
import { isLocalDatabaseUrl } from "./local-project.ts";

export const appRole = "aevyra_app";
const operationTimeoutMs = 30_000;

type BusinessTablePermissions = { insert: readonly string[]; update: readonly string[] };

const gatewayConfigColumns = [
  "name", "base_url", "username", "password", "device_id", "enabled",
] as const;

const businessTablePermissions: Record<string, BusinessTablePermissions> = {
  contacts: { insert: ["organization_id", "normalized_phone"], update: [] },
  contact_imports: { insert: [
    "organization_id", "operator_id", "idempotency_key", "request_fingerprint", "source_sha256",
    "source_format", "delimiter", "sheet_index", "has_header", "phone_column", "policy_version", "library_version",
    "total_records", "excluded_empty_records", "empty_phone", "invalid", "review", "unique_valid", "duplicate_valid",
    "new_contacts", "existing_contacts",
  ], update: [] },
  contact_import_contacts: { insert: ["organization_id", "import_id", "contact_id", "source_record_number"], update: [] },
  contact_suppressions: { insert: ["organization_id", "contact_id", "operator_id", "reason", "reference"], update: [] },
  contact_basis_events: { insert: [
    "organization_id", "contact_id", "purpose", "channel", "event_type", "operator_id", "revision",
    "idempotency_key", "request_fingerprint", "basis_type", "reference", "expires_at",
  ], update: [] },
  message_templates: { insert: ["organization_id", "purpose", "name", "created_by_operator_id"], update: [] },
  message_template_versions: { insert: [
    "template_id", "organization_id", "version_number", "body", "allowed_variables", "created_by_operator_id",
  ], update: [] },
  campaigns: { insert: ["organization_id", "purpose", "channel", "name", "template_version_id", "created_by_operator_id"], update: [] },
  campaign_recipients: { insert: ["campaign_id", "organization_id", "contact_id", "frozen_body"], update: [] },
  campaign_approvals: { insert: ["campaign_id", "organization_id", "decision", "operator_id"], update: [] },
  message_jobs: { insert: [
    "organization_id", "campaign_id", "recipient_id", "contact_id", "channel", "frozen_body", "idempotency_key",
    "gateway_id",
  ], update: ["gateway_id"] },
  message_job_events: { insert: ["job_id", "organization_id", "status", "detail"], update: [] },
  campaign_control_events: { insert: ["campaign_id", "organization_id", "action", "operator_id"], update: [] },
  sms_gateways: {
    insert: [...gatewayConfigColumns],
    update: [
      ...gatewayConfigColumns,
      "last_used_at", "last_checked_at", "last_check_status", "last_check_detail", "updated_at",
    ],
  },
};

async function provisionBusinessTables(client: pg.Client, role: string, identifier: string) {
  for (const [table, permissions] of Object.entries(businessTablePermissions)) {
    const relation = `aevyra.${table}`;
    const insertColumns = [...permissions.insert];
    const updateColumns = [...permissions.update];
    await client.query(`REVOKE ALL ON TABLE ${relation} FROM PUBLIC, ${identifier}`);
    await client.query(`GRANT SELECT ON TABLE ${relation} TO ${identifier}`);
    await client.query(`GRANT INSERT (${insertColumns.join(", ")}) ON TABLE ${relation} TO ${identifier}`);
    if (updateColumns.length > 0) {
      await client.query(`GRANT UPDATE (${updateColumns.join(", ")}) ON TABLE ${relation} TO ${identifier}`);
    }
    const { rows: [access] } = await client.query<{ safe: boolean }>(`
      SELECT has_table_privilege($1, $2::regclass, 'SELECT')
        AND NOT has_table_privilege($1, $2::regclass,
          'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN,SELECT WITH GRANT OPTION')
        AND NOT EXISTS (
          SELECT FROM pg_attribute WHERE attrelid = $2::regclass AND attnum > 0 AND NOT attisdropped
            AND (has_column_privilege($1, attrelid, attnum, 'INSERT') <> (attname::text = ANY($3::text[]))
              OR has_column_privilege($1, attrelid, attnum, 'UPDATE') <> (attname::text = ANY($4::text[]))
              OR has_column_privilege($1, attrelid, attnum,
                'REFERENCES,SELECT WITH GRANT OPTION,INSERT WITH GRANT OPTION,UPDATE WITH GRANT OPTION'))
        ) AS safe
    `, [role, relation, insertColumns, updateColumns]);
    if (!access.safe) {
      throw new ServerConfigError("Ефективните PostgreSQL права за деловните табели ја надминуваат дозволената граница.");
    }
  }
}

export function appRoleMarker(databaseOid: string) {
  return `aevyra-messaging-gateway:app:${databaseOid}`;
}

export async function provisionAppRole(adminUrl: URL, appUrl: URL) {
  const port = adminUrl.port || "5432";
  const role = appUrl.username;
  const password = appUrl.password;
  if (!isLocalDatabaseUrl(adminUrl, port) || !isLocalDatabaseUrl(appUrl, port)
      || adminUrl.pathname !== appUrl.pathname || adminUrl.username === role
      || (role !== appRole && !/^aevyra_test_[a-f0-9]{32}$/.test(role)) || !/^[A-Za-z0-9_-]{43,}$/.test(password)) {
    throw new ServerConfigError("Потребни се две одделни локални сметки за истата база и случајна апликациска лозинка.");
  }
  const identifier = pg.escapeIdentifier(role);

  const created = await withPostgresClient(adminUrl.href, operationTimeoutMs, async (client) => {
    const { rows: [target] } = await client.query<{ database: string; oid: string; admin: boolean }>(`
      SELECT datname AS database, oid::text, current_user = session_user AND
        (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = session_user) AS admin
      FROM pg_catalog.pg_database WHERE datname = current_database()
    `);
    if (!target.admin || `/${encodeURIComponent(target.database)}` !== adminUrl.pathname) {
      throw new ServerConfigError("Подготовката бара директна административна конекција до избраната проектна база.");
    }
    const marker = appRoleMarker(target.oid);
    const database = pg.escapeIdentifier(target.database);

    await client.query("BEGIN");
    await client.query("SET LOCAL search_path = pg_catalog");
    const { rows: [lock] } = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_xact_lock($1::bigint) AS acquired", [PG_MIGRATE_LOCK_ID],
    );
    if (!lock.acquired) {
      throw new ServerConfigError("Миграција или подготовка веќе се извршува. Повторете ја командата по завршувањето.");
    }

    const { rows: [existing] } = await client.query<{ marker: string | null; safe: boolean }>(`
      SELECT shobj_description(oid, 'pg_authid') AS marker,
        rolcanlogin AND NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolinherit)
        AND NOT EXISTS (SELECT FROM pg_auth_members WHERE member = pg_roles.oid)
        AND NOT EXISTS (SELECT FROM pg_shdepend WHERE refclassid = 'pg_authid'::regclass
                        AND refobjid = pg_roles.oid AND deptype = 'o') AS safe
      FROM pg_roles WHERE rolname = $1
    `, [role]);
    if (existing && (existing.marker !== marker || !existing.safe)) {
      throw new ServerConfigError("Постојната улога не е потврдена како безбедна проектна улога за оваа база.");
    }
    if (!existing) {
      await client.query("SET LOCAL password_encryption = 'scram-sha-256'");
      await client.query(`CREATE ROLE ${identifier} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD ${pg.escapeLiteral(password)}`);
      await client.query(`COMMENT ON ROLE ${identifier} IS ${pg.escapeLiteral(marker)}`);
    }

    await client.query(`REVOKE CREATE, TEMPORARY ON DATABASE ${database} FROM PUBLIC`);
    await client.query(`REVOKE ALL ON DATABASE ${database} FROM ${identifier}`);
    await client.query(`REVOKE ALL ON SCHEMA public, aevyra, aevyra_auth FROM PUBLIC, ${identifier}`);
    await client.query(`REVOKE ALL ON TABLE aevyra.organizations, public.pgmigrations FROM PUBLIC, ${identifier}`);
    await client.query(`REVOKE ALL ON TABLE aevyra_auth."user", aevyra_auth.account, aevyra_auth.session,
      aevyra_auth.verification, aevyra_auth.rate_limit FROM PUBLIC, ${identifier}`);
    await client.query(`GRANT CONNECT ON DATABASE ${database} TO ${identifier}`);
    await client.query(`GRANT USAGE ON SCHEMA aevyra TO ${identifier}`);
    await client.query(`GRANT SELECT ON TABLE aevyra.organizations TO ${identifier}`);
    await client.query(`GRANT INSERT (name, kind), UPDATE (name) ON TABLE aevyra.organizations TO ${identifier}`);
    await client.query(`GRANT USAGE ON SCHEMA aevyra_auth TO ${identifier}`);
    await client.query(`GRANT SELECT ON TABLE aevyra_auth."user", aevyra_auth.account TO ${identifier}`);
    await client.query(`GRANT SELECT, INSERT, DELETE ON TABLE aevyra_auth.session TO ${identifier}`);
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE aevyra_auth.rate_limit TO ${identifier}`);
    await provisionBusinessTables(client, role, identifier);

    const { rows: [access] } = await client.query<{ safe: boolean }>(`
      SELECT has_database_privilege($1, current_database(), 'CONNECT')
        AND NOT has_database_privilege($1, current_database(), 'CREATE,TEMPORARY,CONNECT WITH GRANT OPTION')
        AND has_schema_privilege($1, 'aevyra', 'USAGE')
        AND NOT has_schema_privilege($1, 'aevyra', 'CREATE,USAGE WITH GRANT OPTION')
        AND NOT has_schema_privilege($1, 'public', 'CREATE,USAGE')
        AND has_table_privilege($1, 'aevyra.organizations', 'SELECT')
        AND NOT has_table_privilege($1, 'aevyra.organizations', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN,SELECT WITH GRANT OPTION')
        AND has_column_privilege($1, 'aevyra.organizations', 'name', 'INSERT')
        AND has_column_privilege($1, 'aevyra.organizations', 'kind', 'INSERT')
        AND has_column_privilege($1, 'aevyra.organizations', 'name', 'UPDATE')
        AND NOT has_column_privilege($1, 'aevyra.organizations', 'kind', 'UPDATE')
        AND NOT has_column_privilege($1, 'aevyra.organizations', 'id', 'INSERT,UPDATE')
        AND NOT has_column_privilege($1, 'aevyra.organizations', 'created_at', 'INSERT,UPDATE')
        AND NOT has_any_column_privilege($1, 'aevyra.organizations', 'REFERENCES,SELECT WITH GRANT OPTION,INSERT WITH GRANT OPTION,UPDATE WITH GRANT OPTION')
        AND NOT has_table_privilege($1, 'public.pgmigrations', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
        AND NOT has_any_column_privilege($1, 'public.pgmigrations', 'SELECT,INSERT,UPDATE,REFERENCES')
        AND has_schema_privilege($1, 'aevyra_auth', 'USAGE')
        AND NOT has_schema_privilege($1, 'aevyra_auth', 'CREATE,USAGE WITH GRANT OPTION')
        AND NOT EXISTS (
          SELECT FROM (VALUES
            ('aevyra_auth."user"', 'INSERT,UPDATE,DELETE', 'INSERT,UPDATE'),
            ('aevyra_auth.account', 'INSERT,UPDATE,DELETE', 'INSERT,UPDATE'),
            ('aevyra_auth.session', 'UPDATE', 'UPDATE'),
            ('aevyra_auth.verification', 'SELECT,INSERT,UPDATE,DELETE', 'SELECT,INSERT,UPDATE'),
            ('aevyra_auth.rate_limit', '', '')
          ) AS auth_table(name, forbidden, column_forbidden)
          WHERE has_table_privilege($1, name, concat_ws(',', NULLIF(forbidden, ''),
              'TRUNCATE,REFERENCES,TRIGGER,MAINTAIN,SELECT WITH GRANT OPTION,INSERT WITH GRANT OPTION,UPDATE WITH GRANT OPTION,DELETE WITH GRANT OPTION'))
            OR has_any_column_privilege($1, name, concat_ws(',', NULLIF(column_forbidden, ''),
              'REFERENCES,SELECT WITH GRANT OPTION,INSERT WITH GRANT OPTION,UPDATE WITH GRANT OPTION'))
        ) AS safe
    `, [role]);
    if (!access.safe) {
      throw new ServerConfigError("Ефективните PostgreSQL права ја надминуваат дозволената граница.");
    }
    await client.query("COMMIT");
    return !existing;
  });

  await withPostgresClient(appUrl.href, operationTimeoutMs, async (client) => {
    const { rows: [login] } = await client.query<{ role: string; session: string }>(
      "SELECT current_user AS role, session_user AS session",
    );
    if (login.role !== role || login.session !== role) {
      throw new ServerConfigError("Новата конекција не ја користи очекуваната апликациска улога.");
    }
    await client.query("SELECT 1 FROM aevyra.organizations LIMIT 1");
    for (const table of Object.keys(businessTablePermissions)) {
      await client.query(`SELECT 1 FROM aevyra.${table} LIMIT 1`);
    }
  });
  return created;
}
