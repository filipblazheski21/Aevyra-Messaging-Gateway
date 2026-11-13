import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { text } from "node:stream/consumers";
import test from "node:test";
import { applyMigrations } from "../../../packages/db/src/migrations.ts";
import { provisionAppRole } from "../../../packages/db/src/provision.ts";
import { verifyTestTarget, withTestDatabase } from "../../../packages/db/test/test-database.ts";
import type { Organization } from "../src/organizations.ts";
import { contactBasisErrorReply } from "../src/server/contact-basis-http.ts";
import { ContactBasisError } from "../src/server/contact-bases.ts";
import type {
  ContactBasisCurrentState,
  ContactBasisWriteResult,
} from "../src/server/contact-bases.ts";
import { createCredentialUser } from "../src/server/create-credential-user.ts";
import { reserveWebPort, startTestWeb } from "./test-web.ts";

type ErrorBody = { code: string; message: string };

async function readJson<Value>(response: Response, status: number): Promise<Value> {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  return response.json();
}

async function expectError(response: Response, status: number, code: string) {
  const body = await readJson<ErrorBody>(response, status);
  assert.equal(body.code, code);
  assert.match(body.message, /\p{Script=Cyrillic}/u);
  assert.doesNotMatch(body.message, /SELECT|permission|password|PostgreSQL|aevyra\.|stack|at file:/i);
  return body;
}

function exactJsonBytes(size: number) {
  const prefix = '{"eventType":"RECORD","padding":"';
  const suffix = '"}';
  const value = `${prefix}${"x".repeat(size - Buffer.byteLength(prefix) - Buffer.byteLength(suffix))}${suffix}`;
  assert.equal(Buffer.byteLength(value), size);
  return value;
}

