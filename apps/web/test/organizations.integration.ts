import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { applyMigrations } from "../../../packages/db/src/migrations.ts";
import { provisionAppRole } from "../../../packages/db/src/provision.ts";
import { verifyTestTarget, withTestDatabase } from "../../../packages/db/test/test-database.ts";
import type { Organization, OrganizationPage } from "../src/organizations.ts";
import { createCredentialUser } from "../src/server/create-credential-user.ts";
import { reserveWebPort, startTestWeb } from "./test-web.ts";

const collection = "/api/organizations";

test("Внатрешен регистар со вистински HTTP и ограничена PostgreSQL конекција", { timeout: 90_000 }, async (suite) => {
  await withTestDatabase(verifyTestTarget(), async (admin, databaseUrl, database) => {
    await applyMigrations(databaseUrl);
    const appUrl = new URL(databaseUrl);
    appUrl.username = database;
    appUrl.password = randomBytes(32).toString("base64url");
    await provisionAppRole(new URL(databaseUrl), appUrl);
    const port = await reserveWebPort();
    const baseURL = `http://127.0.0.1:${port}`;
    const settings = { baseURL, secureCookies: false, secret: randomBytes(32).toString("base64url") };
    const user = { name: "Синтетички оператор", email: "registry@example.test", password: randomBytes(24).toString("base64url") };
    const colleague = { ...user, email: "colleague@example.test" };
    await createCredentialUser(databaseUrl, settings, user);
    await createCredentialUser(databaseUrl, settings, colleague);
    const stop = await startTestWeb(port, {
      DATABASE_URL: appUrl.href, AUTH_BASE_URL: baseURL, AUTH_LOCAL_HTTP: "true", AUTH_SECRET: settings.secret, REAL_SENDING_ENABLED: "false",
    });

    const request = (path: string, init: RequestInit = {}) => fetch(`${baseURL}${path}`, {
      ...init, redirect: "manual", signal: AbortSignal.timeout(8_000),
    });
    const get = (path: string, cookie?: string) => request(path, { headers: cookie ? { Cookie: cookie } : undefined });
    const write = (method: "POST" | "PATCH", path: string, body: unknown, cookie?: string, origin: string | null = baseURL) => {
      const headers = new Headers({ "Content-Type": "application/json" });
      if (cookie) headers.set("Cookie", cookie);
      if (origin) headers.set("Origin", origin);
      return request(path, { method, headers, body: JSON.stringify(body) });
    };
    const signIn = async (operator: typeof user) => {
      const response = await write("POST", "/api/auth/sign-in/email", { email: operator.email, password: operator.password });
      assert.equal(response.status, 200);
      const cookie = response.headers.getSetCookie().find((value) => value.startsWith("better-auth.session_token="));
      assert.ok(cookie, "Недостасува сесиска cookie.");
      return cookie.split(";")[0];
    };
    const json = async <T,>(response: Response, status: number): Promise<T> => {
      assert.equal(response.status, status);
      assert.match(response.headers.get("Cache-Control") ?? "", /private.*no-store/i);
      return response.json();
    };
    const error = async (response: Response, status: number) => (await json<{ message: string }>(response, status)).message;
    const count = async () => (await admin.query<{ count: number }>("SELECT count(*)::int FROM aevyra.organizations")).rows[0].count;

    try {
      const missingId = randomUUID();
      await suite.test("Сите операции и страницата за детали бараат сесија", async () => {
        for (const response of [await get(collection), await get(`${collection}/${missingId}`),
          await write("POST", collection, { name: "Клиника", kind: "CLINIC" }),
          await write("PATCH", `${collection}/${missingId}`, { name: "Измена" })]) {
          assert.equal(await error(response, 401), "Потребна е најава.");
        }
        const page = await get(`/app/organizations/${missingId}`);
        assert.equal(page.status, 307);
        assert.equal(page.headers.get("Location"), "/login");
      });

      const cookie = await signIn(user);
      let clinic: Organization;
      let marketing: Organization;
      await suite.test("Создавање, филтри и детали за клиника и маркетинг база", async () => {
        assert.deepEqual(await json(await get(`${collection}?kind=CLINIC`, cookie), 200), { items: [], nextCursor: null });
        clinic = await json(await write("POST", collection, { kind: "CLINIC", name: "  Синтетичка клиника  " }, cookie), 201);
        marketing = await json(await write("POST", collection, { kind: "MARKETING", name: "Синтетичка маркетинг база" }, cookie), 201);
        assert.equal(clinic.name, "Синтетичка клиника");
        assert.equal(clinic.kind, "CLINIC");
        assert.equal(marketing.kind, "MARKETING");
        assert.notEqual(clinic.id, marketing.id);
        assert.ok(Number.isFinite(Date.parse(clinic.created_at)));
        assert.deepEqual(await json(await get(`${collection}?kind=CLINIC`, cookie), 200), { items: [clinic], nextCursor: null });
        assert.deepEqual(await json(await get(`${collection}?kind=MARKETING`, cookie), 200), { items: [marketing], nextCursor: null });
        assert.deepEqual(await json(await get(`${collection}/${clinic.id}`, cookie), 200), clinic);
        const page = await get(`/app/organizations/${clinic.id}`, cookie);
        assert.equal(page.status, 200);
        assert.match(page.headers.get("Cache-Control") ?? "", /private.*no-store/i);
        const markup = await page.text();
        assert.ok(markup.includes(clinic.name) && markup.includes("Измени име"));
      });

      await suite.test("Друга внатрешна сметка може да го измени само името, а SQL знаците остануваат податок", async () => {
        const colleagueCookie = await signIn(colleague);
        const name = "Синтетички O'Нил; -- SELECT (1)";
        const updated = await json(await write("PATCH", `${collection}/${clinic.id}`, { name: `  ${name}  ` }, colleagueCookie), 200);
        assert.deepEqual(updated, { ...clinic, name });
        assert.deepEqual(await json(await get(`${collection}/${clinic.id}`, cookie), 200), updated);
        assert.deepEqual(await json(await get(`${collection}/${marketing.id}`, cookie), 200), marketing);
        assert.equal(await count(), 2);
      });

      await suite.test("Невалидни имиња, видови, полиња и идентификатори се одбиваат", async () => {
        const path = `${collection}/${clinic.id}`;
        for (const name of ["", "  \t ", "а".repeat(201), 12, null, "име\0", "\ud800"]) {
          assert.match(await error(await write("POST", collection, { kind: "CLINIC", name }, cookie), 400), /[Ии]ме/);
          assert.match(await error(await write("PATCH", path, { name }, cookie), 400), /[Ии]ме/);
        }
        assert.match(await error(await write("POST", collection, { kind: "clinic", name: "Синтетички запис" }, cookie), 400), /Видот/);
        assert.match(await error(await write("POST", collection, { kind: "CLINIC", name: "Синтетички запис", extra: true }, cookie), 400), /полиња/);
        for (const key of ["kind", "id", "created_at", "extra"]) {
          assert.match(await error(await write("PATCH", path, { name: "Измена", [key]: null }, cookie), 400), /полиња/);
        }
        assert.match(await error(await get(`${collection}/невалиден`, cookie), 400), /UUID/);
        assert.match(await error(await write("PATCH", `${collection}/невалиден`, { name: "Измена" }, cookie), 400), /UUID/);
        assert.equal(await error(await get(`${collection}/${missingId}`, cookie), 404), "Записот не е пронајден.");
        assert.equal(await error(await write("PATCH", `${collection}/${missingId}`, { name: "Измена" }, cookie), 404), "Записот не е пронајден.");
        assert.equal(await count(), 2);
      });

      await suite.test("Недоверливо или недостасувачко потекло не може да запишува", async () => {
        const before = await json(await get(`${collection}/${clinic.id}`, cookie), 200);
        for (const origin of ["https://other.example.test", null]) {
          assert.match(await error(await write("POST", collection, { name: "Синтетички запис", kind: "CLINIC" }, cookie, origin), 403), /Потеклото/);
          assert.match(await error(await write("PATCH", `${collection}/${clinic.id}`, { name: "Измена" }, cookie, origin), 403), /Потеклото/);
        }
        assert.deepEqual(await json(await get(`${collection}/${clinic.id}`, cookie), 200), before);
        assert.equal(await count(), 2);
      });

      await suite.test("Пагинацијата е ограничена на 100, со стабилен UUID критериум за ист датум", async () => {
        await admin.query(`INSERT INTO aevyra.organizations (kind, name, created_at)
          SELECT 'CLINIC', 'Синтетичка клиника ' || n, '2026-01-01 12:00:00.123456+00'::timestamptz
          FROM generate_series(1, 103) n`);
        const expected = (await admin.query<{ id: string }>(`SELECT id FROM aevyra.organizations
          WHERE kind = 'CLINIC' ORDER BY created_at DESC, id DESC`)).rows.map(({ id }) => id);
        const params = `${collection}?kind=CLINIC&limit=100`;
        const first = await json<OrganizationPage>(await get(params, cookie), 200);
        assert.equal(first.items.length, 100);
        assert.equal(first.nextCursor, first.items.at(-1)?.id);
        const second = await json<OrganizationPage>(await get(`${params}&cursor=${first.nextCursor}`, cookie), 200);
        assert.deepEqual([...first.items, ...second.items].map(({ id }) => id), expected);
        assert.equal(second.nextCursor, null);
        assert.equal((await json<OrganizationPage>(await get(`${collection}?kind=CLINIC`, cookie), 200)).items.length, 25);
        for (const query of ["limit=101", "limit=0", "limit=1.5", "limit=5&limit=6", "kind=OTHER", "offset=0", "cursor=невалиден", `kind=MARKETING&cursor=${first.nextCursor}`]) {
          assert.equal((await get(`${collection}?${query}`, cookie)).status, 400);
        }
      });

      await suite.test("SQL неуспех враќа грешка, а одјава и health проверките продолжуваат да работат", async () => {
        const role = pg.escapeIdentifier(database);
        await admin.query(`REVOKE SELECT ON aevyra.organizations FROM ${role}`);
        try {
          assert.match(await error(await get(collection, cookie), 503), /недостапен/);
        } finally {
          await admin.query(`GRANT SELECT ON aevyra.organizations TO ${role}`);
        }
        assert.equal((await request(`${collection}/${clinic.id}`, { method: "DELETE", headers: { Cookie: cookie } })).status, 405);
        assert.equal((await get("/api/health/live")).status, 200);
        assert.equal((await get("/api/health/ready")).status, 200);
        assert.deepEqual(await json(await write("POST", "/api/auth/sign-out", {}, cookie), 200), { ok: true });
        assert.equal((await get(collection, cookie)).status, 401);
      });
    } finally {
      await stop();
    }
  });
});
