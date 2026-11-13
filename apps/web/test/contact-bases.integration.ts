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
  readContactBasisState,
  recordContactBasis,
  withdrawContactBasis,
} from "../src/server/contact-bases.ts";
import type {
  ContactBasisChannel,
  ContactBasisPurpose,
  PreparedContactBasisRecord,
  PreparedContactBasisWithdrawal,
} from "../src/server/contact-bases.ts";
import {
  contactImportLibraryVersion,
  savePreparedContactImport,
} from "../src/server/contact-imports.ts";
import type { PreparedContactImport } from "../src/server/contact-imports.ts";
import { recordContactSuppression } from "../src/server/contact-suppressions.ts";
import { createCredentialUser } from "../src/server/create-credential-user.ts";

const sourceHash = createHash("sha256").update("synthetic contact basis import").digest("hex");

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

test("Серверска евиденција на основата за контакт и нејзино повлекување", { timeout: 150_000 }, async (suite) => {
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
    const operatorId = await createCredentialUser(databaseUrl, settings, {
      name: "Синтетички оператор",
      email: "contact-basis@example.test",
      password: randomBytes(24).toString("base64url"),
    });
    const otherOperatorId = await createCredentialUser(databaseUrl, settings, {
      name: "Друг синтетички оператор",
      email: "contact-basis-other@example.test",
      password: randomBytes(24).toString("base64url"),
    });
    const { pool } = createAuth(appUrl.href, settings);

    const createOrganization = async (kind: OrganizationKind = "CLINIC") => (
      await pool.query<{ id: string }>(
        "INSERT INTO aevyra.organizations (name, kind) VALUES ($1, $2) RETURNING id",
        [`Синтетичка ${kind}`, kind],
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
    const findContact = async (organizationId: string, phone: string) => (
      await admin.query<{ id: string }>(`
        SELECT id FROM aevyra.contacts WHERE organization_id = $1 AND normalized_phone = $2
      `, [organizationId, phone])
    ).rows[0].id;
    const recordInput = (
      organizationId: string,
      contactId: string,
      overrides: Partial<PreparedContactBasisRecord> = {},
    ): PreparedContactBasisRecord => ({
      organizationId,
      contactId,
      operatorId,
      purpose: "PATIENT_INFORMATION",
      channel: "SMS",
      expectedRevision: 0,
      idempotencyKey: randomUUID(),
      basisType: "CONSENT",
      reference: "CASE-001",
      ...overrides,
    });
    const withdrawalInput = (
      source: PreparedContactBasisRecord,
      overrides: Partial<PreparedContactBasisWithdrawal> = {},
    ): PreparedContactBasisWithdrawal => ({
      organizationId: source.organizationId,
      contactId: source.contactId,
      operatorId,
      purpose: source.purpose,
      channel: source.channel,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
      reference: "WITHDRAW-001",
      ...overrides,
    });
    const read = (
      organizationId: string,
      contactId: string,
      purpose: ContactBasisPurpose = "PATIENT_INFORMATION",
      channel: ContactBasisChannel = "SMS",
      targetPool = pool,
    ) => readContactBasisState(organizationId, contactId, purpose, channel, targetPool);

    try {
      await suite.test("Прв RECORD и тековната состојба се база-генерирани и одделни од ограничувањето", async () => {
        const organizationId = await createOrganization();
        await importPhones(organizationId, ["+12025550201"]);
        const contactId = await findContact(organizationId, "+12025550201");
        const missing = await read(organizationId, contactId);
        assert.deepEqual({ status: missing.status, revision: missing.revision, latestEvent: missing.latestEvent, suppression: missing.suppression }, {
          status: "MISSING", revision: 0, latestEvent: null, suppression: null,
        });

        const result = await recordContactBasis(recordInput(organizationId, contactId), pool);
        assert.equal(result.outcome, "APPENDED");
        assert.match(result.event.id, /^[a-f0-9-]{36}$/);
        assert.equal(result.event.revision, 1);
        assert.equal(result.event.eventType, "RECORD");
        assert.equal(result.event.basisType, "CONSENT");
        assert.ok(Number.isFinite(Date.parse(result.event.recordedAt)));
        assert.deepEqual(result.current, await read(organizationId, contactId));
        assert.equal(result.current.status, "RECORDED");
        assert.equal(result.current.suppression, null);
      });

      await suite.test("WITHDRAW може да биде прв настан и никогаш не создава позитивна основа", async () => {
        const organizationId = await createOrganization();
        await importPhones(organizationId, ["+12025550202"]);
        const contactId = await findContact(organizationId, "+12025550202");
        const result = await withdrawContactBasis({
          organizationId, contactId, operatorId, purpose: "PATIENT_INFORMATION", channel: "VIBER",
          expectedRevision: 0, idempotencyKey: randomUUID(), reference: "Барање од контактот",
        }, pool);
        assert.equal(result.event.revision, 1);
        assert.equal(result.event.eventType, "WITHDRAW");
        assert.equal(result.event.basisType, null);
        assert.equal(result.event.expiresAt, null);
        assert.equal(result.current.status, "WITHDRAWN");
      });

      await suite.test("Истечен последен RECORD не се враќа на постара важечка основа", async () => {
        const organizationId = await createOrganization();
        await importPhones(organizationId, ["+12025550203"]);
        const contactId = await findContact(organizationId, "+12025550203");
        await recordContactBasis(recordInput(organizationId, contactId, { reference: "OLDER" }), pool);
        const expiresAt = new Date(Date.now() + 1_500).toISOString();
        await recordContactBasis(recordInput(organizationId, contactId, {
          expectedRevision: 1,
          reference: "LATEST",
          expiresAt,
        }), pool);
        await delay(1_700);
        const state = await read(organizationId, contactId);
        assert.equal(state.status, "EXPIRED");
        assert.equal(state.revision, 2);
        assert.equal(state.latestEvent?.reference, "LATEST");
      });

      await suite.test("Организацијата, намената и каналот се строго раздвоени", async () => {
        const clinic = await createOrganization("CLINIC");
        const marketing = await createOrganization("MARKETING");
        const phone = "+12025550204";
        await importPhones(clinic, [phone]);
        await importPhones(marketing, [phone]);
        const clinicContact = await findContact(clinic, phone);
        const marketingContact = await findContact(marketing, phone);
        await recordContactBasis(recordInput(clinic, clinicContact), pool);
        await recordContactBasis(recordInput(marketing, marketingContact, {
          purpose: "AEVYRA_MARKETING", channel: "VIBER", reference: "MKT-001",
        }), pool);
        assert.equal((await read(clinic, clinicContact, "PATIENT_INFORMATION", "SMS")).status, "RECORDED");
        assert.equal((await read(clinic, clinicContact, "PATIENT_INFORMATION", "VIBER")).status, "MISSING");
        assert.equal((await read(marketing, marketingContact, "AEVYRA_MARKETING", "VIBER")).status, "RECORDED");
        await assert.rejects(read(clinic, clinicContact, "AEVYRA_MARKETING", "SMS"), { code: "PURPOSE_NOT_ALLOWED" });
        await assert.rejects(read(marketing, marketingContact, "PATIENT_INFORMATION", "SMS"), { code: "PURPOSE_NOT_ALLOWED" });
      });

      await suite.test("Невалидна намена, полиња, идентитети и вкрстена контактна врска се одбиваат", async () => {
        const clinic = await createOrganization("CLINIC");
        const other = await createOrganization("CLINIC");
        await importPhones(clinic, ["+12025550205"]);
        const contactId = await findContact(clinic, "+12025550205");
        await assert.rejects(recordContactBasis(recordInput(clinic, contactId, { purpose: "AEVYRA_MARKETING" }), pool), { code: "PURPOSE_NOT_ALLOWED" });
        await assert.rejects(recordContactBasis(recordInput(other, contactId), pool), { code: "CONTACT_NOT_FOUND" });
        await assert.rejects(recordContactBasis(recordInput(clinic, contactId, { operatorId: "missing_operator" }), pool), { code: "OPERATOR_NOT_FOUND" });
        await assert.rejects(recordContactBasis({ ...recordInput(clinic, contactId), reference: " " }, pool), { code: "INVALID_INPUT" });
        await assert.rejects(recordContactBasis({ ...recordInput(clinic, contactId), reference: "а".repeat(251) }, pool), { code: "INVALID_INPUT" });
        await assert.rejects(recordContactBasis({ ...recordInput(clinic, contactId), expiresAt: new Date(Date.now() - 1_000).toISOString() }, pool), { code: "INVALID_INPUT" });
        await assert.rejects(recordContactBasis({ ...recordInput(clinic, contactId), extra: true } as never, pool), { code: "INVALID_INPUT" });
        await assert.rejects(admin.query(`
          INSERT INTO aevyra.contact_basis_events (
            organization_id, contact_id, purpose, channel, event_type, operator_id, revision,
            idempotency_key, request_fingerprint, basis_type, reference
          ) VALUES ($1, $2, 'PATIENT_INFORMATION', 'SMS', 'RECORD', $3, 1, $4, $5, 'CONSENT', 'CROSS')
        `, [other, contactId, operatorId, randomUUID(), "0".repeat(64)]), {
          code: "23503", constraint: "contact_basis_events_contact_fk",
        });
      });

      await suite.test("SQL ограничувањето бара дозволен и ненулти вид на основа за RECORD", async () => {
        const organizationId = await createOrganization();
        await importPhones(organizationId, ["+12025550212"]);
        const contactId = await findContact(organizationId, "+12025550212");
        const insertWithBasis = (
          eventType: "RECORD" | "WITHDRAW",
          basisType: string | null,
          revision: number,
          reference: string | null,
        ) => pool.query(`
          INSERT INTO aevyra.contact_basis_events (
            organization_id, contact_id, purpose, channel, event_type, operator_id, revision,
            idempotency_key, request_fingerprint, basis_type, reference, expires_at
          ) VALUES ($1, $2, 'PATIENT_INFORMATION', 'VIBER', $3, $4, $5, $6, $7, $8, $9, NULL)
        `, [
          organizationId, contactId, eventType, operatorId, revision, randomUUID(),
          "1".repeat(64), basisType, reference,
        ]);
        const insertWithoutBasis = () => pool.query(`
          INSERT INTO aevyra.contact_basis_events (
            organization_id, contact_id, purpose, channel, event_type, operator_id, revision,
            idempotency_key, request_fingerprint, reference, expires_at
          ) VALUES ($1, $2, 'PATIENT_INFORMATION', 'VIBER', 'RECORD', $3, 1, $4, $5, 'OMITTED', NULL)
        `, [organizationId, contactId, operatorId, randomUUID(), "2".repeat(64)]);
        const payloadViolation = { code: "23514", constraint: "contact_basis_events_payload_check" };

        await assert.rejects(insertWithBasis("RECORD", null, 1, "EXPLICIT-NULL"), payloadViolation);
        await assert.rejects(insertWithoutBasis(), payloadViolation);
        await assert.rejects(insertWithBasis("RECORD", "OTHER", 1, "INVALID"), payloadViolation);
        assert.equal((await pool.query(`
          SELECT FROM aevyra.contact_basis_events
          WHERE organization_id = $1 AND contact_id = $2 AND channel = 'VIBER'
        `, [organizationId, contactId])).rowCount, 0);

        await insertWithBasis("RECORD", "CONSENT", 1, "CONSENT-OK");
        await insertWithBasis("RECORD", "DOCUMENTED_BASIS", 2, "DOCUMENTED-OK");
        await insertWithBasis("WITHDRAW", null, 3, null);
        const { rows } = await pool.query(`
          SELECT revision, event_type, basis_type, reference, expires_at
          FROM aevyra.contact_basis_events
          WHERE organization_id = $1 AND contact_id = $2 AND channel = 'VIBER'
          ORDER BY revision
        `, [organizationId, contactId]);
        assert.deepEqual(rows, [
          { revision: 1, event_type: "RECORD", basis_type: "CONSENT", reference: "CONSENT-OK", expires_at: null },
          { revision: 2, event_type: "RECORD", basis_type: "DOCUMENTED_BASIS", reference: "DOCUMENTED-OK", expires_at: null },
          { revision: 3, event_type: "WITHDRAW", basis_type: null, reference: null, expires_at: null },
        ]);
      });

      await suite.test("рокот строго ги проверува календарот, времето и offset-от пред UTC канонизација", async () => {
        const organizationId = await createOrganization();
        await importPhones(organizationId, ["+12025550213"]);
        const contactId = await findContact(organizationId, "+12025550213");
        const invalidExpiries = [
          "2030-02-30T12:00:00Z",
          "2031-02-29T12:00:00Z",
          "2030-04-31T12:00:00Z",
          "2030-01-01T24:00:00Z",
          "2030-01-01T12:60:00Z",
          "2030-01-01T12:00:60Z",
          "2030-01-01T12:00:00+24:00",
          "2030-01-01T12:00:00+01:60",
        ];
        for (const expiresAt of invalidExpiries) {
          await assert.rejects(recordContactBasis(recordInput(organizationId, contactId, {
            idempotencyKey: randomUUID(), expiresAt,
          }), pool), { code: "INVALID_INPUT" });
        }
        assert.equal((await pool.query(`
          SELECT FROM aevyra.contact_basis_events WHERE organization_id = $1 AND contact_id = $2
        `, [organizationId, contactId])).rowCount, 0);

        const idempotencyKey = randomUUID();
        const original = await recordContactBasis(recordInput(organizationId, contactId, {
          idempotencyKey,
          expiresAt: "2032-02-29T12:00:00+02:00",
        }), pool);
        assert.equal(original.event.expiresAt, "2032-02-29T10:00:00.000Z");
        const replayed = await recordContactBasis(recordInput(organizationId, contactId, {
          idempotencyKey,
          expiresAt: "2032-02-29T10:00:00Z",
        }), pool);
        assert.equal(replayed.outcome, "REPLAYED");
        assert.equal(replayed.event.id, original.event.id);
        assert.equal(replayed.current.revision, 1);
      });

      await suite.test("Идентично повторување го враќа оригиналот, а различно барање со истиот клуч е конфликт", async () => {
        const organizationId = await createOrganization();
        await importPhones(organizationId, ["+12025550206"]);
        const contactId = await findContact(organizationId, "+12025550206");
        const prepared = recordInput(organizationId, contactId);
        const original = await recordContactBasis(prepared, pool);
        const repeated = await recordContactBasis(prepared, pool);
        assert.equal(repeated.outcome, "REPLAYED");
        assert.deepEqual(repeated.event, original.event);
        await assert.rejects(recordContactBasis({ ...prepared, reference: "DIFFERENT" }, pool), { code: "IDEMPOTENCY_CONFLICT" });
        assert.equal((await read(organizationId, contactId)).revision, 1);
      });

      await suite.test("Конкурентни барања со иста expectedRevision создаваат само една следна revision", async () => {
        const organizationId = await createOrganization();
        await importPhones(organizationId, ["+12025550207"]);
        const contactId = await findContact(organizationId, "+12025550207");
        const settled = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => recordContactBasis(
          recordInput(organizationId, contactId, { reference: `PARALLEL-${index}` }), pool,
        )));
        assert.equal(settled.filter(({ status }) => status === "fulfilled").length, 1);
        for (const result of settled.filter((item) => item.status === "rejected")) {
          assert.equal((result as PromiseRejectedResult).reason.code, "REVISION_CONFLICT");
        }
        assert.equal((await read(organizationId, contactId)).revision, 1);
      });

      await suite.test("Стар RECORD повторен по WITHDRAW го враќа оригиналниот настан без реактивација", async () => {
        const organizationId = await createOrganization();
        await importPhones(organizationId, ["+12025550208"]);
        const contactId = await findContact(organizationId, "+12025550208");
        const prepared = recordInput(organizationId, contactId, { reference: "OLD-RECORD" });
        const original = await recordContactBasis(prepared, pool);
        const withdrawn = await withdrawContactBasis(withdrawalInput(prepared), pool);
        assert.equal(withdrawn.current.status, "WITHDRAWN");
        const replayed = await recordContactBasis(prepared, pool);
        assert.equal(replayed.outcome, "REPLAYED");
        assert.equal(replayed.event.id, original.event.id);
        assert.equal(replayed.event.revision, 1);
        assert.equal(replayed.event.eventType, "RECORD");
        assert.equal(replayed.current.status, "WITHDRAWN");
        assert.equal(replayed.current.revision, 2);
        assert.equal(replayed.current.latestEvent?.eventType, "WITHDRAW");
      });

      await suite.test("Неизвесен COMMIT и изгубен успешен одговор се разрешуваат со истиот клуч", async () => {
        const organizationId = await createOrganization();
        await importPhones(organizationId, ["+12025550209"]);
        const contactId = await findContact(organizationId, "+12025550209");
        const prepared = recordInput(organizationId, contactId, { reference: "UNKNOWN" });
        await admin.query(`
          CREATE FUNCTION aevyra.test_basis_commit() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN PERFORM pg_advisory_xact_lock(2141030004, 18); RETURN NEW; END; $$;
          CREATE CONSTRAINT TRIGGER test_basis_commit AFTER INSERT ON aevyra.contact_basis_events
            DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION aevyra.test_basis_commit()
        `);
        await admin.query("SELECT pg_advisory_lock(2141030004, 18)");
        const pending = recordContactBasis(prepared, pool);
        void pending.catch(() => {});
        try {
          const pid = await waitForBlocked(admin, "COMMIT");
          assert.equal((await admin.query("SELECT pg_terminate_backend($1, 1000) AS stopped", [pid])).rows[0].stopped, true);
          await assert.rejects(pending, { code: "OUTCOME_UNKNOWN" });
        } finally {
          await admin.query("SELECT pg_advisory_unlock(2141030004, 18)");
          await pending.catch(() => {});
          await admin.query(`
            DROP TRIGGER test_basis_commit ON aevyra.contact_basis_events;
            DROP FUNCTION aevyra.test_basis_commit()
          `);
        }
        assert.equal((await read(organizationId, contactId)).status, "MISSING");
        const recovered = await recordContactBasis(prepared, pool);
        assert.equal(recovered.outcome, "APPENDED");
        const lostResponseReplay = await recordContactBasis(prepared, pool);
        assert.equal(lostResponseReplay.outcome, "REPLAYED");
        assert.equal(lostResponseReplay.event.id, recovered.event.id);
      });

      await suite.test("Нова основа не ја отстранува или заобиколува евиденцијата „Не контактирај“", async () => {
        const organizationId = await createOrganization();
        await importPhones(organizationId, ["+12025550210"]);
        const contactId = await findContact(organizationId, "+12025550210");
        const suppression = await recordContactSuppression({
          organizationId, contactId, operatorId, reason: "CONTACT_REQUEST", reference: "BLOCK-001",
        }, pool);
        const result = await recordContactBasis(recordInput(organizationId, contactId), pool);
        assert.equal(result.current.status, "RECORDED");
        assert.equal(result.current.suppression?.id, suppression.suppression.id);
        assert.equal((await read(organizationId, contactId)).suppression?.id, suppression.suppression.id);
        assert.equal((await admin.query(`
          SELECT count(*)::int AS count FROM aevyra.contact_suppressions
          WHERE organization_id = $1 AND contact_id = $2
        `, [organizationId, contactId])).rows[0].count, 1);
      });

      await suite.test("Повторен увоз не создава, менува или повлекува основа", async () => {
        const organizationId = await createOrganization();
        const phone = "+12025550211";
        await importPhones(organizationId, [phone]);
        const contactId = await findContact(organizationId, phone);
        await recordContactBasis(recordInput(organizationId, contactId), pool);
        const before = (await admin.query(`
          SELECT jsonb_agg(to_jsonb(event) ORDER BY revision)::text AS events
          FROM aevyra.contact_basis_events AS event WHERE organization_id = $1 AND contact_id = $2
        `, [organizationId, contactId])).rows[0].events;
        const importedAgain = await importPhones(organizationId, [phone]);
        assert.deepEqual([importedAgain.newContacts, importedAgain.existingContacts], [0, 1]);
        const after = (await admin.query(`
          SELECT jsonb_agg(to_jsonb(event) ORDER BY revision)::text AS events
          FROM aevyra.contact_basis_events AS event WHERE organization_id = $1 AND contact_id = $2
        `, [organizationId, contactId])).rows[0].events;
        assert.equal(after, before);
        assert.equal(await findContact(organizationId, phone), contactId);
      });

      await suite.test("Ограничената улога има SELECT и INSERT само на потребните колони", async () => {
        const { rows: [access] } = await pool.query(`
          SELECT has_table_privilege('aevyra.contact_basis_events', 'SELECT') AS readable,
            has_table_privilege('aevyra.contact_basis_events',
              'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN,SELECT WITH GRANT OPTION') AS extra_table,
            has_any_column_privilege('aevyra.contact_basis_events',
              'UPDATE,REFERENCES,SELECT WITH GRANT OPTION,INSERT WITH GRANT OPTION') AS extra_column,
            ARRAY(SELECT attname::text FROM pg_attribute
              WHERE attrelid = 'aevyra.contact_basis_events'::regclass AND attnum > 0
                AND has_column_privilege(attrelid, attnum, 'INSERT') ORDER BY attnum) AS insertable
        `);
        assert.deepEqual(access, {
          readable: true,
          extra_table: false,
          extra_column: false,
          insertable: [
            "organization_id", "contact_id", "purpose", "channel", "event_type", "operator_id", "revision",
            "idempotency_key", "request_fingerprint", "basis_type", "reference", "expires_at",
          ],
        });
        await expectDenied(pool, [
          "UPDATE aevyra.contact_basis_events SET reference = reference",
          "DELETE FROM aevyra.contact_basis_events",
          "TRUNCATE aevyra.contact_basis_events",
          "ALTER TABLE aevyra.contact_basis_events ADD COLUMN deny_probe int",
          "DROP TABLE aevyra.contact_basis_events",
          "INSERT INTO aevyra.contact_basis_events (id) VALUES (gen_random_uuid())",
          "INSERT INTO aevyra.contact_basis_events (recorded_at) VALUES (now())",
        ]);
      });

      await suite.test("Повторна миграција и provision ја зачувуваат целата историја", async () => {
        const before = (await admin.query(`
          SELECT jsonb_agg(to_jsonb(event) ORDER BY organization_id, contact_id, purpose, channel, revision)::text AS events
          FROM aevyra.contact_basis_events AS event
        `)).rows[0].events;
        assert.equal((await applyMigrations(databaseUrl)).length, 0);
        assert.equal(await provisionAppRole(adminUrl, appUrl), false);
        const after = (await admin.query(`
          SELECT jsonb_agg(to_jsonb(event) ORDER BY organization_id, contact_id, purpose, channel, revision)::text AS events
          FROM aevyra.contact_basis_events AS event
        `)).rows[0].events;
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

      await suite.test("Непостоечки контакт и недостапна база се типизирани грешки", async () => {
        const organizationId = await createOrganization();
        await assert.rejects(read(organizationId, randomUUID()), { code: "CONTACT_NOT_FOUND" });
        const unavailable = createAuth(appUrl.href, settings).pool;
        await unavailable.end();
        await assert.rejects(read(organizationId, randomUUID(), "PATIENT_INFORMATION", "SMS", unavailable), { code: "DATABASE_ERROR" });
        await assert.rejects(recordContactBasis(recordInput(organizationId, randomUUID()), unavailable), { code: "DATABASE_ERROR" });
      });

      assert.notEqual(operatorId, otherOperatorId);
    } finally {
      await pool.end();
    }
  });
});
