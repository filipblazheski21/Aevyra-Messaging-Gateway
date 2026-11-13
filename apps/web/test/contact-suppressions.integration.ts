import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type pg from "pg";
import { applyMigrations, readMigrationStatus } from "../../../packages/db/src/migrations.ts";
import { provisionAppRole } from "../../../packages/db/src/provision.ts";
import { verifyTestTarget, withTestDatabase } from "../../../packages/db/test/test-database.ts";
import type { OrganizationKind } from "../src/organizations.ts";
import { createAuth } from "../src/server/auth-core.ts";
import {
  readContactSuppression,
  recordContactSuppression,
} from "../src/server/contact-suppressions.ts";
import type { PreparedContactSuppression } from "../src/server/contact-suppressions.ts";
import {
  contactImportLibraryVersion,
  savePreparedContactImport,
} from "../src/server/contact-imports.ts";
import type { PreparedContactImport } from "../src/server/contact-imports.ts";
import { createCredentialUser } from "../src/server/create-credential-user.ts";

const sharedPhone = "+12025550177";
const sourceHash = createHash("sha256").update("synthetic suppression import").digest("hex");

async function waitForBlocked(admin: pg.Client, command: string) {
  const deadline = Date.now() + 3_500;
  do {
    const { rows: [blocked] } = await admin.query<{ pid: number }>(`
      SELECT pid FROM pg_stat_activity WHERE datname = current_database()
        AND pg_backend_pid() = ANY(pg_blocking_pids(pid)) AND query = $1
    `, [command]);
    if (blocked) return blocked.pid;
    await delay(25);
  } while (Date.now() < deadline);
  assert.fail("Не е забележана очекуваната PostgreSQL брава.");
}

async function expectDenied(client: pg.Pool, statements: string[]) {
  for (const sql of statements) {
    await client.query("BEGIN");
    try {
      await assert.rejects(client.query(sql), { code: "42501" }, sql);
    } finally {
      await client.query("ROLLBACK");
    }
  }
}

