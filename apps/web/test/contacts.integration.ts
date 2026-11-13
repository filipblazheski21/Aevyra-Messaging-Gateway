import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { applyMigrations } from "../../../packages/db/src/migrations.ts";
import { provisionAppRole } from "../../../packages/db/src/provision.ts";
import { verifyTestTarget, withTestDatabase } from "../../../packages/db/test/test-database.ts";
import type { ContactListPage } from "../src/contacts.ts";
import type { Organization, OrganizationKind } from "../src/organizations.ts";
import { createCredentialUser } from "../src/server/create-credential-user.ts";
import { reserveWebPort, startTestWeb } from "./test-web.ts";

async function readJson<T>(response: Response, status: number): Promise<T> {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  return response.json();
}

async function expectError(response: Response, status: number, code: string) {
  const body = await readJson<{ code: string; message: string }>(response, status);
  assert.equal(body.code, code);
  assert.match(body.message, /\p{Script=Cyrillic}/u);
  assert.doesNotMatch(body.message, /SELECT|permission|password|PostgreSQL|aevyra\./i);
  return body;
}

test("Преглед, пребарување и cursor пагинација на контакти по организација", { timeout: 240_000 }, async (suite) => {
  await withTestDatabase(verifyTestTarget(), async (admin, databaseUrl, database) => {
    assert.equal((await applyMigrations(databaseUrl)).length, 5);
    const appUrl = new URL(databaseUrl);
    appUrl.username = database;
    appUrl.password = randomBytes(32).toString("base64url");
    await provisionAppRole(new URL(databaseUrl), appUrl);

    const port = await reserveWebPort();
    const baseURL = `http://127.0.0.1:${port}`;
    const settings = { baseURL, secureCookies: false, secret: randomBytes(32).toString("base64url") };
    const user = { name: "Синтетички оператор", email: "contacts@example.test", password: randomBytes(24).toString("base64url") };
    await createCredentialUser(databaseUrl, settings, user);
    const stop = await startTestWeb(port, {
      DATABASE_URL: appUrl.href,
      AUTH_BASE_URL: baseURL,
      AUTH_LOCAL_HTTP: "true",
      AUTH_SECRET: settings.secret,
      REAL_SENDING_ENABLED: "false",
    });

    const request = (path: string, cookie?: string) => fetch(`${baseURL}${path}`, {
      headers: cookie ? { Cookie: cookie } : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    const createOrganization = async (kind: OrganizationKind, name: string) => {
      const { rows: [row] } = await admin.query<Organization>(`
        INSERT INTO aevyra.organizations (kind, name) VALUES ($1, $2)
        RETURNING id, kind, name, created_at
      `, [kind, name]);
      return row;
    };
    const path = (organizationId: string, query = "") => `/api/organizations/${organizationId}/contacts${query ? `?${query}` : ""}`;
    const page = (organizationId: string, query = "") => request(path(organizationId, query), cookie);
    const insertPhones = (organizationId: string, phones: string[]) => admin.query(`
      INSERT INTO aevyra.contacts (organization_id, normalized_phone)
      SELECT $1, phone FROM unnest($2::text[]) AS value(phone)
    `, [organizationId, phones]);
    const snapshot = async () => (await admin.query(`
      SELECT
        (SELECT count(*)::int FROM aevyra.contacts) AS contacts,
        (SELECT md5(coalesce(string_agg(id::text || ':' || organization_id::text || ':' || normalized_phone || ':' || created_at::text,
          '|' ORDER BY organization_id, normalized_phone, id), '')) FROM aevyra.contacts) AS contacts_hash,
        (SELECT count(*)::int FROM aevyra.contact_imports) AS imports,
        (SELECT count(*)::int FROM aevyra.contact_import_contacts) AS links
    `)).rows[0];

    let cookie = "";
    let clinic: Organization;
    let otherClinic: Organization;
    let marketing: Organization;
    let empty: Organization;
    let bulk: Organization;
    let proof = { elapsedMs: 0, requests: 0 };

    try {
      const signIn = await fetch(`${baseURL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { Origin: baseURL, "Content-Type": "application/json" },
        body: JSON.stringify({ email: user.email, password: user.password }),
      });
      assert.equal(signIn.status, 200);
      const session = signIn.headers.getSetCookie().find((value) => value.startsWith("better-auth.session_token="));
      assert.ok(session, "Недостасува тест-сесија.");
      cookie = session.split(";")[0];

      clinic = await createOrganization("CLINIC", "Синтетичка клиника");
      otherClinic = await createOrganization("CLINIC", "Друга синтетичка клиника");
      marketing = await createOrganization("MARKETING", "Синтетичка маркетинг база");
      empty = await createOrganization("CLINIC", "Празна синтетичка клиника");
      bulk = await createOrganization("MARKETING", "Синтетички 20.000 контакти");
      const shared = "+12025550100";
      await insertPhones(clinic.id, [shared, "+38970111111", "+38970222222", "+38970333333", "+441234567890"]);
      await insertPhones(otherClinic.id, [shared, "+4915112345678"]);
      await insertPhones(marketing.id, [shared, "+33123456789"]);

      await suite.test("Сесија, организација и празна база", async () => {
        await expectError(await request(path(clinic.id)), 401, "AUTH_REQUIRED");
        await expectError(await page(randomUUID()), 404, "ORGANIZATION_NOT_FOUND");
        const result = await readJson<ContactListPage>(await page(empty.id), 200);
        assert.deepEqual(result, { items: [], totalContacts: 0, matchedContacts: 0, nextCursor: null });
      });

      await suite.test("Организациско раздвојување и точни бројачи", async () => {
        for (const [organization, expectedTotal] of [[clinic, 5], [otherClinic, 2], [marketing, 2]] as const) {
          const result = await readJson<ContactListPage>(await page(organization.id, "limit=100"), 200);
          assert.equal(result.totalContacts, expectedTotal);
          assert.equal(result.matchedContacts, expectedTotal);
          assert.equal(result.items.filter(({ normalizedPhone }) => normalizedPhone === shared).length, 1);
          assert.ok(result.items.every((item) => Object.keys(item).sort().join(",") === "createdAt,hasSuppression,id,normalizedPhone"));
          assert.ok(result.items.every((item) => item.hasSuppression === false));
        }
        const ids = (await admin.query<{ id: string }>(`
          SELECT id FROM aevyra.contacts WHERE normalized_phone = $1 ORDER BY organization_id
        `, [shared])).rows.map(({ id }) => id);
        assert.equal(ids.length, 3);
        assert.equal(new Set(ids).size, 3);
      });

      await suite.test("Пребарување со и без + и одбивање неподдржани параметри", async () => {
        const withPlus = await readJson<ContactListPage>(await page(clinic.id, "search=%2B38970"), 200);
        const withoutPlus = await readJson<ContactListPage>(await page(clinic.id, "search=38970"), 200);
        const withOuterSpaces = await readJson<ContactListPage>(await page(clinic.id, "search=%20%2B38970%20"), 200);
        const emptySearch = await readJson<ContactListPage>(await page(clinic.id, "search=&limit=100"), 200);
        assert.deepEqual(withoutPlus, withPlus);
        assert.deepEqual(withOuterSpaces, withPlus);
        assert.equal(emptySearch.items.length, 5);
        assert.equal(emptySearch.matchedContacts, 5);
        assert.equal(withPlus.totalContacts, 5);
        assert.equal(withPlus.matchedContacts, 3);
        assert.ok(withPlus.items.every(({ normalizedPhone }) => normalizedPhone.startsWith("+38970")));

        for (const query of [
          "search=38", "search=070", "search=389%2070", "search=%2538970", "search=_38970",
          "search=1234567890123456", "limit=0", "limit=101", "limit=1.5", "limit=2&limit=3",
          "search=389&search=3897", "cursor=a&cursor=b", "offset=0", "unknown=true",
        ]) await expectError(await page(clinic.id, query), 400, "INVALID_REQUEST");
      });

      await suite.test("Cursor е врзан за организацијата и активното пребарување", async () => {
        const first = await readJson<ContactListPage>(await page(clinic.id, "search=38970&limit=2"), 200);
        assert.equal(first.items.length, 2);
        assert.ok(first.nextCursor);
        const second = await readJson<ContactListPage>(await page(clinic.id, `search=38970&limit=2&cursor=${encodeURIComponent(first.nextCursor)}`), 200);
        assert.equal(second.items.length, 1);
        assert.equal(new Set([...first.items, ...second.items].map(({ id }) => id)).size, 3);
        await expectError(await page(otherClinic.id, `search=38970&limit=2&cursor=${encodeURIComponent(first.nextCursor)}`), 400, "INVALID_REQUEST");
        await expectError(await page(clinic.id, `search=389&limit=2&cursor=${encodeURIComponent(first.nextCursor)}`), 400, "INVALID_REQUEST");
        const changed = `${first.nextCursor.slice(0, -1)}${first.nextCursor.endsWith("A") ? "B" : "A"}`;
        await expectError(await page(clinic.id, `search=38970&limit=2&cursor=${encodeURIComponent(changed)}`), 400, "INVALID_REQUEST");
      });

      await suite.test("Страниците не се преклопуваат и не пропуштаат контакти", async () => {
        const expected = (await admin.query<{ id: string }>(`
          SELECT id FROM aevyra.contacts WHERE organization_id = $1 ORDER BY normalized_phone ASC, id ASC
        `, [clinic.id])).rows.map(({ id }) => id);
        const found: string[] = [];
        let cursor: string | null = null;
        do {
          const query = new URLSearchParams({ limit: "2" });
          if (cursor) query.set("cursor", cursor);
          const result = await readJson<ContactListPage>(await page(clinic.id, query.toString()), 200);
          found.push(...result.items.map(({ id }) => id));
          cursor = result.nextCursor;
        } while (cursor);
        assert.deepEqual(found, expected);
        assert.equal(new Set(found).size, found.length);
      });

      await suite.test("20.000 контакти се прелистуваат со ограничени одговори", async (testContext) => {
        await admin.query(`
          INSERT INTO aevyra.contacts (organization_id, normalized_phone)
          SELECT $1, '+1555' || lpad(n::text, 10, '0') FROM generate_series(1, 20000) AS n
        `, [bulk.id]);
        const beforeBrowse = await snapshot();
        const expected = (await admin.query<{ id: string }>(`
          SELECT id FROM aevyra.contacts WHERE organization_id = $1 ORDER BY normalized_phone ASC, id ASC
        `, [bulk.id])).rows.map(({ id }) => id);
        const started = performance.now();
        const found: string[] = [];
        let cursor: string | null = null;
        let requests = 0;
        do {
          const query = new URLSearchParams({ limit: "100" });
          if (cursor) query.set("cursor", cursor);
          const result = await readJson<ContactListPage>(await page(bulk.id, query.toString()), 200);
          requests++;
          assert.ok(result.items.length > 0 && result.items.length <= 100);
          assert.equal(result.totalContacts, 20_000);
          assert.equal(result.matchedContacts, 20_000);
          found.push(...result.items.map(({ id }) => id));
          cursor = result.nextCursor;
        } while (cursor);
        proof = { elapsedMs: Math.round(performance.now() - started), requests };
        assert.equal(requests, 200);
        assert.deepEqual(found, expected);
        assert.equal(new Set(found).size, 20_000);
        assert.deepEqual(await snapshot(), beforeBrowse);
        const defaultPage = await readJson<ContactListPage>(await page(bulk.id), 200);
        assert.equal(defaultPage.items.length, 25);
        testContext.diagnostic(`20.000 контакти: ${requests} HTTP страници по најмногу 100 записи за ${proof.elapsedMs} ms.`);
      });

      const beforeReadFailures = await snapshot();
      await suite.test("Недостапно читање од базата враќа безбедна порака", async () => {
        const role = pg.escapeIdentifier(database);
        await admin.query(`REVOKE SELECT ON aevyra.contacts FROM ${role}`);
        try {
          await expectError(await page(clinic.id), 503, "TEMPORARILY_UNAVAILABLE");
        } finally {
          await admin.query(`GRANT SELECT ON aevyra.contacts TO ${role}`);
        }
        await admin.query(`REVOKE SELECT ON aevyra_auth.session FROM ${role}`);
        try {
          await expectError(await page(clinic.id), 503, "TEMPORARILY_UNAVAILABLE");
        } finally {
          await admin.query(`GRANT SELECT ON aevyra_auth.session TO ${role}`);
        }
      });

      await suite.test("Читањата не менуваат контакти, увози или врски", async () => {
        assert.deepEqual(await snapshot(), beforeReadFailures);
      });

      suite.diagnostic(`Изолација: истиот телефон е зачуван како 3 различни контакти во 2 клиники и 1 маркетинг база.`);
      suite.diagnostic(`Пагинација: 20.000 различни контакти во ${proof.requests} ограничени одговори, ${proof.elapsedMs} ms локално.`);
    } finally {
      await stop();
    }
  });
});
