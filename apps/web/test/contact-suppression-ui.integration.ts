import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { applyMigrations } from "../../../packages/db/src/migrations.ts";
import { provisionAppRole } from "../../../packages/db/src/provision.ts";
import { verifyTestTarget, withTestDatabase } from "../../../packages/db/test/test-database.ts";
import { createCredentialUser } from "../src/server/create-credential-user.ts";
import { withBrowser } from "./browser-test.ts";
import type { BrowserDriver } from "./browser-test.ts";
import { reserveWebPort, startTestWeb } from "./test-web.ts";

const clickButton = (label: string, index = 0) => `(() => {
  const buttons = [...document.querySelectorAll('button')].filter((item) => item.textContent.trim() === ${JSON.stringify(label)});
  if (!buttons[${index}]) throw new Error('Недостасува копче: ${label}');
  buttons[${index}].click();
})()`;

const setSearch = (value: string) => `(() => {
  const input = document.querySelector('input[type="search"]');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, ${JSON.stringify(value)});
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.form.requestSubmit();
})()`;

const labelForPhone = (phone: string) => `(() => {
  const row = [...document.querySelectorAll('li')].find((item) => item.innerText.includes(${JSON.stringify(phone)}));
  return row?.innerText ?? '';
})()`;

const hideNextSuppressionResponse = `(() => {
  const original = window.fetch;
  window.__aevyraOriginalFetch = original;
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    const response = await original(input, init);
    if ((init?.method ?? 'GET').toUpperCase() === 'POST' && url.pathname.endsWith('/suppression')) {
      await response.arrayBuffer();
      throw new TypeError('Синтетички изгубен одговор по COMMIT.');
    }
    return response;
  };
})()`;

const holdNextSuppressionResponse = (method: "GET" | "POST") => `(() => {
  const original = window.fetch;
  window.__aevyraOriginalFetch = original;
  window.__aevyraHoldStats = { requests: 0, hasAbortSignal: false, aborted: false };
  let held = false;
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (!held && (init?.method ?? 'GET').toUpperCase() === ${JSON.stringify(method)}
        && url.pathname.endsWith('/suppression')) {
      held = true;
      const signal = init?.signal;
      window.__aevyraHoldStats.requests++;
      window.__aevyraHoldStats.hasAbortSignal = signal instanceof AbortSignal;
      signal?.addEventListener('abort', () => {
        window.__aevyraHoldStats.aborted = true;
      }, { once: true });
      const response = await original(input, init);
      return new Promise((resolve, reject) => {
        if (!signal) return;
        const abort = () => {
          window.__aevyraHoldStats.aborted = true;
          response.body?.cancel().catch(() => {});
          reject(signal.reason ?? new DOMException('Прекинато тест-барање.', 'AbortError'));
        };
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      });
    }
    return original(input, init);
  };
})()`;

const holdNextSuppressionBody = `(() => {
  const original = window.fetch;
  window.__aevyraOriginalFetch = original;
  window.__aevyraHoldStats = { requests: 0, hasAbortSignal: false, aborted: false, bodyStarted: false };
  let held = false;
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    const response = await original(input, init);
    if (!held && (init?.method ?? 'GET').toUpperCase() === 'GET'
        && url.pathname.endsWith('/suppression')) {
      held = true;
      const signal = init?.signal;
      const bytes = new TextEncoder().encode(await response.text());
      window.__aevyraHoldStats.requests++;
      window.__aevyraHoldStats.hasAbortSignal = signal instanceof AbortSignal;
      const stream = new ReadableStream({
        start(controller) {
          window.__aevyraHoldStats.bodyStarted = true;
          controller.enqueue(bytes);
          const abort = () => {
            window.__aevyraHoldStats.aborted = true;
            controller.error(signal?.reason ?? new DOMException('Прекинато тест-тело.', 'AbortError'));
          };
          if (signal?.aborted) abort();
          else signal?.addEventListener('abort', abort, { once: true });
        },
      });
      return new Response(stream, { status: response.status, headers: response.headers });
    }
    return response;
  };
})()`;

const holdNextContactsResponse = `(() => {
  const original = window.fetch;
  window.__aevyraOriginalFetch = original;
  let release;
  let held = false;
  window.__releaseStaleContacts = () => release?.();
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    const response = await original(input, init);
    if (!held && (init?.method ?? 'GET').toUpperCase() === 'GET'
        && url.pathname.endsWith('/contacts')) {
      held = true;
      const body = await response.json();
      body.items = body.items.map((item) => ({ ...item, hasSuppression: false }));
      return new Promise((resolve) => {
        release = () => resolve(new Response(JSON.stringify(body), {
          status: response.status,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
        }));
      });
    }
    return response;
  };
})()`;

