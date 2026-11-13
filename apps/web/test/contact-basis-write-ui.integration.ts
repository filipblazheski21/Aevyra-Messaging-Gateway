import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { applyMigrations } from "../../../packages/db/src/migrations.ts";
import { provisionAppRole } from "../../../packages/db/src/provision.ts";
import { verifyTestTarget, withTestDatabase } from "../../../packages/db/test/test-database.ts";
import { contactBasisOperationStorageKey } from "../src/contact-basis-write.ts";
import type { ContactBasisWriteRequest, PendingContactBasisOperation } from "../src/contact-basis-write.ts";
import { createCredentialUser } from "../src/server/create-credential-user.ts";
import { withBrowser } from "./browser-test.ts";
import type { BrowserDriver } from "./browser-test.ts";
import { reserveWebPort, startTestWeb } from "./test-web.ts";

const button = (label: string, twice = false) => `(() => {
  const scope = document.querySelector('[role=dialog]') ?? document;
  const item = [...scope.querySelectorAll('button')].find((candidate) => candidate.textContent.trim() === ${JSON.stringify(label)});
  if (!item) throw new Error('Недостасува копче: ${label}');
  item.click();
  ${twice ? "item.click();" : ""}
})()`;

const setSearch = (value: string) => `(() => {
  const input = document.querySelector('input[type="search"]');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.form.requestSubmit();
})()`;

const setInput = (label: string, value: string) => `(() => {
  const field = [...document.querySelectorAll('[role=dialog] label')]
    .find((item) => item.innerText.includes(${JSON.stringify(label)}))?.querySelector('input');
  if (!field) throw new Error('Недостасува поле: ${label}');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, ${JSON.stringify(value)});
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.dispatchEvent(new Event('change', { bubbles: true }));
})()`;

const setSelect = (label: string, value: string) => `(() => {
  const field = [...document.querySelectorAll('[role=dialog] label')]
    .find((item) => item.innerText.includes(${JSON.stringify(label)}))?.querySelector('select');
  if (!field) throw new Error('Недостасува избор: ${label}');
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(field, ${JSON.stringify(value)});
  field.dispatchEvent(new Event('change', { bubbles: true }));
})()`;

const installInspector = `(() => {
  const original = window.fetch;
  window.__basisWriteBodies = [];
  window.__basisPostMode = null;
  window.__basisPostStats = { aborted: false, bodyStarted: false };
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'POST' && url.pathname.endsWith('/basis')) {
      window.__basisWriteBodies.push(JSON.parse(String(init.body)));
      const mode = window.__basisPostMode;
      window.__basisPostMode = null;
      if (mode === 'lose-success') {
        const response = await original(input, init);
        await response.text();
        throw new TypeError('Симулиран изгубен одговор');
      }
      if (mode === 'temporary-503') {
        return Response.json({ code: 'TEMPORARILY_UNAVAILABLE', message: 'Синтетичка привремена недостапност.' }, { status: 503 });
      }
      if (mode === 'expired-session') {
        return Response.json({ code: 'AUTH_REQUIRED', message: 'Најавата е истечена.' }, { status: 401 });
      }
      if (mode === 'incomplete-2xx') {
        return Response.json({ outcome: 'APPENDED', event: { idempotencyKey: window.__basisWriteBodies.at(-1).idempotencyKey }, current: {} }, { status: 201 });
      }
      if (mode === 'hang-request') {
        const signal = init?.signal;
        return new Promise((resolve, reject) => {
          const abort = () => {
            window.__basisPostStats.aborted = true;
            reject(signal?.reason ?? new DOMException('Синтетички прекин.', 'AbortError'));
          };
          if (signal?.aborted) abort();
          else signal?.addEventListener('abort', abort, { once: true });
        });
      }
      if (mode === 'hang-body') {
        const signal = init?.signal;
        const response = await original(input, init);
        const body = await response.text();
        const bytes = new TextEncoder().encode(body);
        return new Response(new ReadableStream({
          start(controller) {
            window.__basisPostStats.bodyStarted = true;
            controller.enqueue(bytes);
            const abort = () => {
              window.__basisPostStats.aborted = true;
              controller.error(signal?.reason ?? new DOMException('Синтетички прекин на JSON.', 'AbortError'));
            };
            if (signal?.aborted) abort();
            else signal?.addEventListener('abort', abort, { once: true });
          },
        }), { status: response.status, headers: response.headers });
      }
    }
    return original(input, init);
  };
})()`;

