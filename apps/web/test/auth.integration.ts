import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { getMigrations } from "better-auth/db/migration";
import pg from "pg";
import { withPostgresClient } from "../../../packages/db/src/admin-client.ts";
import { applyMigrations } from "../../../packages/db/src/migrations.ts";
import { provisionAppRole } from "../../../packages/db/src/provision.ts";
import { verifyTestTarget, withTestDatabase } from "../../../packages/db/test/test-database.ts";
import { authSessionSeconds, createAuth } from "../src/server/auth-core.ts";
import { createCredentialUser } from "../src/server/create-credential-user.ts";
import { reserveWebPort, startTestWeb } from "./test-web.ts";

const user = { name: "Тест корисник", email: "auth@example.test", password: randomBytes(24).toString("base64url") };
const invalidPassword = randomBytes(24).toString("base64url");
const loginPath = "/api/auth/sign-in/email";
const logoutPath = "/api/auth/sign-out";
const invalidMessage = "Е-поштата или лозинката е погрешна.";

async function expectSuccess(response: Response) {
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Cache-Control") ?? "", /private.*no-store/i);
  const body = await response.json();
  assert.ok(Object.keys(body).length === 1 && body.ok === true, "Одговорот мора да содржи само потврда.");
}

function sessionCookie(response: Response, secure: boolean) {
  const cookies = response.headers.getSetCookie();
  const cookie = cookies.find((value) => /^(?:__Secure-)?better-auth\.session_token=/.test(value));
  assert.ok(cookie, "Недостасува сесиска cookie.");
  assert.ok(cookies.length === 1, "Очекувана е само сесиската cookie.");
  assert.ok(/;\s*HttpOnly/i.test(cookie) && /;\s*Path=\//i.test(cookie) && /;\s*SameSite=Lax/i.test(cookie), "Атрибутите на cookie се погрешни.");
  assert.ok(new RegExp(`;\\s*Max-Age=${authSessionSeconds}(?:;|$)`, "i").test(cookie), "Времетраењето на cookie е погрешно.");
  assert.equal(/;\s*Secure(?:;|$)/i.test(cookie), secure);
  assert.equal(cookie.startsWith("__Secure-"), secure);
  return cookie.split(";")[0];
}

test("Најава и PostgreSQL сесии преку вистински HTTP барања", { timeout: 120_000 }, async (suite) => {
  const target = verifyTestTarget();
  await withTestDatabase(target, async (admin, databaseUrl, database) => {
    await applyMigrations(databaseUrl);
    const appUrl = new URL(databaseUrl);
    appUrl.username = database;
    appUrl.password = randomBytes(32).toString("base64url");
    await provisionAppRole(new URL(databaseUrl), appUrl);
    const port = await reserveWebPort();
    const baseURL = `http://127.0.0.1:${port}`;
    const settings = { baseURL, secret: randomBytes(32).toString("base64url"), secureCookies: false };
    const config = { DATABASE_URL: appUrl.href, AUTH_BASE_URL: baseURL, AUTH_LOCAL_HTTP: "true", AUTH_SECRET: settings.secret, REAL_SENDING_ENABLED: "false" };
    let stop: (() => Promise<void>) | undefined;
    const restart = async (overrides: Partial<NodeJS.ProcessEnv> = {}) => {
      await stop?.();
      stop = await startTestWeb(port, { ...config, ...overrides });
    };
    const request = (path: string, init: RequestInit = {}) => fetch(`${baseURL}${path}`, {
      ...init, redirect: "manual", signal: AbortSignal.timeout(12_000),
    });
    const post = (path: string, body: object, headers: Record<string, string> = {}) => request(path, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: baseURL, ...headers }, body: JSON.stringify(body),
    });
    const credentials = { email: user.email, password: user.password };
    const signIn = async () => {
      const response = await post(loginPath, credentials);
      await expectSuccess(response);
      return sessionCookie(response, false);
    };
    const expectBlocked = async (cookie?: string) => {
      const headers = cookie ? { Cookie: cookie } : undefined;
      const me = await request("/api/me", { headers });
      assert.equal(me.status, 401);
      assert.match(me.headers.get("Cache-Control") ?? "", /private.*no-store/i);
      assert.ok((await me.json()).message === "Потребна е најава.");
      const page = await request("/app", { headers });
      assert.equal(page.status, 307);
      assert.equal(page.headers.get("Location"), "/login");
    };
    const countSessions = async () => (await admin.query("SELECT count(*)::int AS count FROM aevyra_auth.session")).rows[0].count;

    try {
      await suite.test("Миграцијата одговара на Better Auth без дополнителни промени", async () => {
        const { auth, pool } = createAuth(databaseUrl, settings);
        try {
          const plan = await getMigrations(auth.options);
          assert.equal(plan.toBeCreated.length + plan.toBeAdded.length + plan.toBeAddedIndexes.length + plan.schemaProblems.length, 0);
        } finally { await pool.end(); }
      });

      const userId = await createCredentialUser(databaseUrl, settings, user);
      await suite.test("Административната операција создава credential account, одбива дупликат и не отвора сесија", async () => {
        await assert.rejects(createCredentialUser(databaseUrl, settings, { ...user, email: user.email.toUpperCase(), password: invalidPassword }), /Веќе постои корисник/);
        const result = await admin.query('SELECT "providerId", password IS NOT NULL AS configured FROM aevyra_auth.account WHERE "userId" = $1', [userId]);
        assert.deepEqual(result.rows, [{ providerId: "credential", configured: true }]);
        assert.equal(await countSessions(), 0);
      });

      await restart();
      await suite.test("Најавата е на македонски, а серверот ги одбива барањата без сесија", async () => {
        const page = await request("/login");
        assert.equal(page.status, 200);
        const markup = await page.text();
        assert.ok(["Најава", "Е-пошта", "Лозинка", "Најави се"].every((text) => markup.includes(text)));
        await expectBlocked();
      });

      await suite.test("Регистрација, неподготвени операции, туѓ origin и надворешни пренасочувања се одбиени", async () => {
        for (const path of ["sign-up/email", "change-email", "reset-password", "get-session", "list-sessions"]) {
          assert.equal((await post(`/api/auth/${path}`, {})).status, 404);
        }
        assert.equal((await request("/api/auth/get-session")).status, 404);
        assert.equal((await post(loginPath, credentials, { Origin: "https://other.example.test" })).status, 403);
        assert.equal((await post(loginPath, { ...credentials, callbackURL: "https://other.example.test" })).status, 403);
        assert.equal((await post(`${loginPath}?callbackURL=https://other.example.test`, credentials)).status, 403);
        assert.equal(await countSessions(), 0);
      });

      await suite.test("Погрешна лозинка и непостоечка е-пошта враќаат иста општа порака", async () => {
        const bad = await post(loginPath, { ...credentials, password: invalidPassword });
        const missing = await post(loginPath, { ...credentials, email: "missing@example.test" });
        for (const response of [bad, missing]) {
          assert.equal(response.status, 401);
          assert.ok((await response.json()).message === invalidMessage);
          assert.equal(response.headers.getSetCookie().length, 0);
        }
      });

      let cookie = await signIn();
      await suite.test("Валидна сесија враќа минимален профил и преживува рестарт без продолжување", async () => {
        const readExpiry = async () => (await admin.query(`SELECT "expiresAt"::text AS expiry,
          extract(epoch FROM "expiresAt" - "createdAt")::int AS duration FROM aevyra_auth.session`)).rows[0];
        const before = await readExpiry();
        assert.equal(before.duration, authSessionSeconds);
        await restart();
        const profile = await request("/api/me", { headers: { Cookie: cookie } });
        assert.equal(profile.status, 200);
        assert.match(profile.headers.get("Cache-Control") ?? "", /private.*no-store/i);
        const value = await profile.json();
        assert.ok(Object.keys(value).sort().join(",") === "email,id,name" && value.id === userId && value.email === user.email && value.name === user.name);
        const page = await request("/app", { headers: { Cookie: cookie } });
        assert.equal(page.status, 200);
        assert.match(page.headers.get("Cache-Control") ?? "", /private.*no-store/i);
        const markup = await page.text();
        assert.ok(markup.includes(user.name) && markup.includes("Одјави се"));
        assert.deepEqual(await readExpiry(), before);
        const observed = await admin.query(`SELECT DISTINCT usename FROM pg_stat_activity
          WHERE datname = current_database() AND application_name = 'aevyra-auth'`);
        assert.deepEqual(observed.rows, [{ usename: database }]);
      });

      await suite.test("Изменета, укината и истечена cookie не даваат пристап", async () => {
        const index = cookie.indexOf("=") + 1;
        const tampered = cookie.slice(0, index) + (cookie[index] === "a" ? "b" : "a") + cookie.slice(index + 1);
        await expectBlocked(tampered);
        assert.equal(await countSessions(), 1);
        await admin.query("DELETE FROM aevyra_auth.session");
        await expectBlocked(cookie);
        cookie = await signIn();
        await admin.query(`UPDATE aevyra_auth.session SET "expiresAt" = now() - interval '1 second'`);
        await expectBlocked(cookie);
        assert.equal(await countSessions(), 0);
      });

      await suite.test("Одјава се потврдува само по укинувањето и ја брише cookie", async () => {
        cookie = await signIn();
        const role = pg.escapeIdentifier(database);
        await admin.query(`REVOKE DELETE ON aevyra_auth.session FROM ${role}`);
        try {
          const denied = await post(logoutPath, {}, { Cookie: cookie });
          assert.equal(denied.status, 503);
          assert.equal(denied.headers.getSetCookie().length, 0);
          assert.equal(await countSessions(), 1);
        } finally { await admin.query(`GRANT DELETE ON aevyra_auth.session TO ${role}`); }

        const signedOut = await post(logoutPath, {}, { Cookie: cookie });
        await expectSuccess(signedOut);
        assert.ok(signedOut.headers.getSetCookie().some((value) => /^better-auth\.session_token=;.*Max-Age=0/i.test(value)));
        assert.equal(await countSessions(), 0);
        await expectBlocked(cookie);
      });

      await suite.test("Шестиот обид е блокиран и ограничувањето преживува рестарт", async () => {
        await admin.query("DELETE FROM aevyra_auth.rate_limit");
        const attempt = (ip: string) => post(loginPath, { ...credentials, password: invalidPassword }, { "X-Forwarded-For": ip });
        const responses = await Promise.all(Array.from({ length: 6 }, (_, index) => attempt(`192.0.2.${index + 1}`)));
        assert.deepEqual(responses.map(({ status }) => status).sort(), [401, 401, 401, 401, 401, 429]);
        await restart();
        const denied = await attempt("198.51.100.42");
        assert.equal(denied.status, 429);
        assert.ok(Number(denied.headers.get("Retry-After")) > 0);
        assert.ok((await denied.json()).message === "Премногу обиди. Обидете се повторно подоцна.");
        assert.deepEqual((await admin.query("SELECT count FROM aevyra_auth.rate_limit")).rows, [{ count: 5 }]);
      });

      await suite.test("Недостапната тест-база не прифаќа претходно валидна cookie", async () => {
        await admin.query("DELETE FROM aevyra_auth.rate_limit");
        cookie = await signIn();
        await stop?.();
        const identifier = pg.escapeIdentifier(database);
        await withPostgresClient(target.adminUrl.href, 30_000, async (maintenance) => {
          await maintenance.query(`ALTER DATABASE ${identifier} ALLOW_CONNECTIONS false`);
          try {
            await restart();
            await expectBlocked(cookie);
            assert.equal((await request("/api/health/ready")).status, 503);
          } finally {
            await stop?.();
            await maintenance.query(`ALTER DATABASE ${identifier} ALLOW_CONNECTIONS true`);
          }
        });
      });

      await suite.test("HTTPS конфигурацијата издава Secure cookie", async () => {
        const httpsOrigin = baseURL.replace("http:", "https:");
        await restart({ AUTH_LOCAL_HTTP: "false", AUTH_BASE_URL: httpsOrigin });
        const response = await post(loginPath, credentials, { Origin: httpsOrigin });
        await expectSuccess(response);
        sessionCookie(response, true);
      });
    } finally {
      await stop?.();
    }
  });
});