test("Заштитен HTTP договор за основите за контакт", { timeout: 240_000 }, async (suite) => {
  await withTestDatabase(verifyTestTarget(), async (admin, databaseUrl, database) => {
    assert.equal((await applyMigrations(databaseUrl)).length, 5);
    const adminUrl = new URL(databaseUrl);
    const appUrl = new URL(databaseUrl);
    appUrl.username = database;
    appUrl.password = randomBytes(32).toString("base64url");
    await provisionAppRole(adminUrl, appUrl);
    assert.match(database, /^[a-z0-9_]+$/);

    const port = await reserveWebPort();
    const baseURL = `http://127.0.0.1:${port}`;
    const settings = { baseURL, secureCookies: false, secret: randomBytes(32).toString("base64url") };
    const user = {
      name: "Синтетички HTTP оператор",
      email: "contact-basis-http@example.test",
      password: randomBytes(24).toString("base64url"),
    };
    const operatorId = await createCredentialUser(databaseUrl, settings, user);
    const { rows: organizations } = await admin.query<Organization>(`
      INSERT INTO aevyra.organizations (kind, name) VALUES
        ('CLINIC', 'Синтетичка HTTP клиника'),
        ('MARKETING', 'Синтетичка HTTP маркетинг организација')
      RETURNING id, kind, name, created_at
    `);
    const [clinic, marketing] = organizations;
    const clinicPhones = Array.from({ length: 9 }, (_, index) => `+1202555030${index + 1}`);
    const { rows: contacts } = await admin.query<{ id: string; organization_id: string; normalized_phone: string }>(`
      INSERT INTO aevyra.contacts (organization_id, normalized_phone)
      SELECT $1::uuid, unnest($3::text[])
      UNION ALL SELECT $2::uuid, '+12025550401'
      RETURNING id, organization_id, normalized_phone
    `, [clinic.id, marketing.id, clinicPhones]);
    const clinicContact = (index: number) => contacts.find(({ organization_id, normalized_phone }) => (
      organization_id === clinic.id && normalized_phone === clinicPhones[index]
    ))!;
    const marketingContact = contacts.find(({ organization_id }) => organization_id === marketing.id)!;

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
    const route = (organizationId: string, contactId: string) => (
      `/api/organizations/${organizationId}/contacts/${contactId}/basis`
    );
    const withQuery = (
      organizationId: string,
      contactId: string,
      purpose = "PATIENT_INFORMATION",
      channel = "SMS",
    ) => `${route(organizationId, contactId)}?${new URLSearchParams({ purpose, channel })}`;

    try {
      const signIn = await request("/api/auth/sign-in/email", {
        method: "POST",
        headers: { Origin: baseURL, "Content-Type": "application/json" },
        body: JSON.stringify({ email: user.email, password: user.password }),
      });
      assert.equal(signIn.status, 200);
      await signIn.body?.cancel();
      const session = signIn.headers.getSetCookie().find((value) => value.startsWith("better-auth.session_token="));
      assert.ok(session, "Недостасува тест-сесија.");
      const cookie = session.split(";")[0];
      const get = (
        organizationId: string,
        contactId: string,
        purpose = "PATIENT_INFORMATION",
        channel = "SMS",
        activeCookie = cookie,
      ) => request(withQuery(organizationId, contactId, purpose, channel), {
        headers: activeCookie ? { Cookie: activeCookie } : undefined,
      });
      const post = (
        organizationId: string,
        contactId: string,
        body: unknown,
        options: { origin?: string; activeCookie?: string; contentType?: string; query?: string } = {},
      ) => request(`${route(organizationId, contactId)}${options.query ?? ""}`, {
        method: "POST",
        headers: {
          Origin: options.origin ?? baseURL,
          Cookie: options.activeCookie ?? cookie,
          "Content-Type": options.contentType ?? "application/json",
        },
        body: typeof body === "string" ? body : JSON.stringify(body),
      });
      const recordBody = (overrides: Record<string, unknown> = {}) => ({
        eventType: "RECORD",
        purpose: "PATIENT_INFORMATION",
        channel: "SMS",
        expectedRevision: 0,
        idempotencyKey: randomUUID(),
        basisType: "CONSENT",
        reference: "SYNTHETIC-HTTP-001",
        ...overrides,
      });

      await suite.test("сесијата и trusted Origin се проверуваат пред телото", async () => {
        const target = clinicContact(0);
        await expectError(await get(clinic.id, target.id, "PATIENT_INFORMATION", "SMS", ""), 401, "AUTH_REQUIRED");
        await expectError(await post(clinic.id, target.id, "{invalid", { activeCookie: "" }), 401, "AUTH_REQUIRED");
        await expectError(await post(clinic.id, target.id, "{invalid", {
          origin: "https://untrusted.example.test",
        }), 403, "ORIGIN_DENIED");
        assert.equal((await admin.query("SELECT FROM aevyra.contact_basis_events")).rowCount, 0);
      });

      await suite.test("идентитетите се земаат само од патеката и сесијата", async () => {
        const target = clinicContact(0);
        for (const protectedField of [
          { operatorId: "client_operator" },
          { organizationId: clinic.id },
          { contactId: target.id },
        ]) {
          await expectError(await post(clinic.id, target.id, recordBody(protectedField)), 400, "INVALID_REQUEST");
        }
        await expectError(await get(randomUUID(), target.id), 404, "ORGANIZATION_NOT_FOUND");
        await expectError(await get(clinic.id, randomUUID()), 404, "CONTACT_NOT_FOUND");
        await expectError(await get(marketing.id, target.id, "AEVYRA_MARKETING"), 404, "CONTACT_NOT_FOUND");
        assert.equal((await admin.query("SELECT FROM aevyra.contact_basis_events")).rowCount, 0);
      });

      await suite.test("намената е ограничена според видот на организацијата", async () => {
        assert.equal((await readJson<ContactBasisCurrentState>(
          await get(clinic.id, clinicContact(0).id), 200,
        )).status, "MISSING");
        assert.equal((await readJson<ContactBasisCurrentState>(
          await get(marketing.id, marketingContact.id, "AEVYRA_MARKETING", "VIBER"), 200,
        )).status, "MISSING");
        const marketingRecorded = await readJson<ContactBasisWriteResult>(await post(
          marketing.id,
          marketingContact.id,
          recordBody({ purpose: "AEVYRA_MARKETING", channel: "VIBER", reference: "SYNTHETIC-MARKETING" }),
        ), 201);
        assert.equal(marketingRecorded.current.status, "RECORDED");
        assert.equal((await readJson<ContactBasisCurrentState>(
          await get(marketing.id, marketingContact.id, "AEVYRA_MARKETING", "VIBER"), 200,
        )).status, "RECORDED");
        await expectError(await get(clinic.id, clinicContact(0).id, "AEVYRA_MARKETING"), 400, "PURPOSE_NOT_ALLOWED");
        await expectError(await get(marketing.id, marketingContact.id, "PATIENT_INFORMATION"), 400, "PURPOSE_NOT_ALLOWED");
      });

      await suite.test("query, JSON, полињата и Content-Type имаат строг договор", async () => {
        const target = clinicContact(0);
        await expectError(await request(`${route(clinic.id, target.id)}?purpose=PATIENT_INFORMATION`, {
          headers: { Cookie: cookie },
        }), 400, "INVALID_REQUEST");
        await expectError(await request(`${withQuery(clinic.id, target.id)}&purpose=PATIENT_INFORMATION`, {
          headers: { Cookie: cookie },
        }), 400, "INVALID_REQUEST");
        await expectError(await request(`${withQuery(clinic.id, target.id)}&unknown=1`, {
          headers: { Cookie: cookie },
        }), 400, "INVALID_REQUEST");
        await expectError(await post(clinic.id, target.id, recordBody(), { query: "?unknown=1" }), 400, "INVALID_REQUEST");
        await expectError(await post(clinic.id, target.id, "{invalid"), 400, "INVALID_REQUEST");
        await expectError(await post(clinic.id, target.id, "null"), 400, "INVALID_REQUEST");
        await expectError(await post(clinic.id, target.id, "[]"), 400, "INVALID_REQUEST");
        await expectError(await post(clinic.id, target.id, { eventType: "UNKNOWN" }), 400, "INVALID_REQUEST");
        await expectError(await post(clinic.id, target.id, recordBody({ unknown: true })), 400, "INVALID_REQUEST");
        await expectError(await post(clinic.id, target.id, recordBody(), { contentType: "text/plain" }), 415, "UNSUPPORTED_MEDIA_TYPE");
        await expectError(await post(clinic.id, target.id, recordBody(), {
          contentType: "application/json; charset=iso-8859-1",
        }), 415, "UNSUPPORTED_MEDIA_TYPE");
      });

      await suite.test("4 KiB границата важи со Content-Length и chunked тело", async () => {
        const target = clinicContact(0);
        await expectError(await post(clinic.id, target.id, exactJsonBytes(4_096)), 400, "INVALID_REQUEST");
        await expectError(await post(clinic.id, target.id, exactJsonBytes(4_097)), 413, "BODY_TOO_LARGE");
        const chunked = await new Promise<Response>((resolve, reject) => {
          const raw = httpRequest(`${baseURL}${route(clinic.id, target.id)}`, {
            method: "POST",
            headers: {
              Origin: baseURL,
              Cookie: cookie,
              "Content-Type": "application/json; charset=utf-8",
              "Transfer-Encoding": "chunked",
            },
          }, async (response) => {
            const body = await text(response);
            const headers = new Headers();
            for (let index = 0; index < response.rawHeaders.length; index += 2) {
              headers.append(response.rawHeaders[index], response.rawHeaders[index + 1]);
            }
            resolve(new Response(body, { status: response.statusCode, headers }));
          });
          raw.on("error", reject);
          raw.write('{"eventType":"RECORD","padding":"');
          raw.end(`${"x".repeat(4_096)}"}`);
        });
        await expectError(chunked, 413, "BODY_TOO_LARGE");
      });

      await suite.test("GET враќа MISSING, а RECORD користи оператор од сесијата", async () => {
        const target = clinicContact(1);
        const missing = await readJson<ContactBasisCurrentState>(await get(clinic.id, target.id), 200);
        assert.deepEqual({ status: missing.status, revision: missing.revision, latestEvent: missing.latestEvent }, {
          status: "MISSING", revision: 0, latestEvent: null,
        });
        const created = await readJson<ContactBasisWriteResult>(await post(clinic.id, target.id, recordBody(), {
          contentType: "application/json; charset=UTF-8",
        }), 201);
        assert.equal(created.outcome, "APPENDED");
        assert.equal(created.current.status, "RECORDED");
        assert.equal(created.event.operatorId, operatorId);
        const stored = await admin.query<{ operator_id: string }>(`
          SELECT operator_id FROM aevyra.contact_basis_events WHERE id = $1
        `, [created.event.id]);
        assert.deepEqual(stored.rows, [{ operator_id: operatorId }]);
        assert.deepEqual(await readJson<ContactBasisCurrentState>(await get(clinic.id, target.id), 200), created.current);
      });

      await suite.test("идентично повторување не дуплира, а конфликтите се разликуваат", async () => {
        const target = clinicContact(2);
        const prepared = recordBody({ reference: "IDEMPOTENT-HTTP" });
        const original = await readJson<ContactBasisWriteResult>(await post(clinic.id, target.id, prepared), 201);
        const repeated = await readJson<ContactBasisWriteResult>(await post(clinic.id, target.id, prepared), 200);
        assert.equal(repeated.outcome, "REPLAYED");
        assert.equal(repeated.event.id, original.event.id);
        await expectError(await post(clinic.id, target.id, {
          ...prepared, reference: "DIFFERENT",
        }), 409, "IDEMPOTENCY_CONFLICT");
        await expectError(await post(clinic.id, target.id, recordBody({
          expectedRevision: 0,
          reference: "STALE-REVISION",
        })), 409, "REVISION_CONFLICT");
        assert.equal((await admin.query(`
          SELECT FROM aevyra.contact_basis_events WHERE organization_id = $1 AND contact_id = $2
        `, [clinic.id, target.id])).rowCount, 1);
      });

      await suite.test("стар RECORD по WITHDRAW го враќа оригиналот, но current останува WITHDRAWN", async () => {
        const target = clinicContact(3);
        const prepared = recordBody({ channel: "VIBER", reference: "OLD-HTTP-RECORD" });
        const original = await readJson<ContactBasisWriteResult>(await post(clinic.id, target.id, prepared), 201);
        const withdrawn = await readJson<ContactBasisWriteResult>(await post(clinic.id, target.id, {
          eventType: "WITHDRAW",
          purpose: "PATIENT_INFORMATION",
          channel: "VIBER",
          expectedRevision: 1,
          idempotencyKey: randomUUID(),
          reference: "SYNTHETIC-WITHDRAW",
        }), 201);
        assert.equal(withdrawn.current.status, "WITHDRAWN");
        const replayed = await readJson<ContactBasisWriteResult>(await post(clinic.id, target.id, prepared), 200);
        assert.equal(replayed.outcome, "REPLAYED");
        assert.equal(replayed.event.id, original.event.id);
        assert.equal(replayed.event.revision, 1);
        assert.equal(replayed.current.status, "WITHDRAWN");
        assert.equal(replayed.current.revision, 2);
        assert.equal(replayed.current.latestEvent?.eventType, "WITHDRAW");
        const current = await readJson<ContactBasisCurrentState>(
          await get(clinic.id, target.id, "PATIENT_INFORMATION", "VIBER"), 200,
        );
        assert.equal(current.status, "WITHDRAWN");
        assert.equal(current.revision, 2);
        assert.equal((await admin.query(`
          SELECT FROM aevyra.contact_basis_events WHERE organization_id = $1 AND contact_id = $2
        `, [clinic.id, target.id])).rowCount, 2);
      });

      await suite.test("невалиден календарски датум не остава запис", async () => {
        const target = clinicContact(4);
        await expectError(await post(clinic.id, target.id, recordBody({
          expiresAt: "2030-02-30T12:00:00Z",
        })), 400, "INVALID_REQUEST");
        assert.equal((await admin.query(`
          SELECT FROM aevyra.contact_basis_events WHERE organization_id = $1 AND contact_id = $2
        `, [clinic.id, target.id])).rowCount, 0);
      });

      await suite.test("GET ја зачувува EXPIRED состојбата без враќање на постар настан", async () => {
        const target = clinicContact(8);
        await admin.query(`
          INSERT INTO aevyra.contact_basis_events (
            organization_id, contact_id, purpose, channel, event_type, operator_id, recorded_at, revision,
            idempotency_key, request_fingerprint, basis_type, reference, expires_at
          ) VALUES (
            $1, $2, 'PATIENT_INFORMATION', 'SMS', 'RECORD', $3, now() - interval '2 days', 1,
            $4, $5, 'DOCUMENTED_BASIS', 'SYNTHETIC-EXPIRED', now() - interval '1 day'
          )
        `, [clinic.id, target.id, operatorId, randomUUID(), "e".repeat(64)]);
        const current = await readJson<ContactBasisCurrentState>(await get(clinic.id, target.id), 200);
        assert.equal(current.status, "EXPIRED");
        assert.equal(current.latestEvent?.reference, "SYNTHETIC-EXPIRED");
      });

      await suite.test("RECORD не ја поништува постојната евиденција Не контактирај", async () => {
        const target = clinicContact(5);
        const { rows: [suppression] } = await admin.query<{ id: string }>(`
          INSERT INTO aevyra.contact_suppressions (organization_id, contact_id, operator_id, reason, reference)
          VALUES ($1, $2, $3, 'CONTACT_REQUEST', 'SYNTHETIC-BLOCK') RETURNING id
        `, [clinic.id, target.id, operatorId]);
        const created = await readJson<ContactBasisWriteResult>(await post(clinic.id, target.id, recordBody()), 201);
        assert.equal(created.current.status, "RECORDED");
        assert.equal(created.current.suppression?.id, suppression.id);
        const current = await readJson<ContactBasisCurrentState>(await get(clinic.id, target.id), 200);
        assert.equal(current.suppression?.id, suppression.id);
        assert.equal((await admin.query(`
          SELECT FROM aevyra.contact_suppressions WHERE organization_id = $1 AND contact_id = $2
        `, [clinic.id, target.id])).rowCount, 1);
      });

      await suite.test("по изгубено успешно тело, истиот клуч го враќа истиот настан", async () => {
        const target = clinicContact(6);
        const prepared = recordBody({ reference: "LOST-HTTP-RESPONSE" });
        const serialized = JSON.stringify(prepared);
        const status = await new Promise<number | undefined>((resolve, reject) => {
          const raw = httpRequest(`${baseURL}${route(clinic.id, target.id)}`, {
            method: "POST",
            headers: {
              Origin: baseURL,
              Cookie: cookie,
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(serialized),
            },
          }, (response) => {
            const responseStatus = response.statusCode;
            response.destroy();
            resolve(responseStatus);
          });
          raw.on("error", reject);
          raw.end(serialized);
        });
        assert.equal(status, 201);
        const { rows: [stored] } = await admin.query<{ id: string }>(`
          SELECT id FROM aevyra.contact_basis_events WHERE organization_id = $1 AND contact_id = $2
        `, [clinic.id, target.id]);
        assert.ok(stored?.id);
        const replayed = await readJson<ContactBasisWriteResult>(await post(clinic.id, target.id, prepared), 200);
        assert.equal(replayed.outcome, "REPLAYED");
        assert.equal(replayed.event.id, stored.id);
      });

      await suite.test("недостапноста не се прикажува како MISSING", async () => {
        const target = clinicContact(7);
        await admin.query(`REVOKE SELECT ON TABLE aevyra.contact_basis_events FROM "${database}"`);
        try {
          await expectError(await get(clinic.id, target.id), 503, "TEMPORARILY_UNAVAILABLE");
        } finally {
          await admin.query(`GRANT SELECT ON TABLE aevyra.contact_basis_events TO "${database}"`);
        }
        assert.equal((await readJson<ContactBasisCurrentState>(await get(clinic.id, target.id), 200)).status, "MISSING");
      });

      await suite.test("симулираното OUTCOME_UNKNOWN мапирање е одделно од PostgreSQL COMMIT тестот", async () => {
        const response = contactBasisErrorReply(new ContactBasisError(
          "OUTCOME_UNKNOWN",
          "Исходот од евидентирањето е неизвесен. Повторете со истиот клуч.",
        ));
        await expectError(response, 503, "OUTCOME_UNKNOWN");
      });

      await suite.test("завршната историја нема неочекувани дупликати", async () => {
        const { rows: [counts] } = await admin.query(`SELECT
          (SELECT count(*)::int FROM aevyra.contact_basis_events) AS events,
          (SELECT count(*)::int FROM aevyra.contact_suppressions) AS suppressions,
          (SELECT count(*)::int FROM aevyra.contact_imports) AS imports,
          (SELECT count(*)::int FROM aevyra.contact_import_contacts) AS links
        `);
        assert.deepEqual(counts, { events: 8, suppressions: 1, imports: 0, links: 0 });
      });
    } finally {
      await stop();
    }
  });
});