const restoreFetch = `(() => {
  if (window.__aevyraOriginalFetch) {
    window.fetch = window.__aevyraOriginalFetch;
    delete window.__aevyraOriginalFetch;
  }
})()`;

const heldStats = "window.__aevyraHoldStats";

async function openContact(browser: BrowserDriver, index = 0) {
  await browser.evaluate(clickButton("Отвори контакт", index));
  await browser.waitFor("document.querySelector('[role=dialog]') && document.body.innerText.includes('Евидентирај „Не контактирај“')", "Деталите за контактот не се отворија.");
}

async function confirmSuppression(browser: BrowserDriver) {
  await browser.evaluate(clickButton("Евидентирај „Не контактирај“"));
  await browser.waitFor("document.body.innerText.includes('Потврда за ограничување')", "Не се отвори потврдата.");
  await browser.evaluate(clickButton("Потврди ограничување"));
}

test("Кориснички тек за „Не контактирај“", { timeout: 180_000 }, async (suite) => {
  const requestedVisualDirectory = process.env.CONTACT_SUPPRESSION_VISUAL_DIR;
  const visualDirectory = requestedVisualDirectory ? resolve(requestedVisualDirectory) : null;
  if (visualDirectory && !visualDirectory.startsWith(`${resolve(process.cwd())}${sep}`)) {
    throw new Error("Папката за визуелна проверка мора да биде во проектот.");
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
    const user = { name: "Синтетички оператор", email: "suppression-ui@example.test", password: randomBytes(24).toString("base64url") };
    await createCredentialUser(databaseUrl, { baseURL, secureCookies: false, secret }, user);
    const { rows: [organization] } = await admin.query<{ id: string }>(`
      INSERT INTO aevyra.organizations (kind, name) VALUES ('CLINIC', 'Клиника за UI проверка') RETURNING id
    `);
    const { rows: contacts } = await admin.query<{ id: string; normalized_phone: string }>(`
      INSERT INTO aevyra.contacts (organization_id, normalized_phone)
      SELECT $1, '+38970' || lpad(n::text, 6, '0') FROM generate_series(1, 30) AS n
      RETURNING id, normalized_phone
    `, [organization.id]);
    const byPhone = new Map(contacts.map((item) => [item.normalized_phone, item.id]));
    const count = async (contactId?: string) => Number((await admin.query(
      `SELECT count(*)::int AS count FROM aevyra.contact_suppressions${contactId ? " WHERE contact_id = $1" : ""}`,
      contactId ? [contactId] : [],
    )).rows[0].count);

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
        const status = await browser.evaluate<number>(`fetch('/api/auth/sign-in/email', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(${JSON.stringify({ email: user.email, password: user.password })})
        }).then((response) => response.status)`);
        assert.equal(status, 200);
        await browser.navigate(`${baseURL}/app/organizations/${organization.id}`);
        await browser.waitFor("document.body.innerText.includes('Вкупно во организацијата: 30')", "Контактите не се вчитаа.");
        await browser.evaluate(setSearch("+38970"));
        await browser.waitFor("document.body.innerText.includes('Совпаднати резултати: 30')", "Пребарувањето не се примени.");

        await suite.test("Откажувањето не создава запис", async () => {
          await openContact(browser, 0);
          const phone = await browser.evaluate<string>("document.querySelector('[role=dialog] h2').textContent");
          await browser.evaluate(clickButton("Евидентирај „Не контактирај“"));
          await browser.evaluate(clickButton("Откажи"));
          await browser.evaluate(clickButton("Затвори"));
          assert.equal(await count(byPhone.get(phone)), 0);
        });

        await suite.test("Потврдата на втора страница ја освежува ознаката без губење контекст", async () => {
          await browser.evaluate(clickButton("Следна"));
          await browser.waitFor("document.body.innerText.includes('Страница 2')", "Втората страница не се отвори.");
          await openContact(browser, 0);
          const phone = await browser.evaluate<string>("document.querySelector('[role=dialog] h2').textContent");
          await browser.evaluate(`(() => {
            const input = document.querySelector('[role=dialog] input');
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
            setter.call(input, 'Синтетичка референца <не е врска>');
            input.dispatchEvent(new Event('input', { bubbles: true }));
          })()`);
          await confirmSuppression(browser);
          await browser.waitFor("document.body.innerText.includes('Ограничувањето е евидентирано')", "Ограничувањето не се потврди.");
          const details = await browser.evaluate<{ text: string; links: number }>(`({
            text: document.querySelector('[role=dialog]').innerText,
            links: document.querySelectorAll('[role=dialog] a').length,
          })`);
          assert.match(details.text, /Синтетичка референца <не е врска>/);
          assert.equal(details.links, 0, "Референцата не смее да стане активна врска.");
          if (visualDirectory) await writeFile(join(visualDirectory, "contact-suppression-desktop.png"), await browser.captureScreenshot());
          await browser.evaluate(clickButton("Затвори"));
          const state = await browser.evaluate<{ search: string; text: string }>(`({
            search: document.querySelector('input[type="search"]').value,
            text: document.querySelector('#saved-contacts-title').closest('section').innerText,
          })`);
          assert.equal(state.search, "+38970");
          assert.match(state.text, /Страница 2/);
          assert.match(await browser.evaluate<string>(labelForPhone(phone)), /Не контактирај/);
          assert.equal(await count(byPhone.get(phone)), 1);
        });

        await suite.test("Заглавен POST завршува со неизвесен исход и точно еден запис", async (context) => {
          await openContact(browser, 1);
          const phone = await browser.evaluate<string>("document.querySelector('[role=dialog] h2').textContent");
          await browser.evaluate(holdNextSuppressionResponse("POST"));
          const startedAt = Date.now();
          await confirmSuppression(browser);
          await delay(500);
          const pending = await browser.evaluate<{ hasAbortSignal: boolean; requests: number; closeDisabled: boolean }>(`({
            hasAbortSignal: ${heldStats}.hasAbortSignal,
            requests: ${heldStats}.requests,
            closeDisabled: [...document.querySelectorAll('[role=dialog] button')]
              .find((item) => item.textContent.trim() === 'Затвори').disabled,
          })`);
          assert.deepEqual(pending, { hasAbortSignal: true, requests: 1, closeDisabled: true });
          await delay(20_000);
          await browser.waitFor(
            "document.querySelector('[role=dialog]').innerText.includes('Чекањето на одговорот истече')",
            "Заглавениот POST не заврши со неизвесен исход.",
          );
          const elapsedMs = Date.now() - startedAt;
          const released = await browser.evaluate<{ aborted: boolean; closeDisabled: boolean; checkDisabled: boolean; confirmButtons: number }>(`({
            aborted: ${heldStats}.aborted,
            closeDisabled: [...document.querySelectorAll('[role=dialog] button')]
              .find((item) => item.textContent.trim() === 'Затвори').disabled,
            checkDisabled: [...document.querySelectorAll('[role=dialog] button')]
              .find((item) => item.textContent.trim() === 'Провери исход').disabled,
            confirmButtons: [...document.querySelectorAll('[role=dialog] button')]
              .filter((item) => item.textContent.trim() === 'Потврди ограничување').length,
          })`);
          assert.deepEqual(released, { aborted: true, closeDisabled: false, checkDisabled: false, confirmButtons: 0 });
          assert.ok(elapsedMs >= 19_500 && elapsedMs < 23_000, `POST рокот заврши за ${elapsedMs} ms.`);
          assert.equal(await count(byPhone.get(phone)), 1);
          if (visualDirectory) await writeFile(join(visualDirectory, "contact-suppression-timeout-desktop.png"), await browser.captureScreenshot());
          await browser.evaluate(restoreFetch);
          await browser.evaluate(clickButton("Провери исход"));
          await browser.waitFor("document.body.innerText.includes('Исходот е потврден од серверот')", "Проверката не го разреши исходот.");
          await browser.evaluate(clickButton("Затвори"));
          assert.match(await browser.evaluate<string>(labelForPhone(phone)), /Не контактирај/);
          assert.equal(await count(byPhone.get(phone)), 1);
          context.diagnostic(`POST беше прекинат по ${elapsedMs} ms; GET го најде оригиналниот единствен запис.`);
        });

        await suite.test("Заглавено почетно GET читање не прикажува лажно отсуство", async (context) => {
          await browser.evaluate(holdNextSuppressionResponse("GET"));
          const startedAt = Date.now();
          await browser.evaluate(clickButton("Отвори контакт", 2));
          await browser.waitFor("document.querySelector('[role=dialog]')?.innerText.includes('Се чита евиденцијата')", "Почетното читање не започна.");
          await delay(10_000);
          await browser.waitFor(
            "document.querySelector('[role=dialog]')?.innerText.includes('Читањето траеше предолго')",
            "Заглавеното GET читање не заврши со грешка.",
          );
          const elapsedMs = Date.now() - startedAt;
          const state = await browser.evaluate<{ text: string; hasRetry: boolean; canRecord: boolean; stats: { hasAbortSignal: boolean; aborted: boolean } }>(`(() => {
            const dialog = document.querySelector('[role=dialog]');
            return {
              text: dialog.innerText,
              hasRetry: [...dialog.querySelectorAll('button')].some((item) => item.textContent.trim() === 'Обиди се повторно'),
              canRecord: [...dialog.querySelectorAll('button')].some((item) => item.textContent.includes('Евидентирај')),
              stats: { hasAbortSignal: ${heldStats}.hasAbortSignal, aborted: ${heldStats}.aborted },
            };
          })()`);
          assert.equal(state.hasRetry, true);
          assert.equal(state.canRecord, false);
          assert.doesNotMatch(state.text, /Нема евидентирано ограничување/);
          assert.deepEqual(state.stats, { hasAbortSignal: true, aborted: true });
          assert.ok(elapsedMs >= 9_500 && elapsedMs < 13_000, `GET рокот заврши за ${elapsedMs} ms.`);
          await browser.setViewport(375, 820);
          const mobile = await browser.evaluate<{ clientWidth: number; scrollWidth: number }>(`({
            clientWidth: document.documentElement.clientWidth,
            scrollWidth: document.documentElement.scrollWidth,
          })`);
          assert.equal(mobile.scrollWidth, mobile.clientWidth);
          if (visualDirectory) await writeFile(join(visualDirectory, "contact-suppression-timeout-mobile.png"), await browser.captureScreenshot());
          await browser.setViewport(1280, 900);
          await browser.evaluate(restoreFetch);
          await browser.evaluate(clickButton("Обиди се повторно"));
          await browser.waitFor("document.querySelector('[role=dialog]')?.innerText.includes('Евидентирај „Не контактирај“')", "Повтореното читање не успеа.");
          await browser.evaluate(clickButton("Затвори"));
          context.diagnostic(`Почетното GET читање беше прекинато по ${elapsedMs} ms без лажно отсуство.`);
        });

        await suite.test("Заглавена проверка го задржува неизвесниот контекст", async () => {
          await openContact(browser, 3);
          const phone = await browser.evaluate<string>("document.querySelector('[role=dialog] h2').textContent");
          await browser.evaluate(hideNextSuppressionResponse);
          await confirmSuppression(browser);
          await browser.waitFor("document.querySelector('[role=dialog]').innerText.includes('Исходот не е потврден')", "Не се создаде неизвесен исход.");
          await browser.evaluate(restoreFetch);
          await browser.evaluate(holdNextSuppressionResponse("GET"));
          await browser.evaluate(clickButton("Провери исход"));
          await delay(10_000);
          await browser.waitFor(
            "document.querySelector('[role=dialog]').innerText.includes('Читањето траеше предолго')",
            "Заглавената проверка не заврши.",
          );
          const state = await browser.evaluate<{ text: string; closeDisabled: boolean; checkDisabled: boolean; aborted: boolean }>(`(() => {
            const dialog = document.querySelector('[role=dialog]');
            return {
              text: dialog.innerText,
              closeDisabled: [...dialog.querySelectorAll('button')].find((item) => item.textContent.trim() === 'Затвори').disabled,
              checkDisabled: [...dialog.querySelectorAll('button')].find((item) => item.textContent.trim() === 'Провери исход').disabled,
              aborted: ${heldStats}.aborted,
            };
          })()`);
          assert.match(state.text, /Исходот не е потврден/);
          assert.deepEqual({ closeDisabled: state.closeDisabled, checkDisabled: state.checkDisabled, aborted: state.aborted }, {
            closeDisabled: false, checkDisabled: false, aborted: true,
          });
          await browser.evaluate(restoreFetch);
          await browser.evaluate(clickButton("Провери исход"));
          await browser.waitFor("document.querySelector('[role=dialog]').innerText.includes('Исходот е потврден од серверот')", "Следната проверка не го разреши исходот.");
          await browser.evaluate(clickButton("Затвори"));
          assert.equal(await count(byPhone.get(phone)), 1);
        });

        await suite.test("GET рокот го опфаќа и недовршеното тело", async () => {
          await browser.evaluate(holdNextSuppressionBody);
          await browser.evaluate(clickButton("Отвори контакт", 4));
          await delay(10_000);
          await browser.waitFor(
            "document.querySelector('[role=dialog]')?.innerText.includes('Читањето траеше предолго')",
            "Недовршеното тело не беше прекинато.",
          );
          const state = await browser.evaluate<{ bodyStarted: boolean; hasAbortSignal: boolean; aborted: boolean; canRecord: boolean }>(`(() => {
            const dialog = document.querySelector('[role=dialog]');
            return {
              bodyStarted: ${heldStats}.bodyStarted,
              hasAbortSignal: ${heldStats}.hasAbortSignal,
              aborted: ${heldStats}.aborted,
              canRecord: [...dialog.querySelectorAll('button')].some((item) => item.textContent.includes('Евидентирај')),
            };
          })()`);
          assert.deepEqual(state, { bodyStarted: true, hasAbortSignal: true, aborted: true, canRecord: false });
          await browser.evaluate(restoreFetch);
          await browser.evaluate(clickButton("Затвори"));
        });

        await suite.test("Затворањето го прекинува старото читање пред друг контакт", async () => {
          await browser.evaluate(holdNextSuppressionResponse("GET"));
          await browser.evaluate(clickButton("Отвори контакт", 4));
          await browser.waitFor("document.querySelector('[role=dialog]')?.innerText.includes('Се чита евиденцијата')", "Старото читање не започна.");
          await browser.evaluate(clickButton("Затвори"));
          await delay(200);
          assert.equal(await browser.evaluate<boolean>(`${heldStats}.aborted`), true);
          await browser.evaluate(restoreFetch);
          await browser.evaluate(clickButton("Отвори контакт", 0));
          await browser.waitFor("document.querySelector('[role=dialog]')?.innerText.includes('Не контактирај')", "Другиот контакт не ја прочита сопствената состојба.");
          const phone = await browser.evaluate<string>("document.querySelector('[role=dialog] h2').textContent");
          assert.match(phone, /\+38970/);
          await browser.evaluate(clickButton("Затвори"));
        });

        await suite.test("Задоцнет стар одговор не ја враќа старата ознака", async () => {
          await browser.evaluate(clickButton("Претходна"));
          await browser.waitFor("document.body.innerText.includes('Страница 1')", "Првата страница не се отвори.");
          await openContact(browser, 2);
          const phone = await browser.evaluate<string>("document.querySelector('[role=dialog] h2').textContent");
          await browser.evaluate(holdNextContactsResponse);
          await browser.evaluate(setSearch("+38970"));
          await delay(300);
          await confirmSuppression(browser);
          await browser.waitFor("document.body.innerText.includes('Ограничувањето е евидентирано')", "Ограничувањето не се запиша.");
          await browser.evaluate("window.__releaseStaleContacts()");
          await delay(500);
          await browser.evaluate(restoreFetch);
          await browser.evaluate(clickButton("Затвори"));
          assert.match(await browser.evaluate<string>(labelForPhone(phone)), /Не контактирај/);
          assert.equal(await count(byPhone.get(phone)), 1);
        });

        await suite.test("Тесниот приказ нема хоризонтално прелевање", async () => {
          await openContact(browser, 3);
          await browser.evaluate(clickButton("Евидентирај „Не контактирај“"));
          await browser.setViewport(375, 820);
          const layout = await browser.evaluate<{ clientWidth: number; scrollWidth: number; text: string }>(`({
            clientWidth: document.documentElement.clientWidth,
            scrollWidth: document.documentElement.scrollWidth,
            text: document.querySelector('[role=dialog]').innerText,
          })`);
          assert.equal(layout.scrollWidth, layout.clientWidth);
          assert.match(layout.text, /Потврди ограничување/);
          assert.match(layout.text, /нема опција за отстранување/i);
          if (visualDirectory) await writeFile(join(visualDirectory, "contact-suppression-mobile.png"), await browser.captureScreenshot());
          await browser.evaluate(clickButton("Откажи"));
          await browser.evaluate(clickButton("Затвори"));
          await browser.setViewport(1280, 900);
        });

        assert.equal(await count(), 4);
      });
    } finally {
      await stop();
    }
  });
});