test("Серверска евиденција „Не контактирај“ по организација", { timeout: 120_000 }, async (suite) => {
  await withTestDatabase(verifyTestTarget(), async (admin, databaseUrl, database) => {
    assert.equal((await applyMigrations(databaseUrl)).length, 5);
    const adminUrl = new URL(databaseUrl);
    const appUrl = new URL(databaseUrl);
    appUrl.username = database;
    appUrl.password = randomBytes(32).toString("base64url");
    assert.equal(await provisionAppRole(adminUrl, appUrl), true);
    const settings = {
      baseURL: "http://127.0.0.1:3000",
      secureCookies: false,
      secret: randomBytes(32).toString("base64url"),
    };
    const createOperator = (email: string) => createCredentialUser(databaseUrl, settings, {
      name: "Синтетички оператор",
      email,
      password: randomBytes(24).toString("base64url"),
    });
    const operatorId = await createOperator("suppression@example.test");
    const otherOperatorId = await createOperator("suppression-other@example.test");
    const { pool } = createAuth(appUrl.href, settings);

    const createOrganization = async (kind: OrganizationKind = "CLINIC") => (
      await pool.query<{ id: string }>(
        "INSERT INTO aevyra.organizations (name, kind) VALUES ($1, $2) RETURNING id",
        ["Синтетичка организација", kind],
      )
    ).rows[0].id;
    const preparedImport = (organizationId: string, phones: string[]): PreparedContactImport => ({
      organizationId,
      operatorId,
      idempotencyKey: randomUUID(),
      sourceSha256: sourceHash,
      source: { format: "csv", delimiter: "comma", hasHeader: true, phoneColumn: 0 },
      policyVersion: "phone-normalization-v1",
      libraryVersion: contactImportLibraryVersion,
      totalRecords: phones.length,
      counts: {
        excludedEmptyRecords: 0,
        emptyPhone: 0,
        invalid: 0,
        review: 0,
        uniqueValid: phones.length,
        duplicateValid: 0,
      },
      candidates: phones.map((normalizedPhone, index) => ({ normalizedPhone, sourceRecordNumber: index + 2 })),
    });
    const importPhones = (organizationId: string, phones: string[], targetPool = pool) => (
      savePreparedContactImport(preparedImport(organizationId, phones), targetPool)
    );
    const contact = async (organizationId: string, phone = sharedPhone) => (
      await admin.query<{ id: string }>(`
        SELECT id FROM aevyra.contacts WHERE organization_id = $1 AND normalized_phone = $2
      `, [organizationId, phone])
    ).rows[0];
    const input = (
      organizationId: string,
      contactId: string,
      overrides: Partial<PreparedContactSuppression> = {},
    ): PreparedContactSuppression => ({
      organizationId,
      contactId,
      operatorId,
      reason: "CONTACT_REQUEST",
      reference: "CASE-001",
      ...overrides,
    });
    const write = (value: PreparedContactSuppression, targetPool = pool) => recordContactSuppression(value, targetPool);
    const read = (organizationId: string, contactId: string, targetPool = pool) => (
      readContactSuppression(organizationId, contactId, targetPool)
    );

    try {
      await suite.test("Првото евидентирање и читањето го враќаат записот зададен од базата", async () => {
        const organizationId = await createOrganization();
        await importPhones(organizationId, [sharedPhone]);
        const { id: contactId } = await contact(organizationId);
        const result = await write(input(organizationId, contactId));
        assert.equal(result.outcome, "RECORDED");
        assert.match(result.suppression.id, /^[a-f0-9-]{36}$/);
        assert.equal(result.suppression.organizationId, organizationId);
        assert.equal(result.suppression.contactId, contactId);
        assert.equal(result.suppression.operatorId, operatorId);
        assert.equal(result.suppression.reason, "CONTACT_REQUEST");
        assert.equal(result.suppression.reference, "CASE-001");
        assert.ok(Number.isFinite(Date.parse(result.suppression.recordedAt)));
        assert.deepEqual(await read(organizationId, contactId), result.suppression);
      });

      await suite.test("Непостоечки контакт, погрешна организација и непостоечки оператор се разликуваат", async () => {
        const first = await createOrganization();
        const second = await createOrganization();
        await importPhones(first, ["+12025550178"]);
        const { id: contactId } = await contact(first, "+12025550178");
        await assert.rejects(write(input(first, randomUUID())), { code: "CONTACT_NOT_FOUND" });
        await assert.rejects(write(input(second, contactId)), { code: "CONTACT_NOT_FOUND" });
        await assert.rejects(read(second, contactId), { code: "CONTACT_NOT_FOUND" });
        await assert.rejects(write(input(first, contactId, { operatorId: "missing_operator" })), { code: "OPERATOR_NOT_FOUND" });
        assert.equal((await admin.query("SELECT count(*)::int AS count FROM aevyra.contact_suppressions")).rows[0].count, 1);
      });

      await suite.test("Невалидни причини, референци и полиња се одбиваат на сервер и во база", async () => {
        const organizationId = await createOrganization();
        await importPhones(organizationId, ["+12025550179"]);
        const { id: contactId } = await contact(organizationId, "+12025550179");
        const base = input(organizationId, contactId);
        await assert.rejects(write({ ...base, reason: "OTHER" as never }), { code: "INVALID_INPUT" });
        await assert.rejects(write({ ...base, reference: "а".repeat(251) }), { code: "INVALID_INPUT" });
        await assert.rejects(write({ ...base, reference: "\ud800" }), { code: "INVALID_INPUT" });
        await assert.rejects(write({ ...base, extra: true } as never), { code: "INVALID_INPUT" });

        const direct = (reason: string, reference: string | null) => admin.query(`
          INSERT INTO aevyra.contact_suppressions (organization_id, contact_id, operator_id, reason, reference)
          VALUES ($1, $2, $3, $4, $5)
        `, [organizationId, contactId, operatorId, reason, reference]);
        await assert.rejects(direct("OTHER", null), { code: "23514", constraint: "contact_suppressions_reason_check" });
        await assert.rejects(direct("CONTACT_REQUEST", " ".repeat(2)), {
          code: "23514", constraint: "contact_suppressions_reference_check",
        });
        await assert.rejects(direct("CONTACT_REQUEST", "а".repeat(251)), {
          code: "23514", constraint: "contact_suppressions_reference_check",
        });
      });

      await suite.test("Истиот телефон останува независен во две клиники и маркетинг база", async () => {
        const organizations = [
          await createOrganization("CLINIC"),
          await createOrganization("CLINIC"),
          await createOrganization("MARKETING"),
        ];
        for (const organizationId of organizations) await importPhones(organizationId, [sharedPhone]);
        const contacts = [];
        for (const organizationId of organizations) contacts.push((await contact(organizationId)).id);
        assert.equal(new Set(contacts).size, 3);
        const result = await write(input(organizations[0], contacts[0], { reason: "ORGANIZATION_REQUEST" }));
        assert.equal(result.outcome, "RECORDED");
        assert.deepEqual(await read(organizations[0], contacts[0]), result.suppression);
        assert.equal(await read(organizations[1], contacts[1]), null);
        assert.equal(await read(organizations[2], contacts[2]), null);
      });

      await suite.test("Повторувањето со исти или различни метаподатоци не го препишува оригиналот", async () => {
        const organizationId = await createOrganization();
        await importPhones(organizationId, ["+12025550180"]);
        const { id: contactId } = await contact(organizationId, "+12025550180");
        const original = await write(input(organizationId, contactId));
        const same = await write(input(organizationId, contactId));
        const different = await write(input(organizationId, contactId, {
          operatorId: otherOperatorId,
          reason: "INTERNAL_BLOCK",
          reference: "CASE-CHANGED",
        }));
        assert.equal(same.outcome, "ALREADY_RECORDED");
        assert.equal(different.outcome, "ALREADY_RECORDED_DIFFERENT_METADATA");
        assert.deepEqual(same.suppression, original.suppression);
        assert.deepEqual(different.suppression, original.suppression);
        assert.deepEqual(await read(organizationId, contactId), original.suppression);
      });

      await suite.test("Паралелните барања создаваат точно еден запис со ист UUID", async () => {
        const organizationId = await createOrganization();
        await importPhones(organizationId, ["+12025550181"]);
        const { id: contactId } = await contact(organizationId, "+12025550181");
        const results = await Promise.all(Array.from({ length: 8 }, () => write(input(organizationId, contactId))));
        assert.equal(results.filter(({ outcome }) => outcome === "RECORDED").length, 1);
        assert.equal(new Set(results.map(({ suppression }) => suppression.id)).size, 1);
        const count = await admin.query(
          "SELECT count(*)::int AS count FROM aevyra.contact_suppressions WHERE organization_id = $1 AND contact_id = $2",
          [organizationId, contactId],
        );
        assert.equal(count.rows[0].count, 1);
      });

      await suite.test("Составениот клуч одбива контакт од друга организација", async () => {
        const first = await createOrganization();
        const second = await createOrganization();
        await importPhones(second, ["+12025550182"]);
        const { id: contactId } = await contact(second, "+12025550182");
        await assert.rejects(admin.query(`
          INSERT INTO aevyra.contact_suppressions (organization_id, contact_id, operator_id, reason)
          VALUES ($1, $2, $3, 'CONTACT_REQUEST')
        `, [first, contactId, operatorId]), { code: "23503", constraint: "contact_suppressions_contact_fk" });
      });

      await suite.test("Ограничената улога има само читање и внесување на потребните колони", async () => {
        const { rows: [access] } = await pool.query(`
          SELECT has_table_privilege('aevyra.contact_suppressions', 'SELECT') AS readable,
            has_table_privilege('aevyra.contact_suppressions',
              'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN,SELECT WITH GRANT OPTION') AS extra_table,
            has_any_column_privilege('aevyra.contact_suppressions',
              'UPDATE,REFERENCES,SELECT WITH GRANT OPTION,INSERT WITH GRANT OPTION') AS extra_column,
            ARRAY(SELECT attname::text FROM pg_attribute
              WHERE attrelid = 'aevyra.contact_suppressions'::regclass AND attnum > 0
                AND has_column_privilege(attrelid, attnum, 'INSERT') ORDER BY attnum) AS insertable
        `);
        assert.deepEqual(access, {
          readable: true,
          extra_table: false,
          extra_column: false,
          insertable: ["organization_id", "contact_id", "operator_id", "reason", "reference"],
        });
        await expectDenied(pool, [
          "UPDATE aevyra.contact_suppressions SET reason = reason",
          "DELETE FROM aevyra.contact_suppressions",
          "TRUNCATE aevyra.contact_suppressions",
          "ALTER TABLE aevyra.contact_suppressions ADD COLUMN deny_probe int",
          "DROP TABLE aevyra.contact_suppressions",
          "INSERT INTO aevyra.contact_suppressions (id) VALUES (gen_random_uuid())",
          "INSERT INTO aevyra.contact_suppressions (recorded_at) VALUES (now())",
        ]);
      });

      await suite.test("Неизвесен COMMIT се разрешува со читање и безбедно повторување", async () => {
        const organizationId = await createOrganization();
        await importPhones(organizationId, ["+12025550183"]);
        const { id: contactId } = await contact(organizationId, "+12025550183");
        const prepared = input(organizationId, contactId);
        await admin.query(`
          CREATE FUNCTION aevyra.test_suppression_commit() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN PERFORM pg_advisory_xact_lock(2141030002, 18); RETURN NEW; END; $$;
          CREATE CONSTRAINT TRIGGER test_suppression_commit AFTER INSERT ON aevyra.contact_suppressions
            DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION aevyra.test_suppression_commit()
        `);
        await admin.query("SELECT pg_advisory_lock(2141030002, 18)");
        const pending = write(prepared);
        void pending.catch(() => {});
        try {
          const pid = await waitForBlocked(admin, "COMMIT");
          const { rows: [terminated] } = await admin.query("SELECT pg_terminate_backend($1, 1000) AS stopped", [pid]);
          assert.equal(terminated.stopped, true);
          await assert.rejects(pending, { code: "OUTCOME_UNKNOWN" });
        } finally {
          await admin.query("SELECT pg_advisory_unlock(2141030002, 18)");
          await pending.catch(() => {});
          await admin.query(`
            DROP TRIGGER test_suppression_commit ON aevyra.contact_suppressions;
            DROP FUNCTION aevyra.test_suppression_commit()
          `);
        }
        assert.equal(await read(organizationId, contactId), null);
        assert.equal((await write(prepared)).outcome, "RECORDED");
        assert.ok(await read(organizationId, contactId));
      });

      await suite.test("Изгубен успешен одговор и повторен увоз ги зачувуваат двата UUID", async () => {
        const organizationId = await createOrganization();
        await importPhones(organizationId, ["+12025550184"]);
        const beforeContact = await contact(organizationId, "+12025550184");
        const prepared = input(organizationId, beforeContact.id, { reference: "CASE-LOST" });
        const first = createAuth(appUrl.href, settings).pool;
        const next = createAuth(appUrl.href, settings).pool;
        try {
          await recordContactSuppression(prepared, first);
          await first.end();
          const recovered = await readContactSuppression(organizationId, beforeContact.id, next);
          assert.ok(recovered);
          const repeated = await recordContactSuppression(prepared, next);
          assert.equal(repeated.outcome, "ALREADY_RECORDED");
          assert.equal(repeated.suppression.id, recovered.id);

          const importedAgain = await importPhones(organizationId, ["+12025550184"], next);
          assert.deepEqual([importedAgain.newContacts, importedAgain.existingContacts], [0, 1]);
          const afterContact = await contact(organizationId, "+12025550184");
          assert.equal(afterContact.id, beforeContact.id);
          assert.equal((await readContactSuppression(organizationId, afterContact.id, next))?.id, recovered.id);
        } finally {
          if (!first.ended) await first.end();
          await next.end();
        }
      });

      await suite.test("Повторната миграција и подготовка не менуваат записи или права", async () => {
        const before = (await admin.query(`
          SELECT jsonb_agg(to_jsonb(suppression) ORDER BY id)::text AS suppressions
          FROM aevyra.contact_suppressions AS suppression
        `)).rows[0].suppressions;
        assert.equal((await applyMigrations(databaseUrl)).length, 0);
        assert.equal(await provisionAppRole(adminUrl, appUrl), false);
        const after = (await admin.query(`
          SELECT jsonb_agg(to_jsonb(suppression) ORDER BY id)::text AS suppressions
          FROM aevyra.contact_suppressions AS suppression
        `)).rows[0].suppressions;
        assert.equal(after, before);
        assert.deepEqual(await readMigrationStatus(databaseUrl), {
          hasHistory: true,
          applied: [
            "1794229200000_organizations",
            "1794229200001_auth",
            "1794229200002_contact_imports",
            "1794229200003_contact_suppressions",
            "1794229200004_contact_basis_events",
          ],
          pending: [],
        });
      });

      await suite.test("Недостапната база е грешка, а не отсуство на ограничување", async () => {
        const organizationId = await createOrganization();
        await importPhones(organizationId, ["+12025550185"]);
        const { id: contactId } = await contact(organizationId, "+12025550185");
        const unavailable = createAuth(appUrl.href, settings).pool;
        await unavailable.end();
        await assert.rejects(readContactSuppression(organizationId, contactId, unavailable), { code: "DATABASE_ERROR" });
        await assert.rejects(recordContactSuppression(input(organizationId, contactId), unavailable), { code: "DATABASE_ERROR" });
      });
    } finally {
      await pool.end();
    }
  });
});