async function openContact(browser: BrowserDriver, phone: string) {
  await browser.evaluate(setSearch(phone));
  await browser.waitFor(`document.body.innerText.includes(${JSON.stringify(phone)})`, `Контактот ${phone} да се прикаже.`);
  await browser.evaluate(`(() => {
    const row = [...document.querySelectorAll('li')].find((item) => item.innerText.includes(${JSON.stringify(phone)}));
    const open = [...row.querySelectorAll('button')].find((item) => item.textContent.trim() === 'Основа за контакт');
    open.click();
  })()`);
  await browser.waitFor("Boolean(document.querySelector('[role=dialog]'))", "Дијалогот да се отвори.");
  await browser.waitFor("Boolean(document.querySelector('[role=dialog] [data-contact-basis-state]'))", "Прочитаната состојба и контролите да се прикажат.");
}

async function closeDialog(browser: BrowserDriver) {
  await browser.evaluate(button("Затвори"));
  await browser.waitFor("!document.querySelector('[role=dialog]')", "Дијалогот да се затвори.");
}

async function prepareRecord(browser: BrowserDriver, reference: string, expiry = "") {
  await browser.evaluate(button("Евидентирај основа"));
  await browser.evaluate(setSelect("Вид на основа", "CONSENT"));
  await browser.evaluate(setInput("Референца на доказ", reference));
  if (expiry) await browser.evaluate(setInput("Рок на важност", expiry));
  await browser.evaluate(button("Прегледај"));
  await browser.waitFor("document.querySelector('[role=dialog]').innerText.includes('Преглед пред потврда')", "Прегледот да се прикаже.");
}

async function prepareWithdraw(browser: BrowserDriver, reference = "") {
  await browser.evaluate(button("Повлечи основа"));
  if (reference) await browser.evaluate(setInput("Референца (опционално)", reference));
  await browser.evaluate(button("Прегледај"));
  await browser.waitFor("document.querySelector('[role=dialog]').innerText.includes('Потврди повлекување')", "Прегледот за повлекување да се прикаже.");
}

async function eventCount(admin: { query: (text: string, values?: unknown[]) => Promise<{ rows: { count: number }[] }> }, contactId: string) {
  return (await admin.query("SELECT count(*)::int AS count FROM aevyra.contact_basis_events WHERE contact_id = $1", [contactId])).rows[0].count;
}

function lastSunday(year: number, month: number) {
  const date = new Date(Date.UTC(year, month, 0));
  date.setUTCDate(date.getUTCDate() - date.getUTCDay());
  return String(date.getUTCDate()).padStart(2, "0");
}

async function waitForLong(browser: BrowserDriver, expression: string, message: string, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await browser.evaluate<boolean>(expression)) return;
    await delay(100);
  }
  throw new Error(message);
}

