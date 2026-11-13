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
import { contactImportLibraryVersion, savePreparedContactImport } from "../src/server/contact-imports.ts";
import type { PreparedContactImport } from "../src/server/contact-imports.ts";
import { createCredentialUser } from "../src/server/create-credential-user.ts";
import { bulkSyntheticPhones } from "./phone-fixtures.ts";

const firstPhone = "+12025550101";
const secondPhone = "+12025550102";
const thirdPhone = "+12025550103";
const sourceHash = createHash("sha256").update("synthetic contact import").digest("hex");
const organizationLock = "hashtextextended('aevyra.contact-import:' || $1::text, 0)";

async function waitForBlocked(admin: pg.Client, command: string | null = null) {
  const deadline = Date.now() + 3_500;
  do {
    const { rows: [blocked] } = await admin.query<{ pid: number }>(`
      SELECT pid FROM pg_stat_activity WHERE datname = current_database()
        AND pg_backend_pid() = ANY(pg_blocking_pids(pid)) AND ($1::text IS NULL OR query = $1)
    `, [command]);
    if (blocked) return blocked.pid;
    await delay(25);
  } while (Date.now() < deadline);
  assert.fail("Не е забележана очекуваната PostgreSQL брава.");
}

test("Трансакциско зачувување контакти преку ограничена LOGIN улога", { timeout: 90_000 }, async (suite) => {
  await withTestDatabase(verifyTestTarget(), async (admin, databaseUrl, database) => {
    assert.equal((await applyMigrations(databaseUrl)).length, 5);
    const adminUrl = new URL(databaseUrl);
    const appUrl = new URL(databaseUrl);
    appUrl.username = database;
    appUrl.password = randomBytes(32).toString("base64url");
    assert.equal(await provisionAppRole(adminUrl, appUrl), true);
    const settings = { baseURL: "http://127.0.0.1:3000", secureCookies: false, secret: randomBytes(32).toString("base64url") };
    const createOperator = (email: string) => createCredentialUser(databaseUrl, settings, {
      name: "Синтетички оператор", email, password: randomBytes(24).toString("base64url"),
    });
    const operatorId = await createOperator("contact-import@example.test");
    const otherOperator = await createOperator("contact-import-other@example.test");
    const { pool } = createAuth(appUrl.href, settings);
    const createOrganization = async (kind: OrganizationKind = "CLINIC") => (
      await pool.query<{ id: string }>("INSERT INTO aevyra.organizations (name, kind) VALUES ($1, $2) RETURNING id", ["Синтетичка организација", kind])
    ).rows[0].id;
    const readScope = async (organizationId: string) => (await admin.query(`
      SELECT (SELECT count(*)::int FROM aevyra.contacts WHERE organization_id = $1) AS contacts,
             (SELECT count(*)::int FROM aevyra.contact_imports WHERE organization_id = $1) AS imports,
             (SELECT count(*)::int FROM aevyra.contact_import_contacts WHERE organization_id = $1) AS links
    `, [organizationId])).rows[0];
    const scopeEmpty = { contacts: 0, imports: 0, links: 0 };
    const prepare = (organizationId: string, phones = [firstPhone, secondPhone]): PreparedContactImport => ({
      organizationId, operatorId, idempotencyKey: randomUUID(), sourceSha256: sourceHash,
      source: { format: "csv", delimiter: "comma", hasHeader: true, phoneColumn: 0 },
      policyVersion: "phone-normalization-v1", libraryVersion: contactImportLibraryVersion, totalRecords: phones.length,
      counts: { excludedEmptyRecords: 0, emptyPhone: 0, invalid: 0, review: 0, uniqueValid: phones.length, duplicateValid: 0 },
      candidates: phones.map((normalizedPhone, index) => ({ normalizedPhone, sourceRecordNumber: index + 2 })),
    });
    const save = (input: PreparedContactImport) => savePreparedContactImport(input, pool);
    const contacts = async (organizationId: string) => (
      await admin.query<{ id: string; created_at: Date }>("SELECT id, created_at FROM aevyra.contacts WHERE organization_id = $1 ORDER BY normalized_phone", [organizationId])
    ).rows;

    try {
      const { rows: [identity] } = await pool.query("SELECT current_user AS active, session_user AS login");
      assert.deepEqual(identity, { active: database, login: database });

      await suite.test("Првиот увоз ги зачувува операторот, поставките, бројачите и првите изворни редови", async () => {
        const organizationId = await createOrganization();
        const input: PreparedContactImport = {
          ...prepare(organizationId), totalRecords: 7,
          counts: { excludedEmptyRecords: 1, emptyPhone: 1, invalid: 1, review: 1, uniqueValid: 2, duplicateValid: 1 },
          candidates: [{ normalizedPhone: firstPhone, sourceRecordNumber: 2 }, { normalizedPhone: secondPhone, sourceRecordNumber: 6 }],
        };
        const result = await save(input);
        assert.equal(result.operatorId, operatorId);
        assert.equal(result.organizationId, organizationId);
        assert.equal(result.totalRecords, 7);
        assert.deepEqual(result.counts, input.counts);
        assert.deepEqual([result.newContacts, result.existingContacts], [2, 0]);
        assert.deepEqual(await readScope(organizationId), { contacts: 2, imports: 1, links: 2 });
        const { rows: [audit] } = await admin.query(`
          SELECT operator_id, idempotency_key, request_fingerprint, source_sha256, source_format, delimiter, sheet_index,
                 has_header, phone_column, policy_version, library_version, created_at
          FROM aevyra.contact_imports WHERE id = $1
        `, [result.importId]);
        assert.match(audit.request_fingerprint, /^[a-f0-9]{64}$/);
        const { request_fingerprint: fingerprint, ...metadata } = audit;
        assert.deepEqual(metadata, {
          operator_id: operatorId, idempotency_key: input.idempotencyKey, source_sha256: sourceHash,
          source_format: "csv", delimiter: "comma", sheet_index: null, has_header: true, phone_column: 0,
          policy_version: input.policyVersion, library_version: input.libraryVersion, created_at: new Date(result.createdAt),
        });
        const canonicalJson = JSON.stringify({
          version: 1, organizationId, operatorId, sourceSha256: sourceHash,
          source: { format: "csv", hasHeader: true, phoneColumn: 0, delimiter: "comma" },
          policyVersion: "phone-normalization-v1", libraryVersion: contactImportLibraryVersion, totalRecords: 7,
          counts: { excludedEmptyRecords: 1, emptyPhone: 1, invalid: 1, review: 1, uniqueValid: 2, duplicateValid: 1 },
          candidates: [{ normalizedPhone: firstPhone, sourceRecordNumber: 2 }, { normalizedPhone: secondPhone, sourceRecordNumber: 6 }],
        });
        assert.equal(fingerprint, createHash("sha256").update(canonicalJson).digest("hex"));
        const linked = await admin.query(`
          SELECT l.source_record_number, c.normalized_phone FROM aevyra.contact_import_contacts l
          JOIN aevyra.contacts c ON c.organization_id = l.organization_id AND c.id = l.contact_id
          WHERE l.import_id = $1 ORDER BY l.source_record_number
        `, [result.importId]);
        assert.deepEqual(linked.rows, [
          { source_record_number: 2, normalized_phone: firstPhone },
          { source_record_number: 6, normalized_phone: secondPhone },
        ]);
        const replay = await save({
          ...input, organizationId: organizationId.toUpperCase(), idempotencyKey: input.idempotencyKey.toUpperCase(),
          sourceSha256: sourceHash.toUpperCase(), candidates: [...input.candidates].reverse(),
        });
        assert.deepEqual(replay, result);
        assert.deepEqual(await readScope(organizationId), { contacts: 2, imports: 1, links: 2 });
      });

      await suite.test("Две клиники и маркетинг база создаваат независни контакти и опсег на истиот клуч", async () => {
        const orgs = [await createOrganization(), await createOrganization(), await createOrganization("MARKETING")];
        const idempotencyKey = randomUUID();
        const results = await Promise.all(orgs.map((organizationId) => save({ ...prepare(organizationId, [firstPhone]), idempotencyKey })));
        assert.equal(new Set(results.map(({ importId }) => importId)).size, 3);
        const ids: string[] = [];
        for (const [index, organizationId] of orgs.entries()) {
          assert.deepEqual(await readScope(organizationId), { contacts: 1, imports: 1, links: 1 });
          assert.equal(results[index].newContacts, 1);
          ids.push((await contacts(organizationId))[0].id);
        }
        assert.equal(new Set(ids).size, 3);
        const insertLink = (organizationId: string, importId: string, contactId: string) => pool.query(
          "INSERT INTO aevyra.contact_import_contacts (organization_id, import_id, contact_id, source_record_number) VALUES ($1, $2, $3, 3)",
          [organizationId, importId, contactId],
        );
        await assert.rejects(insertLink(orgs[0], results[0].importId, ids[1]), { code: "23503", constraint: "contact_import_contacts_contact_fk" });
        await assert.rejects(insertLink(orgs[0], results[1].importId, ids[0]), { code: "23503", constraint: "contact_import_contacts_import_fk" });
        assert.deepEqual(await readScope(orgs[0]), { contacts: 1, imports: 1, links: 1 });
      });

      await suite.test("Друг клуч повторно користи контакт и ги зачувува UUID и created_at", async () => {
        const organizationId = await createOrganization();
        const first = prepare(organizationId);
        const saved = await save(first);
        const before = await contacts(organizationId);
        const next = await save({ ...first, idempotencyKey: randomUUID(), source: { format: "xlsx", sheetIndex: 1, hasHeader: true, phoneColumn: 2 } });
        assert.notEqual(next.importId, saved.importId);
        assert.deepEqual([next.newContacts, next.existingContacts], [0, 2]);
        const { rows: [source] } = await admin.query("SELECT source_format, delimiter, sheet_index, phone_column FROM aevyra.contact_imports WHERE id = $1", [next.importId]);
        assert.deepEqual(source, { source_format: "xlsx", delimiter: null, sheet_index: 1, phone_column: 2 });
        assert.deepEqual(await contacts(organizationId), before);
        assert.deepEqual(await save(first), saved);
        assert.deepEqual(await readScope(organizationId), { contacts: 2, imports: 2, links: 4 });
      });

      await suite.test("Истиот клуч одбива изменета содржина без промени", async () => {
        const organizationId = await createOrganization();
        const input = { ...prepare(organizationId), totalRecords: 3 };
        input.counts.invalid = 1;
        await save(input);
        for (const changes of [
          { operatorId: otherOperator },
          { sourceSha256: "f".repeat(64) },
          { source: { ...input.source, phoneColumn: 1 } },
          { counts: { ...input.counts, invalid: 0, review: 1 } },
          { candidates: [{ normalizedPhone: thirdPhone, sourceRecordNumber: 2 }, input.candidates[1]] },
          { candidates: [input.candidates[0], { ...input.candidates[1], sourceRecordNumber: 4 }] },
        ]) {
          await assert.rejects(save({ ...input, ...changes }), { code: "IDEMPOTENCY_CONFLICT" });
        }
        assert.deepEqual(await readScope(organizationId), { contacts: 2, imports: 1, links: 2 });
      });

      await suite.test("Четири истовремени повици со ист клуч враќаат една евиденција", async () => {
        const organizationId = await createOrganization();
        const input = prepare(organizationId);
        const results = await Promise.all(Array.from({ length: 4 }, () => save(input)));
        for (const result of results) assert.deepEqual(result, results[0]);
        assert.deepEqual([results[0].newContacts, results[0].existingContacts], [2, 0]);
        assert.deepEqual(await readScope(organizationId), { contacts: 2, imports: 1, links: 2 });
      });

      await suite.test("Два конкурентни увози со преклопен број имаат точни нови и постојни контакти", async () => {
        const organizationId = await createOrganization();
        const results = await Promise.all([save(prepare(organizationId)), save(prepare(organizationId, [secondPhone, thirdPhone]))]);
        assert.deepEqual(results.map(({ newContacts }) => newContacts).sort(), [1, 2]);
        assert.deepEqual(results.map(({ existingContacts }) => existingContacts).sort(), [0, 1]);
        assert.deepEqual(await readScope(organizationId), { contacts: 3, imports: 2, links: 4 });
        const { rows: [shared] } = await admin.query(`SELECT count(*)::int AS links, count(DISTINCT l.contact_id)::int AS contacts
          FROM aevyra.contact_import_contacts l JOIN aevyra.contacts c ON c.id = l.contact_id
          WHERE l.organization_id = $1 AND c.normalized_phone = $2`, [organizationId, secondPhone]);
        assert.deepEqual(shared, { links: 2, contacts: 1 });
      });

      await suite.test("Брава за една организација не блокира увоз во друга", async () => {
        const blocked = await createOrganization();
        const independent = await createOrganization("MARKETING");
        await admin.query(`SELECT pg_advisory_lock(${organizationLock})`, [blocked]);
        const waiting = save(prepare(blocked));
        void waiting.catch(() => {});
        try {
          await waitForBlocked(admin);
          assert.equal((await save(prepare(independent))).newContacts, 2);
          assert.deepEqual(await readScope(independent), { contacts: 2, imports: 1, links: 2 });
          assert.deepEqual(await readScope(blocked), scopeEmpty);
        } finally {
          await admin.query(`SELECT pg_advisory_unlock(${organizationLock})`, [blocked]);
          await waiting;
        }
        assert.deepEqual(await readScope(blocked), { contacts: 2, imports: 1, links: 2 });
      });

      await suite.test("Грешка при последниот SQL внес ги враќа контактите, увозот и врските", async () => {
        const organizationId = await createOrganization();
        const input = prepare(organizationId);
        await admin.query(`ALTER TABLE aevyra.contact_import_contacts ADD CONSTRAINT test_link_failure
          CHECK (source_record_number <> 3) NOT VALID`);
        try {
          await assert.rejects(save(input), { code: "DATABASE_ERROR" });
          assert.deepEqual(await readScope(organizationId), scopeEmpty);
        } finally {
          await admin.query("ALTER TABLE aevyra.contact_import_contacts DROP CONSTRAINT test_link_failure");
        }
        assert.equal((await save(input)).newContacts, 2);
        assert.deepEqual(await readScope(organizationId), { contacts: 2, imports: 1, links: 2 });
      });

      await suite.test("Прекин во COMMIT дава непознат исход и истиот клуч безбедно се повторува", async () => {
        const organizationId = await createOrganization();
        const input = prepare(organizationId);
        await admin.query(`
          CREATE FUNCTION aevyra.test_import_commit() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN PERFORM pg_advisory_xact_lock(2141030001, 17); RETURN NEW; END; $$;
          CREATE CONSTRAINT TRIGGER test_import_commit AFTER INSERT ON aevyra.contact_imports
            DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION aevyra.test_import_commit()
        `);
        await admin.query("SELECT pg_advisory_lock(2141030001, 17)");
        const pending = save(input);
        void pending.catch(() => {});
        try {
          const pid = await waitForBlocked(admin, "COMMIT");
          assert.deepEqual(await readScope(organizationId), scopeEmpty);
          const { rows: [terminated] } = await admin.query("SELECT pg_terminate_backend($1, 1000) AS stopped", [pid]);
          assert.equal(terminated.stopped, true);
          await assert.rejects(pending, { code: "OUTCOME_UNKNOWN" });
        } finally {
          await admin.query("SELECT pg_advisory_unlock(2141030001, 17)");
          await pending.catch(() => {});
          await admin.query("DROP TRIGGER test_import_commit ON aevyra.contact_imports; DROP FUNCTION aevyra.test_import_commit()");
        }
        assert.deepEqual(await readScope(organizationId), scopeEmpty);
        assert.equal((await save(input)).newContacts, 2);
        assert.deepEqual(await readScope(organizationId), { contacts: 2, imports: 1, links: 2 });
      });

      await suite.test("Игнориран успешен одговор се разрешува од нова конекција со оригиналните бројачи", async () => {
        const organizationId = await createOrganization();
        const input = prepare(organizationId);
        const first = createAuth(appUrl.href, settings).pool;
        const next = createAuth(appUrl.href, settings).pool;
        try {
          const pid = (await first.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
          await savePreparedContactImport(input, first);
          await first.end();
          assert.notEqual((await next.query("SELECT pg_backend_pid() AS pid")).rows[0].pid, pid);
          const { rows: [original] } = await admin.query("SELECT id, new_contacts, existing_contacts FROM aevyra.contact_imports WHERE organization_id = $1", [organizationId]);
          const replay = await savePreparedContactImport(input, next);
          assert.equal(replay.importId, original.id);
          assert.deepEqual([replay.newContacts, replay.existingContacts], [2, 0]);
          assert.deepEqual([replay.newContacts, replay.existingContacts], [original.new_contacts, original.existing_contacts]);
          assert.deepEqual(await readScope(organizationId), { contacts: 2, imports: 1, links: 2 });
        } finally {
          if (!first.ended) await first.end();
          await next.end();
        }
      });

      await suite.test("Невалидни кандидати, бројачи, верзии и идентификатори се одбиваат пред запис", async () => {
        const organizationId = await createOrganization();
        const input = prepare(organizationId);
        const invalid = [
          { ...input, organizationId: "невалиден" },
          { ...input, operatorId: "невалиден оператор" },
          { ...input, idempotencyKey: "невалиден" },
          { ...input, sourceSha256: "xyz" },
          { ...input, requestFingerprint: sourceHash },
          { ...input, source: { ...input.source, sheetIndex: 0 } },
          { ...input, source: { format: "xlsx", sheetIndex: 10, hasHeader: true, phoneColumn: 0 } },
          { ...input, source: { ...input.source, phoneColumn: 50 } },
          { ...input, policyVersion: "phone-normalization-v0" },
          { ...input, libraryVersion: "0.0.0" },
          { ...input, totalRecords: 20_001 },
          { ...input, counts: { ...input.counts, invalid: 1 } },
          { ...input, counts: { ...input.counts, emptyPhone: -1 } },
          { ...input, counts: { ...input.counts, uniqueValid: 0, invalid: 2 }, candidates: [] },
          { ...input, candidates: input.candidates.slice(1) },
          { ...input, candidates: [input.candidates[0], { ...input.candidates[1], normalizedPhone: "+99912345678" }] },
          { ...input, candidates: [input.candidates[0], { ...input.candidates[1], normalizedPhone: "+389070123456" }] },
          { ...input, candidates: [input.candidates[0], { ...input.candidates[1], normalizedPhone: firstPhone }] },
          { ...input, candidates: [input.candidates[0], { ...input.candidates[1], sourceRecordNumber: 2 }] },
          { ...input, candidates: [input.candidates[0], { ...input.candidates[1], sourceRecordNumber: 4 }] },
          { ...input, candidates: [input.candidates[0], { ...input.candidates[1], status: "REVIEW" }] },
        ];
        for (const bad of invalid) await assert.rejects(save(bad as PreparedContactImport), { code: "INVALID_INPUT" });
        await assert.rejects(save({ ...input, organizationId: randomUUID() }), { code: "ORGANIZATION_NOT_FOUND" });
        await assert.rejects(save({ ...input, operatorId: randomUUID() }), { code: "OPERATOR_NOT_FOUND" });
        await assert.rejects(pool.query("INSERT INTO aevyra.contacts (organization_id, normalized_phone) VALUES ($1, '070123456')", [organizationId]),
          { code: "23514", constraint: "contacts_phone_e164_check" });
        assert.deepEqual(await readScope(organizationId), scopeEmpty);
      });

      await suite.test("Повторната миграција и подготовка го зачувуваат увозот и контактите", async () => {
        const organizationId = await createOrganization();
        const input = prepare(organizationId);
        const result = await save(input);
        const before = await contacts(organizationId);
        const links = async () => (await admin.query(`
          SELECT import_id, contact_id, source_record_number FROM aevyra.contact_import_contacts
          WHERE organization_id = $1 ORDER BY source_record_number
        `, [organizationId])).rows;
        const linksBefore = await links();
        assert.equal((await applyMigrations(databaseUrl)).length, 0);
        assert.equal(await provisionAppRole(adminUrl, appUrl), false);
        assert.deepEqual(await readMigrationStatus(databaseUrl), {
          hasHistory: true, applied: [
            "1794229200000_organizations", "1794229200001_auth", "1794229200002_contact_imports",
            "1794229200003_contact_suppressions",
            "1794229200004_contact_basis_events",
          ], pending: [],
        });
        assert.deepEqual(await save(input), result);
        assert.deepEqual(await contacts(organizationId), before);
        assert.deepEqual(await links(), linksBefore);
        assert.deepEqual(await readScope(organizationId), { contacts: 2, imports: 1, links: 2 });
      });

      await suite.test("Се зачувуваат 20.000 единствени валидни синтетички контакти", async (proof) => {
        const organizationId = await createOrganization("MARKETING");
        const input = prepare(organizationId, []);
        const candidates = bulkSyntheticPhones().map((normalizedPhone, index) => ({ normalizedPhone, sourceRecordNumber: index + 1 }));
        const start = performance.now();
        const result = await save({
          ...input, source: { format: "csv", delimiter: "comma", hasHeader: false, phoneColumn: 0 },
          totalRecords: 20_000, counts: { ...input.counts, uniqueValid: 20_000 }, candidates,
        });
        const elapsed = Math.round(performance.now() - start);
        assert.deepEqual([result.totalRecords, result.newContacts, result.existingContacts], [20_000, 20_000, 0]);
        assert.deepEqual(await readScope(organizationId), { contacts: 20_000, imports: 1, links: 20_000 });
        const { rows: [positions] } = await admin.query(`SELECT count(DISTINCT source_record_number)::int AS positions,
          min(source_record_number) AS first, max(source_record_number) AS last
          FROM aevyra.contact_import_contacts WHERE import_id = $1`, [result.importId]);
        assert.deepEqual(positions, { positions: 20_000, first: 1, last: 20_000 });
        proof.diagnostic(`20.000 контакти, 20.000 врски и 1 увоз за ${elapsed} ms (валидација и трансакција).`);
      });
    } finally {
      await pool.end();
    }
  });
});
