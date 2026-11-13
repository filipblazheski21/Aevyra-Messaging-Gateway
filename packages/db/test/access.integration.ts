import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { withPostgresClient } from "../src/admin-client.ts";
import { applyMigrations, readMigrationStatus } from "../src/migrations.ts";
import { provisionAppRole } from "../src/provision.ts";
import { verifyTestTarget, withTestDatabase } from "./test-database.ts";

async function expectDenied(client: pg.Client, statements: string[]) {
  for (const sql of statements) {
    await client.query("BEGIN");
    try {
      await assert.rejects(client.query(sql), { code: "42501" }, sql);
    } finally {
      await client.query("ROLLBACK");
    }
  }
}

test("Ограничен пристап со вистински PostgreSQL конекции", { timeout: 90_000 }, async (suite) => {
  const target = verifyTestTarget();
  await withTestDatabase(target, async (admin, databaseUrl, database) => {
    const adminUrl = new URL(databaseUrl);
    const appUrl = new URL(databaseUrl);
    appUrl.username = database;
    appUrl.password = randomBytes(32).toString("base64url");
    const role = pg.escapeIdentifier(database);

    await suite.test("Административните команди одбиваат недостасувачка адреса без fallback", () => {
      const env = { ...process.env, DATABASE_ADMIN_URL: undefined, DATABASE_URL: appUrl.href };
      for (const args of [["migrate-cli.ts", "up"], ["migrate-cli.ts", "status"], ["provision-cli.ts"]]) {
        const [entry, ...params] = args;
        const result = spawnSync(process.execPath, [`packages/db/src/${entry}`, ...params], {
          env, encoding: "utf8", timeout: 5_000,
        });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /Недостасува DATABASE_ADMIN_URL/);
      }
    });

    assert.equal((await applyMigrations(databaseUrl)).length, 5);
    await suite.test("Подготовката одбива истоимена улога без проектна ознака", async () => {
      await admin.query(`CREATE ROLE ${role} NOLOGIN`);
      try {
        await assert.rejects(provisionAppRole(adminUrl, appUrl), /Постојната улога не е потврдена/);
        const { rows: [row] } = await admin.query("SELECT rolcanlogin FROM pg_roles WHERE rolname = $1", [database]);
        assert.equal(row.rolcanlogin, false);
      } finally {
        await admin.query(`DROP ROLE ${role}`);
      }
    });

    assert.equal(await provisionAppRole(adminUrl, appUrl), true);
    await admin.query("INSERT INTO aevyra.organizations (kind, name) VALUES ('CLINIC', 'Синтетичка проверка')");

    await withPostgresClient(appUrl.href, 30_000, async (app) => {
      await suite.test("Новата LOGIN конекција има точен идентитет, дозволи за читање и ограничени атрибути", async () => {
        const { rows: [row] } = await app.query(`
          SELECT current_user AS active, session_user AS login, rolcanlogin,
            rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolinherit,
            EXISTS (SELECT FROM pg_auth_members WHERE member = pg_roles.oid) AS member
          FROM pg_roles WHERE rolname = current_user
        `);
        assert.deepEqual(row, {
          active: database, login: database, rolcanlogin: true, rolsuper: false, rolcreatedb: false,
          rolcreaterole: false, rolreplication: false, rolbypassrls: false, rolinherit: false, member: false,
        });
        assert.equal((await app.query("SELECT 1 AS one")).rows[0].one, 1);
        assert.equal((await app.query("SELECT name FROM aevyra.organizations")).rows[0].name, "Синтетичка проверка");
      });

      await suite.test("Ограничената улога создава запис и менува име со RETURNING", async () => {
        const { rows: [created] } = await app.query(`
          INSERT INTO aevyra.organizations (name, kind) VALUES ($1, $2)
          RETURNING id, name, kind, created_at
        `, ["Синтетичка маркетинг база", "MARKETING"]);
        const { rows: [renamed] } = await app.query(`
          UPDATE aevyra.organizations SET name = $1 WHERE id = $2
          RETURNING id, name, kind, created_at
        `, ["Синтетичка измена", created.id]);
        assert.deepEqual(renamed, { ...created, name: "Синтетичка измена" });

        const { rows } = await app.query(`
          SELECT attname AS column,
            has_column_privilege(attrelid, attnum, 'INSERT') AS insert,
            has_column_privilege(attrelid, attnum, 'UPDATE') AS update,
            has_column_privilege(attrelid, attnum, 'SELECT WITH GRANT OPTION,INSERT WITH GRANT OPTION,UPDATE WITH GRANT OPTION') AS grant
          FROM pg_attribute WHERE attrelid = 'aevyra.organizations'::regclass AND attnum > 0
          ORDER BY attnum
        `);
        assert.deepEqual(rows, [
          { column: "id", insert: false, update: false, grant: false },
          { column: "kind", insert: true, update: false, grant: false },
          { column: "name", insert: true, update: true, grant: false },
          { column: "created_at", insert: false, update: false, grant: false },
        ]);
      });

      await suite.test("Забранетите колони, бришењето, DDL, TEMP, улогите и историјата остануваат блокирани", async () => {
        await expectDenied(app, [
          "INSERT INTO aevyra.organizations (id, kind, name) VALUES (gen_random_uuid(), 'CLINIC', 'Синтетички запис')",
          "INSERT INTO aevyra.organizations (created_at, kind, name) VALUES (now(), 'CLINIC', 'Синтетички запис')",
          "UPDATE aevyra.organizations SET id = id",
          "UPDATE aevyra.organizations SET kind = kind",
          "UPDATE aevyra.organizations SET created_at = created_at",
          "DELETE FROM aevyra.organizations",
          "CREATE TABLE public.deny_probe (id int)",
          "CREATE TABLE aevyra.deny_probe (id int)",
          "CREATE SCHEMA deny_probe",
          "CREATE TEMP TABLE deny_probe (id int)",
          "ALTER TABLE aevyra.organizations ADD COLUMN deny_probe int",
          "DROP TABLE aevyra.organizations",
          "TRUNCATE aevyra.organizations",
          "SELECT * FROM public.pgmigrations",
          "UPDATE public.pgmigrations SET name = 'deny_probe'",
          'INSERT INTO aevyra_auth."user" (id) VALUES (\'deny_probe\')',
          'DELETE FROM aevyra_auth."user"',
          'UPDATE aevyra_auth.account SET password = NULL',
          'DELETE FROM aevyra_auth.account',
          'UPDATE aevyra_auth.session SET "expiresAt" = now()',
          'TRUNCATE aevyra_auth.rate_limit',
          'SELECT * FROM aevyra_auth.verification',
          'CREATE TABLE aevyra_auth.deny_probe (id int)',
          `CREATE ROLE ${pg.escapeIdentifier(`${database}_deny`)}`,
          `SET ROLE ${pg.escapeIdentifier(target.project.adminRole)}`,
        ]);
      });

      await suite.test("Новите табели дозволуваат читање и точно определени колони за внесување", async () => {
        const insertable = {
          contacts: ["organization_id", "normalized_phone"],
          contact_imports: [
            "organization_id", "operator_id", "idempotency_key", "request_fingerprint", "source_sha256", "source_format",
            "delimiter", "sheet_index", "has_header", "phone_column", "policy_version", "library_version", "total_records",
            "excluded_empty_records", "empty_phone", "invalid", "review", "unique_valid", "duplicate_valid", "new_contacts", "existing_contacts",
          ],
          contact_import_contacts: ["organization_id", "import_id", "contact_id", "source_record_number"],
          contact_suppressions: ["organization_id", "contact_id", "operator_id", "reason", "reference"],
          contact_basis_events: [
            "organization_id", "contact_id", "purpose", "channel", "event_type", "operator_id", "revision",
            "idempotency_key", "request_fingerprint", "basis_type", "reference", "expires_at",
          ],
        };
        for (const [table, columns] of Object.entries(insertable)) {
          const relation = `aevyra.${table}`;
          assert.equal((await app.query(`SELECT * FROM ${relation}`)).rowCount, 0);
          const { rows: [access] } = await app.query(`
            SELECT relowner = current_user::regrole AS owner,
              has_table_privilege(oid, 'SELECT') AS readable,
              has_table_privilege(oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN,SELECT WITH GRANT OPTION') AS extra_table,
              has_any_column_privilege(oid, 'UPDATE,REFERENCES,SELECT WITH GRANT OPTION,INSERT WITH GRANT OPTION') AS extra_column,
              ARRAY(SELECT attname::text FROM pg_attribute
                    WHERE attrelid = pg_class.oid AND attnum > 0 AND has_column_privilege(attrelid, attnum, 'INSERT')
                    ORDER BY attnum) AS insertable
            FROM pg_class WHERE oid = $1::regclass
          `, [relation]);
          assert.deepEqual(access, { owner: false, readable: true, extra_table: false, extra_column: false, insertable: columns });
          await expectDenied(app, [
            `UPDATE ${relation} SET organization_id = organization_id`,
            `DELETE FROM ${relation}`,
            `TRUNCATE ${relation}`,
            `ALTER TABLE ${relation} ADD COLUMN deny_probe int`,
            `DROP TABLE ${relation}`,
          ]);
        }
        await expectDenied(app, [
          "INSERT INTO aevyra.contacts (id) VALUES (gen_random_uuid())",
          "INSERT INTO aevyra.contacts (created_at) VALUES (now())",
          "INSERT INTO aevyra.contact_imports (id) VALUES (gen_random_uuid())",
          "INSERT INTO aevyra.contact_imports (created_at) VALUES (now())",
          "INSERT INTO aevyra.contact_suppressions (id) VALUES (gen_random_uuid())",
          "INSERT INTO aevyra.contact_suppressions (recorded_at) VALUES (now())",
          "INSERT INTO aevyra.contact_basis_events (id) VALUES (gen_random_uuid())",
          "INSERT INTO aevyra.contact_basis_events (recorded_at) VALUES (now())",
          "CREATE TABLE aevyra.deny_reference (id uuid REFERENCES aevyra.contacts (id))",
        ]);
      });
    });

    await suite.test("Повторната подготовка ги зачувува улогата, лозинката, ACL, податоците и миграциите", async () => {
      const snapshot = async () => (await admin.query(`
        SELECT r.oid, r.rolpassword, d.datacl::text, a.nspacl::text, p.nspacl::text AS public_acl,
          o.relacl::text, m.relacl::text AS migration_acl,
          ARRAY(SELECT attacl::text FROM pg_attribute WHERE attrelid = o.oid AND attnum > 0 ORDER BY attnum) AS column_acl,
          ARRAY(SELECT row_to_json(x) FROM aevyra.organizations x ORDER BY id)::text AS organizations,
          ARRAY(SELECT row_to_json(x) FROM public.pgmigrations x ORDER BY id)::text AS history,
          ARRAY(SELECT jsonb_build_object('table', c.relname, 'table_acl', c.relacl::text, 'column_acl',
              ARRAY(SELECT attacl::text FROM pg_attribute WHERE attrelid = c.oid AND attnum > 0 ORDER BY attnum))
            FROM pg_class c WHERE c.oid IN ('aevyra.contacts'::regclass, 'aevyra.contact_imports'::regclass,
              'aevyra.contact_import_contacts'::regclass, 'aevyra.contact_suppressions'::regclass,
              'aevyra.contact_basis_events'::regclass)
            ORDER BY c.relname)::text AS contact_acl,
          r.oid IN (d.datdba, a.nspowner, p.nspowner, o.relowner, m.relowner) AS owner,
          has_table_privilege(r.oid, m.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') AS history_access,
          has_table_privilege(r.oid, o.oid, 'REFERENCES,TRIGGER,MAINTAIN,SELECT WITH GRANT OPTION') AS extra_access
        FROM pg_authid r, pg_database d, pg_namespace a, pg_namespace p, pg_class o, pg_class m
        WHERE r.rolname = $1 AND d.datname = current_database() AND a.nspname = 'aevyra' AND p.nspname = 'public'
          AND o.oid = 'aevyra.organizations'::regclass AND m.oid = 'public.pgmigrations'::regclass
      `, [database])).rows[0];
      const before = await snapshot();
      assert.equal(before.owner, false);
      assert.equal(before.history_access, false);
      assert.equal(before.extra_access, false);
      await admin.query(`GRANT UPDATE (kind) ON aevyra.organizations TO ${role}`);
      await admin.query("GRANT INSERT (id) ON aevyra.organizations TO PUBLIC");
      await admin.query(`GRANT UPDATE (normalized_phone) ON aevyra.contacts TO ${role}`);
      await admin.query("GRANT INSERT (id) ON aevyra.contact_imports TO PUBLIC");
      await admin.query(`GRANT DELETE ON aevyra.contact_import_contacts TO ${role}`);
      await admin.query(`GRANT UPDATE (reason) ON aevyra.contact_suppressions TO ${role}`);
      await admin.query("GRANT INSERT (id) ON aevyra.contact_suppressions TO PUBLIC");
      await admin.query(`GRANT UPDATE (reference) ON aevyra.contact_basis_events TO ${role}`);
      await admin.query("GRANT INSERT (id) ON aevyra.contact_basis_events TO PUBLIC");
      assert.equal(await provisionAppRole(adminUrl, appUrl), false);
      const after = await snapshot();
      assert.ok(before.rolpassword && before.rolpassword === after.rolpassword, "Лозинката на улогата мора да остане иста.");
      delete before.rolpassword;
      delete after.rolpassword;
      assert.deepEqual(after, before);
      assert.equal((await applyMigrations(databaseUrl)).length, 0);
      assert.deepEqual(await readMigrationStatus(databaseUrl), {
        hasHistory: true, applied: [
          "1794229200000_organizations", "1794229200001_auth", "1794229200002_contact_imports",
          "1794229200003_contact_suppressions",
          "1794229200004_contact_basis_events",
        ], pending: [],
      });
    });
  });
});
