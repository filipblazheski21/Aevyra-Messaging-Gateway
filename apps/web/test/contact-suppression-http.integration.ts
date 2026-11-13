import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { text } from "node:stream/consumers";
import test from "node:test";
import { applyMigrations } from "../../../packages/db/src/migrations.ts";
import { provisionAppRole } from "../../../packages/db/src/provision.ts";
import { verifyTestTarget, withTestDatabase } from "../../../packages/db/test/test-database.ts";
import type {
  ContactSuppressionReadResponse,
  ContactSuppressionWriteResponse,
} from "../src/contact-suppressions.ts";
import type { ContactListPage } from "../src/contacts.ts";
import type { Organization } from "../src/organizations.ts";
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

test("Заштитен HTTP договор за евиденцијата „Не контактирај“", { timeout: 180_000 }, async (suite) => {
  await withTestDatabase(verifyTestTarget(), async (admin, databaseUrl, database) => {
    assert.equal((await applyMigrations(databaseUrl)).length, 5);
    const appUrl = new URL(databaseUrl);
    appUrl.username = database;
    appUrl.password = randomBytes(32).toString("base64url");
    await provisionAppRole(new URL(databaseUrl), appUrl);
    assert.match(database, /^[a-z0-9_]+$/);

    const port = await reserveWebPort();
    const baseURL = `http://127.0.0.1:${port}`;
    const settings = { baseURL, secureCookies: false, secret: randomBytes(32).toString("base64url") };
    const users = ["главен", "друг"].map((name, index) => ({
      name: `Синтетички ${name} оператор`,
      email: `suppression-http-${index}@example.test`,
      password: randomBytes(24).toString("base64url"),
    }));
    for (const user of users) await createCredentialUser(databaseUrl, settings, user);

    const { rows: organizations } = await admin.query<Organization>(`
      INSERT INTO aevyra.organizations (kind, name) VALUES
        ('CLINIC', 'Синтетичка клиника'),
        ('MARKETING', 'Синтетичка маркетинг база')
      RETURNING id, kind, name, created_at
    `);
    const [clinic, marketing] = organizations;
    const sharedPhone = "+38970123456";
    const { rows: contacts } = await admin.query<{ id: string; organization_id: string; normalized_phone: string }>(`
      INSERT INTO aevyra.contacts (organization_id, normalized_phone) VALUES
        ($1, $3), ($1, '+38970123457'), ($2, $3)
      RETURNING id, organization_id, normalized_phone
    `, [clinic.id, marketing.id, sharedPhone]);
    const clinicShared = contacts.find((item) => item.organization_id === clinic.id && item.normalized_phone === sharedPhone)!;
    const clinicOther = contacts.find((item) => item.organization_id === clinic.id && item.normalized_phone !== sharedPhone)!;
    const marketingShared = contacts.find((item) => item.organization_id === marketing.id)!;
    await admin.query(`
      INSERT INTO aevyra.contacts (organization_id, normalized_phone)
      SELECT $1, '+1202555' || lpad(n::text, 4, '0') FROM generate_series(1, 27) AS n
    `, [clinic.id]);

    const stop = await startTestWeb(port, {
      DATABASE_URL: appUrl.href,
      AUTH_BASE_URL: baseURL,
      AUTH_LOCAL_HTTP: "true",
      AUTH_SECRET: settings.secret,
      REAL_SENDING_ENABLED: "false",
    });
    const request = (path: string, init: RequestInit = {}) => fetch(`${baseURL}${path}`, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
    const route = (organizationId: string, contactId: string) =>
      `/api/organizations/${organizationId}/contacts/${contactId}/suppression`;

    try {
      const signIn = async (user: typeof users[number]) => {
        const response = await request("/api/auth/sign-in/email", {
          method: "POST",
          headers: { Origin: baseURL, "Content-Type": "application/json" },
          body: JSON.stringify({ email: user.email, password: user.password }),
        });
        assert.equal(response.status, 200);
        await response.body?.cancel();
        const session = response.headers.getSetCookie().find((value) => value.startsWith("better-auth.session_token="));
        assert.ok(session, "Недостасува тест-сесија.");
        return session.split(";")[0];
      };
      const [cookie] = await Promise.all(users.map(signIn));
      const post = (organizationId: string, contactId: string, body: unknown, origin = baseURL, session = cookie) => request(route(organizationId, contactId), {
        method: "POST",
        headers: { Origin: origin, Cookie: session, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const get = (organizationId: string, contactId: string, session = cookie) => request(route(organizationId, contactId), {
        headers: session ? { Cookie: session } : undefined,
      });

      await suite.test("Сесијата, Origin и патеката се задолжителни", async () => {
        await expectError(await get(clinic.id, clinicShared.id, ""), 401, "AUTH_REQUIRED");
        await expectError(await post(clinic.id, clinicShared.id, { reason: "CONTACT_REQUEST" }, baseURL, ""), 401, "AUTH_REQUIRED");
        await expectError(await post(clinic.id, clinicShared.id, { reason: "CONTACT_REQUEST" }, "https://untrusted.example.test"), 403, "ORIGIN_DENIED");
        await expectError(await get(randomUUID(), clinicShared.id), 404, "ORGANIZATION_NOT_FOUND");
        await expectError(await get(clinic.id, randomUUID()), 404, "CONTACT_NOT_FOUND");
        await expectError(await get(marketing.id, clinicShared.id), 404, "CONTACT_NOT_FOUND");
        await expectError(await request(`${route(clinic.id, clinicShared.id)}?unknown=1`, { headers: { Cookie: cookie } }), 400, "INVALID_REQUEST");
      });

      await suite.test("Клиентот не задава оператор и телото е строго ограничено", async () => {
        for (const body of [
          { reason: "CONTACT_REQUEST", operatorId: "клиент" },
          { reason: "CONTACT_REQUEST", unknown: true },
          { reference: "без причина" },
          { reason: "UNKNOWN" },
          { reason: "CONTACT_REQUEST", reference: "" },
          { reason: "CONTACT_REQUEST", reference: "а".repeat(251) },
        ]) await expectError(await post(clinic.id, clinicOther.id, body), 400, "INVALID_REQUEST");
        await expectError(await request(route(clinic.id, clinicOther.id), {
          method: "POST",
          headers: { Origin: baseURL, Cookie: cookie, "Content-Type": "text/plain" },
          body: "{}",
        }), 415, "UNSUPPORTED_MEDIA_TYPE");
        await expectError(await post(clinic.id, clinicOther.id, { reason: "CONTACT_REQUEST", padding: "а".repeat(4_096) }), 413, "BODY_TOO_LARGE");

        const chunked = await new Promise<Response>((resolve, reject) => {
          const raw = httpRequest(`${baseURL}${route(clinic.id, clinicOther.id)}`, {
            method: "POST",
            headers: { Origin: baseURL, Cookie: cookie, "Content-Type": "application/json", "Transfer-Encoding": "chunked" },
          }, async (response) => {
            const body = await text(response);
            const headers = new Headers();
            for (let index = 0; index < response.rawHeaders.length; index += 2) {
              headers.append(response.rawHeaders[index], response.rawHeaders[index + 1]);
            }
            resolve(new Response(body, { status: response.statusCode, headers }));
          });
          raw.on("error", reject);
          raw.write('{"reason":"CONTACT_REQUEST","reference":"');
          raw.end(`${"а".repeat(4_096)}"}`);
        });
        await expectError(chunked, 413, "BODY_TOO_LARGE");
      });

      let originalId = "";
      await suite.test("Нов запис, точен сесиски оператор и повторување го задржуваат оригиналот", async () => {
        const created = await readJson<ContactSuppressionWriteResponse>(await post(clinic.id, clinicShared.id, {
          reason: "CONTACT_REQUEST", reference: "Синтетичка референца",
        }), 201);
        assert.equal(created.outcome, "RECORDED");
        originalId = created.suppression.id;
        assert.equal(Object.hasOwn(created.suppression, "operatorId"), false);
        const { rows: [operator] } = await admin.query<{ id: string }>('SELECT id FROM aevyra_auth."user" WHERE email = $1', [users[0].email]);
        const { rows: [stored] } = await admin.query<{ operator_id: string }>(`
          SELECT operator_id FROM aevyra.contact_suppressions WHERE id = $1
        `, [created.suppression.id]);
        assert.equal(stored.operator_id, operator.id);

        const repeated = await readJson<ContactSuppressionWriteResponse>(await post(clinic.id, clinicShared.id, {
          reason: "CONTACT_REQUEST", reference: "Синтетичка референца",
        }), 200);
        assert.equal(repeated.outcome, "ALREADY_RECORDED");
        assert.deepEqual(repeated.suppression, created.suppression);

        const different = await readJson<ContactSuppressionWriteResponse>(await post(clinic.id, clinicShared.id, {
          reason: "INTERNAL_BLOCK", reference: "Нова вредност",
        }), 200);
        assert.equal(different.outcome, "ALREADY_RECORDED_DIFFERENT_METADATA");
        assert.deepEqual(different.suppression, created.suppression);
        assert.equal((await admin.query("SELECT count(*)::int AS count FROM aevyra.contact_suppressions WHERE organization_id = $1 AND contact_id = $2", [clinic.id, clinicShared.id])).rows[0].count, 1);
      });

      await suite.test("Паралелни барања создаваат само еден запис", async () => {
        const replies = await Promise.all(Array.from({ length: 8 }, () => post(clinic.id, clinicOther.id, { reason: "ORGANIZATION_REQUEST" })));
        const bodies = await Promise.all(replies.map((reply) => readJson<ContactSuppressionWriteResponse>(reply, reply.status)));
        assert.equal(bodies.filter(({ outcome }) => outcome === "RECORDED").length, 1);
        assert.ok(bodies.every(({ suppression }) => suppression.id === bodies[0].suppression.id));
        assert.equal((await admin.query("SELECT count(*)::int AS count FROM aevyra.contact_suppressions WHERE organization_id = $1 AND contact_id = $2", [clinic.id, clinicOther.id])).rows[0].count, 1);
      });

      await suite.test("Истиот телефон е независен во друга организација", async () => {
        const before = await readJson<ContactSuppressionReadResponse>(await get(marketing.id, marketingShared.id), 200);
        assert.deepEqual(before, { status: "NOT_SUPPRESSED", suppression: null });
        const created = await readJson<ContactSuppressionWriteResponse>(await post(marketing.id, marketingShared.id, { reason: "INTERNAL_BLOCK" }), 201);
        assert.notEqual(created.suppression.id, originalId);
        assert.equal(created.suppression.organizationId, marketing.id);
        const clinicRead = await readJson<ContactSuppressionReadResponse>(await get(clinic.id, clinicShared.id), 200);
        assert.equal(clinicRead.suppression?.organizationId, clinic.id);
      });

      await suite.test("Листата ја дава точната ознака без промена на бројачи и пагинација", async () => {
        const first = await readJson<ContactListPage>(await request(`/api/organizations/${clinic.id}/contacts?limit=25`, { headers: { Cookie: cookie } }), 200);
        assert.equal(first.totalContacts, 29);
        assert.equal(first.matchedContacts, 29);
        assert.equal(first.items.length, 25);
        assert.ok(first.nextCursor);
        const query = new URLSearchParams({ limit: "25", cursor: first.nextCursor! });
        const second = await readJson<ContactListPage>(await request(`/api/organizations/${clinic.id}/contacts?${query}`, { headers: { Cookie: cookie } }), 200);
        assert.equal(second.totalContacts, 29);
        assert.equal(second.matchedContacts, 29);
        assert.equal(second.items.length, 4);
        const allItems = [...first.items, ...second.items];
        assert.equal(new Set(allItems.map(({ id }) => id)).size, 29);
        assert.equal(allItems.find(({ id }) => id === clinicShared.id)?.hasSuppression, true);
        assert.equal(allItems.find(({ id }) => id === clinicOther.id)?.hasSuppression, true);
        assert.ok(allItems.filter(({ hasSuppression }) => hasSuppression).length === 2);
      });

      await suite.test("Недостапната табела не се претставува како отсуство", async () => {
        await admin.query(`REVOKE SELECT ON TABLE aevyra.contact_suppressions FROM "${database}"`);
        await expectError(await get(clinic.id, clinicShared.id), 503, "TEMPORARILY_UNAVAILABLE");
        await admin.query(`GRANT SELECT ON TABLE aevyra.contact_suppressions TO "${database}"`);
        const restored = await readJson<ContactSuppressionReadResponse>(await get(clinic.id, clinicShared.id), 200);
        assert.equal(restored.status, "SUPPRESSED");
      });

      await suite.test("HTTP читањата и неуспешните барања не менуваат други записи", async () => {
        const { rows: [counts] } = await admin.query(`SELECT
          (SELECT count(*)::int FROM aevyra.contacts) AS contacts,
          (SELECT count(*)::int FROM aevyra.contact_suppressions) AS suppressions,
          (SELECT count(*)::int FROM aevyra.contact_imports) AS imports,
          (SELECT count(*)::int FROM aevyra.contact_import_contacts) AS links
        `);
        assert.deepEqual(counts, { contacts: 30, suppressions: 3, imports: 0, links: 0 });
      });
    } finally {
      await stop();
    }
  });
});