test("евидентирање и повлекување основа преку интерфејс", { timeout: 480_000 }, async (suite) => {
  const requestedVisualDirectory = process.env.CONTACT_BASIS_WRITE_VISUAL_DIR;
  const visualDirectory = requestedVisualDirectory ? resolve(requestedVisualDirectory) : null;
  if (visualDirectory && !visualDirectory.startsWith(`${resolve(process.cwd())}${sep}`)) {
    throw new Error("Папката за снимки мора да биде во проектот.");
  }
  if (visualDirectory) await mkdir(visualDirectory, { recursive: false });

  await withTestDatabase(verifyTestTarget(), async (admin, databaseUrl, database) => {
    await applyMigrations(databaseUrl);
    const appUrl = new URL(databaseUrl);
    appUrl.username = database;
    appUrl.password = randomBytes(32).toString("base64url");
    await provisionAppRole(new URL(databaseUrl), appUrl);
    const port = await reserveWebPort();
    const baseURL = `http://127.0.0.1:${port}`;
    const secret = randomBytes(32).toString("base64url");
    const user = { name: "Синтетички оператор", email: "basis-write@example.test", password: randomBytes(24).toString("base64url") };
    const operatorId = await createCredentialUser(databaseUrl, { baseURL, secureCookies: false, secret }, user);
    const { rows: organizations } = await admin.query<{ id: string }>(`
      INSERT INTO aevyra.organizations (kind, name) VALUES ('CLINIC', 'Синтетичка клиника за запишување') RETURNING id
    `);
    const organizationId = organizations[0].id;
    const phones = Array.from({ length: 30 }, (_, index) => `+3897030${String(index + 1).padStart(4, "0")}`);
    const { rows: contacts } = await admin.query<{ id: string; normalized_phone: string }>(`
      INSERT INTO aevyra.contacts (organization_id, normalized_phone)
      SELECT $1::uuid, unnest($2::text[]) RETURNING id, normalized_phone
    `, [organizationId, phones]);
    const contactId = (phone: string) => contacts.find((item) => item.normalized_phone === phone)!.id;
    await admin.query(`
      INSERT INTO aevyra.contact_suppressions (organization_id, contact_id, operator_id, reason, reference)
      VALUES ($1, $2, $3, 'CONTACT_REQUEST', 'SYNTHETIC-SUPPRESSION')
    `, [organizationId, contactId(phones[1]), operatorId]);

    const stop = await startTestWeb(port, {
      DATABASE_URL: appUrl.href,
      AUTH_BASE_URL: baseURL,
      AUTH_LOCAL_HTTP: "true",
      AUTH_SECRET: secret,
      REAL_SENDING_ENABLED: "false",
    });
    try {
      await withBrowser(async (browser) => {
        await browser.setViewport(1280, 900);
        await browser.navigate(`${baseURL}/login`);
        const signIn = await browser.evaluate<number>(`fetch('/api/auth/sign-in/email', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(${JSON.stringify({ email: user.email, password: user.password })})
        }).then((response) => response.status)`);
        assert.equal(signIn, 200);
        await browser.navigate(`${baseURL}/app/organizations/${organizationId}`);
        await browser.waitFor("document.body.innerText.includes('Вкупно во организацијата: 30')", "Контактите да се вчитаат.");
        await browser.evaluate(installInspector);

        await suite.test("откажување пред потврда не испраќа POST", async () => {
          await openContact(browser, phones[0]);
          await browser.evaluate(button("Евидентирај основа"));
          await browser.evaluate(setSelect("Вид на основа", "CONSENT"));
          await browser.evaluate(setInput("Референца на доказ", "SYNTHETIC-CANCEL"));
          await browser.evaluate(button("Прегледај"));
          await browser.evaluate(button("Откажи"));
          assert.equal(await eventCount(admin, contactId(phones[0])), 0);
          assert.equal(await browser.evaluate<number>("window.__basisWriteBodies.length"), 0);
          await prepareWithdraw(browser, "SYNTHETIC-WITHDRAW-MISSING");
          await browser.evaluate(button("Потврди повлекување"));
          await browser.waitFor("document.querySelector('[role=dialog]').innerText.includes('Повлечена основа')", "Повлекувањето без позитивна основа да успее.");
          assert.equal(await eventCount(admin, contactId(phones[0])), 1);
          await closeDialog(browser);
          assert.equal(await browser.evaluate<string>("document.querySelector('input[type=search]').value"), phones[0]);
        });

        let oldRecordRequest: ContactBasisWriteRequest;
        await suite.test("RECORD, WITHDRAW, старо повторување и Не контактирај остануваат точни", async () => {
          await openContact(browser, phones[1]);
          assert.match(await browser.evaluate<string>("document.querySelector('[role=dialog]').innerText"), /Не контактирај/);
          await prepareRecord(browser, "SYNTHETIC-RECORD-OLD");
          await browser.evaluate(button("Потврди евидентирање"));
          await browser.waitFor("document.querySelector('[role=dialog]').innerText.includes('Операцијата е успешно запишана')", "RECORD да успее.");
          oldRecordRequest = await browser.evaluate<ContactBasisWriteRequest>("window.__basisWriteBodies.at(-1)");
          assert.equal(oldRecordRequest.expectedRevision, 0);
          assert.equal(Object.hasOwn(oldRecordRequest, "operatorId"), false);
          assert.equal(Object.hasOwn(oldRecordRequest, "organizationId"), false);
          assert.equal(Object.hasOwn(oldRecordRequest, "contactId"), false);
          assert.equal(await eventCount(admin, contactId(phones[1])), 1);
          assert.match(await browser.evaluate<string>("document.querySelector('[role=dialog]').innerText"), /Евидентирана основа[\s\S]*Не контактирај/);

          await prepareWithdraw(browser, "SYNTHETIC-WITHDRAW");
          await browser.evaluate(button("Потврди повлекување"));
          await browser.waitFor("document.querySelector('[role=dialog]').innerText.includes('Повлечена основа')", "WITHDRAW да стане тековен.");
          const withdrawal = await browser.evaluate<ContactBasisWriteRequest>("window.__basisWriteBodies.at(-1)");
          assert.equal(withdrawal.eventType, "WITHDRAW");
          assert.equal(withdrawal.expectedRevision, 1);
          assert.equal(Object.hasOwn(withdrawal, "basisType"), false);
          assert.equal(Object.hasOwn(withdrawal, "expiresAt"), false);
          assert.equal(await eventCount(admin, contactId(phones[1])), 2);

          const operation: PendingContactBasisOperation = {
            version: 1, operatorId, organizationId, contactId: contactId(phones[1]),
            purpose: "PATIENT_INFORMATION", channel: "SMS", createdAt: new Date().toISOString(), request: oldRecordRequest,
          };
          const storageKey = contactBasisOperationStorageKey(operation);
          await browser.evaluate(`sessionStorage.setItem(${JSON.stringify(storageKey)}, ${JSON.stringify(JSON.stringify(operation))})`);
          await closeDialog(browser);
          await openContact(browser, phones[1]);
          await browser.waitFor("document.querySelector('[role=dialog]').innerText.includes('Непотврдена операција')", "Старото повторување да се обнови.");
          await browser.evaluate(button("Повтори ја истата операција"));
          await browser.waitFor("document.querySelector('[role=dialog]').innerText.includes('Повлечена основа')", "Тековната состојба да остане повлечена.");
          const text = await browser.evaluate<string>("document.querySelector('[role=dialog]').innerText");
          assert.match(text, /Повлечена основа/);
          assert.match(text, /Не контактирај/);
          assert.equal(await eventCount(admin, contactId(phones[1])), 2);
          if (visualDirectory) await writeFile(join(visualDirectory, "contact-basis-write-wide.png"), await browser.captureScreenshot());
          await closeDialog(browser);
        });

        await suite.test("двоен клик создава точно еден настан", async () => {
          await openContact(browser, phones[2]);
          await prepareRecord(browser, "SYNTHETIC-DOUBLE-CLICK");
          await browser.evaluate(button("Потврди евидентирање", true));
          await browser.waitFor("document.querySelector('[role=dialog]').innerText.includes('Евидентирана основа')", "Записот да успее.");
          assert.equal(await eventCount(admin, contactId(phones[2])), 1);
          await closeDialog(browser);
        });

        await suite.test("изгубен одговор и освежување повторуваат исто тело и даваат еден настан", async () => {
          await openContact(browser, phones[3]);
          await prepareRecord(browser, "SYNTHETIC-LOST-RESPONSE");
          await browser.evaluate("window.__basisPostMode = 'lose-success'");
          await browser.evaluate(button("Потврди евидентирање"));
          await browser.waitFor("document.querySelector('[role=dialog]').innerText.includes('Исходот е неизвесен')", "Неизвесноста да се прикаже.");
          const original = await browser.evaluate<ContactBasisWriteRequest>("window.__basisWriteBodies.at(-1)");
          assert.equal(await eventCount(admin, contactId(phones[3])), 1);
          await browser.evaluate(setSelect("Канал", "VIBER"));
          await browser.waitFor("document.querySelector('[role=dialog]').innerText.includes('Нема евидентирана основа')", "Viber состојбата да се прочита одделно.");
          assert.equal(await browser.evaluate<boolean>("document.querySelector('[role=dialog]').innerText.includes('Непотврдена операција')"), false);
          await browser.evaluate(setSelect("Канал", "SMS"));
          await browser.waitFor("document.querySelector('[role=dialog]').innerText.includes('Непотврдена операција')", "SMS операцијата повторно да се прикаже.");
          await browser.navigate(`${baseURL}/app/organizations/${organizationId}`);
          await browser.waitFor("document.body.innerText.includes('Вкупно во организацијата: 30')", "Страницата повторно да се вчита.");
          await browser.evaluate(installInspector);
          await openContact(browser, phones[3]);
          await browser.waitFor("document.querySelector('[role=dialog]').innerText.includes('Непотврдена операција')", "Операцијата да се обнови по refresh.");
          await browser.evaluate("window.__basisPostMode = 'temporary-503'");
          await browser.evaluate(button("Повтори ја истата операција"));
          await browser.waitFor("window.__basisWriteBodies.length === 1 && document.querySelector('[role=dialog]').innerText.includes('Непотврдена операција')", "503 да го задржи recovery контекстот.");
          const after503 = await browser.evaluate<ContactBasisWriteRequest>("window.__basisWriteBodies.at(-1)");
          assert.deepEqual(after503, original);
          const recoveryKey = contactBasisOperationStorageKey({
            operatorId, organizationId, contactId: contactId(phones[3]), purpose: "PATIENT_INFORMATION", channel: "SMS",
          });
          assert.equal(await browser.evaluate<string>(`JSON.parse(sessionStorage.getItem(${JSON.stringify(recoveryKey)})).request.idempotencyKey`), original.idempotencyKey);
          await browser.evaluate(button("Повтори ја истата операција"));
          await browser.waitFor("document.querySelector('[role=dialog]').innerText.includes('без нов дупликат')", "Повторувањето да се потврди.");
          const repeated = await browser.evaluate<ContactBasisWriteRequest[]>("window.__basisWriteBodies");
          assert.equal(repeated.length, 2);
          assert.deepEqual(repeated, [original, original]);
          assert.equal(await browser.evaluate<string | null>(`sessionStorage.getItem(${JSON.stringify(recoveryKey)})`), null);
          assert.equal(await eventCount(admin, contactId(phones[3])), 1);
          await closeDialog(browser);
        });

        await suite.test("истечена сесија при повторување го задржува истиот клуч", async () => {
          await browser.evaluate("window.__basisWriteBodies = []");
          await openContact(browser, phones[8]);
          await prepareRecord(browser, "SYNTHETIC-EXPIRED-SESSION");
          await browser.evaluate("window.__basisPostMode = 'lose-success'");
          await browser.evaluate(button("Потврди евидентирање"));
          await browser.waitFor("document.querySelector('[role=dialog]').innerText.includes('Непотврдена операција') && document.querySelector('[role=dialog]').innerText.includes('Повтори ја истата операција')", "Изгубениот одговор да остави recovery контекст.");
          const original = await browser.evaluate<ContactBasisWriteRequest>("window.__basisWriteBodies.at(-1)");
          await browser.evaluate("window.__basisPostMode = 'expired-session'");
          await browser.evaluate(button("Повтори ја истата операција"));
          await browser.waitFor("window.__basisWriteBodies.length === 2 && document.querySelector('[role=dialog]').innerText.includes('Непотврдена операција')", "401 да го задржи recovery контекстот.");
          const attempts = await browser.evaluate<ContactBasisWriteRequest[]>("window.__basisWriteBodies");
          assert.deepEqual(attempts, [original, original]);
          const key = contactBasisOperationStorageKey({
            operatorId, organizationId, contactId: contactId(phones[8]), purpose: "PATIENT_INFORMATION", channel: "SMS",
          });
          assert.equal(await browser.evaluate<string>(`JSON.parse(sessionStorage.getItem(${JSON.stringify(key)})).request.idempotencyKey`), original.idempotencyKey);
          await browser.evaluate(button("Повтори ја истата операција"));
          await browser.waitFor("document.querySelector('[role=dialog]').innerText.includes('без нов дупликат')", "Повторувањето по обновена сесија да успее.");
          assert.equal(await eventCount(admin, contactId(phones[8])), 1);
          await closeDialog(browser);
        });

        await suite.test("непотполн 2xx не прикажува успех и не го брише контекстот", async () => {
          await browser.evaluate("window.__basisWriteBodies = []");
          await openContact(browser, phones[9]);
          await prepareRecord(browser, "SYNTHETIC-INCOMPLETE-2XX");
          await browser.evaluate("window.__basisPostMode = 'incomplete-2xx'");
          await browser.evaluate(button("Потврди евидентирање"));
          await browser.waitFor("document.querySelector('[role=dialog]').innerText.includes('Непотврдена операција')", "Непотполниот 2xx да остане неизвесен.");
          const text = await browser.evaluate<string>("document.querySelector('[role=dialog]').innerText");
          assert.doesNotMatch(text, /Операцијата е успешно запишана|без нов дупликат/);
          const original = await browser.evaluate<ContactBasisWriteRequest>("window.__basisWriteBodies.at(-1)");
          const key = contactBasisOperationStorageKey({
            operatorId, organizationId, contactId: contactId(phones[9]), purpose: "PATIENT_INFORMATION", channel: "SMS",
          });
          assert.equal(await browser.evaluate<string>(`JSON.parse(sessionStorage.getItem(${JSON.stringify(key)})).request.idempotencyKey`), original.idempotencyKey);
          assert.equal(await eventCount(admin, contactId(phones[9])), 0);
          await browser.evaluate(button("Повтори ја истата операција"));
          await browser.waitFor("document.querySelector('[role=dialog]').innerText.includes('Операцијата е успешно запишана')", "Рачното повторување да успее.");
          assert.equal(await eventCount(admin, contactId(phones[9])), 1);
          await closeDialog(browser);
        });

        await suite.test("оштетен и недостапен storage блокираат нов POST", async () => {
          await browser.evaluate("window.__basisWriteBodies = []");
          const corruptKey = contactBasisOperationStorageKey({
            operatorId, organizationId, contactId: contactId(phones[10]), purpose: "PATIENT_INFORMATION", channel: "SMS",
          });
          await browser.evaluate(`sessionStorage.setItem(${JSON.stringify(corruptKey)}, '{invalid-json')`);
          await openContact(browser, phones[10]);
          await browser.waitFor("document.querySelector('[role=dialog]').innerText.includes('Нова операција во овој опсег е блокирана')", "Оштетениот контекст да го блокира записот.");
          assert.equal(await browser.evaluate<boolean>("document.querySelector('[role=dialog]').innerText.includes('Евидентирај основа')"), false);
          assert.equal(await browser.evaluate<string>(`sessionStorage.getItem(${JSON.stringify(corruptKey)})`), "{invalid-json");
          assert.equal(await browser.evaluate<number>("window.__basisWriteBodies.length"), 0);
          await closeDialog(browser);

          await browser.evaluate(`(() => {
            window.__originalStorageGetItem = Storage.prototype.getItem;
            Storage.prototype.getItem = function () { throw new Error('blocked storage'); };
          })()`);
          await openContact(browser, phones[11]);
          await browser.waitFor("document.querySelector('[role=dialog]').innerText.includes('Нова операција во овој опсег е блокирана')", "Недостапниот storage да го блокира записот.");
          await browser.evaluate("Storage.prototype.getItem = window.__originalStorageGetItem");
          assert.equal(await browser.evaluate<boolean>("document.querySelector('[role=dialog]').innerText.includes('Евидентирај основа')"), false);
          assert.equal(await browser.evaluate<number>("window.__basisWriteBodies.length"), 0);
          await closeDialog(browser);
        });

        await suite.test("POST timeout го опфаќа барањето и заглавеното JSON тело без автоматски втор POST", async (context) => {
          await browser.evaluate("window.__basisWriteBodies = []; window.__basisPostStats = { aborted: false, bodyStarted: false }");
          await openContact(browser, phones[12]);
          await prepareRecord(browser, "SYNTHETIC-HANG-REQUEST");
          await browser.evaluate("window.__basisPostMode = 'hang-request'");
          const requestStarted = Date.now();
          await browser.evaluate(button("Потврди евидентирање"));
          await waitForLong(browser, "window.__basisPostStats.aborted === true && [...document.querySelectorAll('[role=dialog] button')].some((item) => item.textContent.trim() === 'Повтори ја истата операција')", "Заглавениот POST да се прекине.");
          const requestElapsed = Date.now() - requestStarted;
          assert.ok(requestElapsed >= 19_500 && requestElapsed < 24_000, `POST timeout: ${requestElapsed} ms`);
          assert.equal(await browser.evaluate<number>("window.__basisWriteBodies.length"), 1);
          assert.equal(await eventCount(admin, contactId(phones[12])), 0);
          await closeDialog(browser);

          await browser.evaluate("window.__basisWriteBodies = []; window.__basisPostStats = { aborted: false, bodyStarted: false }");
          await openContact(browser, phones[13]);
          await prepareRecord(browser, "SYNTHETIC-HANG-BODY");
          await browser.evaluate("window.__basisPostMode = 'hang-body'");
          const bodyStarted = Date.now();
          await browser.evaluate(button("Потврди евидентирање"));
          await waitForLong(browser, "window.__basisPostStats.bodyStarted === true && window.__basisPostStats.aborted === true && [...document.querySelectorAll('[role=dialog] button')].some((item) => item.textContent.trim() === 'Повтори ја истата операција')", "Заглавеното JSON тело да се прекине.");
          const bodyElapsed = Date.now() - bodyStarted;
          assert.ok(bodyElapsed >= 19_500 && bodyElapsed < 24_000, `POST body timeout: ${bodyElapsed} ms`);
          assert.equal(await browser.evaluate<number>("window.__basisWriteBodies.length"), 1);
          assert.equal(await eventCount(admin, contactId(phones[13])), 1);
          context.diagnostic(`POST timeout ${requestElapsed} ms; JSON body timeout ${bodyElapsed} ms.`);
          await closeDialog(browser);
        });

        await suite.test("конфликт на ревизија освежува без автоматски POST", async () => {
          await browser.evaluate("window.__basisWriteBodies = []");
          await openContact(browser, phones[4]);
          await prepareRecord(browser, "SYNTHETIC-STALE-REVISION");
          await admin.query(`
            INSERT INTO aevyra.contact_basis_events (
              organization_id, contact_id, purpose, channel, event_type, operator_id, revision,
              idempotency_key, request_fingerprint, basis_type, reference
            ) VALUES ($1, $2, 'PATIENT_INFORMATION', 'SMS', 'RECORD', $3, 1, $4, $5, 'DOCUMENTED_BASIS', 'SYNTHETIC-CONCURRENT')
          `, [organizationId, contactId(phones[4]), operatorId, randomUUID(), randomBytes(32).toString("hex")]);
          await browser.evaluate(button("Потврди евидентирање"));
          await browser.waitFor("document.querySelector('[role=dialog]').innerText.includes('Состојбата е изменета')", "Конфликтот да се прикаже.");
          await browser.waitFor("document.querySelector('[role=dialog]').innerText.includes('SYNTHETIC-CONCURRENT')", "Состојбата да се освежи.");
          assert.equal(await browser.evaluate<number>("window.__basisWriteBodies.length"), 1);
          assert.equal(await eventCount(admin, contactId(phones[4])), 1);
          await closeDialog(browser);
        });

        await suite.test("зимски и летен рок и DST невалидни времиња", async () => {
          const year = new Date().getUTCFullYear() + 1;
          const winter = `${year}-01-15T12:30`;
          const summer = `${year}-07-15T12:30`;
          await openContact(browser, phones[5]);
          await prepareRecord(browser, "SYNTHETIC-WINTER", winter);
          await browser.evaluate(button("Потврди евидентирање"));
          await browser.waitFor("document.querySelector('[role=dialog]').innerText.includes('Евидентирана основа')", "Зимскиот рок да се запише.");
          await closeDialog(browser);
          await openContact(browser, phones[6]);
          await prepareRecord(browser, "SYNTHETIC-SUMMER", summer);
          await browser.evaluate(button("Потврди евидентирање"));
          await browser.waitFor("document.querySelector('[role=dialog]').innerText.includes('Евидентирана основа')", "Летниот рок да се запише.");
          const expiries = await admin.query<{ normalized_phone: string; expires_epoch: number }>(`
            SELECT c.normalized_phone, extract(epoch FROM e.expires_at)::float8 AS expires_epoch
            FROM aevyra.contact_basis_events e JOIN aevyra.contacts c ON c.id = e.contact_id
            WHERE c.normalized_phone = ANY($1::text[]) ORDER BY c.normalized_phone
          `, [[phones[5], phones[6]]]);
          assert.equal(new Date(expiries.rows[0].expires_epoch * 1000).toISOString(), `${year}-01-15T11:30:00.000Z`);
          assert.equal(new Date(expiries.rows[1].expires_epoch * 1000).toISOString(), `${year}-07-15T10:30:00.000Z`);
          await closeDialog(browser);

          await openContact(browser, phones[7]);
          await browser.evaluate(button("Евидентирај основа"));
          await browser.evaluate(setSelect("Вид на основа", "CONSENT"));
          await browser.evaluate(setInput("Референца на доказ", "SYNTHETIC-DST"));
          await browser.evaluate(setInput("Рок на важност", `${year}-03-${lastSunday(year, 3)}T02:30`));
          await browser.evaluate(button("Прегледај"));
          await browser.waitFor("document.querySelector('[role=dialog]').innerText.includes('не постои поради промената')", "Непостоечкото време да се одбие.");
          await browser.evaluate(setInput("Рок на важност", `${year}-10-${lastSunday(year, 10)}T02:30`));
          await browser.evaluate(button("Прегледај"));
          await browser.waitFor("document.querySelector('[role=dialog]').innerText.includes('двосмислено')", "Двосмисленото време да се одбие.");
          assert.equal(await eventCount(admin, contactId(phones[7])), 0);
          await closeDialog(browser);
        });

        await suite.test("опсегот, пребарувањето, страницата и тесниот приказ се зачувани", async () => {
          await browser.evaluate(setSearch(""));
          await browser.waitFor("document.body.innerText.includes('Следна')", "Пагинацијата да се прикаже.");
          await browser.evaluate(`(() => [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === 'Следна').click())()`);
          await browser.waitFor("document.body.innerText.includes('Страница 2')", "Втората страница да се прикаже.");
          await browser.evaluate(`(() => {
            const open = [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === 'Основа за контакт');
            open.click();
          })()`);
          await browser.waitFor("Boolean(document.querySelector('[role=dialog]'))", "Дијалогот да се отвори на втората страница.");
          await browser.waitFor("Boolean(document.querySelector('[role=dialog] [data-contact-basis-state]'))", "Прочитаната состојба да се прикаже на втората страница.");
          await browser.setViewport(375, 820);
          await browser.evaluate(button("Евидентирај основа"));
          const layout = await browser.evaluate<{ clientWidth: number; scrollWidth: number; text: string }>(`({
            clientWidth: document.documentElement.clientWidth,
            scrollWidth: document.documentElement.scrollWidth,
            text: document.querySelector('[role=dialog]').innerText,
          })`);
          assert.equal(layout.scrollWidth, layout.clientWidth);
          assert.match(layout.text, /Евидентирај основа/);
          if (visualDirectory) await writeFile(join(visualDirectory, "contact-basis-write-narrow.png"), await browser.captureScreenshot());
          await browser.evaluate(button("Затвори"));
          await browser.waitFor("document.body.innerText.includes('Страница 2')", "Страницата да остане зачувана.");
          assert.equal(await browser.evaluate<string>("document.querySelector('input[type=search]').value"), "");
          await browser.setViewport(1280, 900);
        });
      });
    } finally {
      await stop();
    }
  });
});
