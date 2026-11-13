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
import { reserveWebPort, startTestWeb } from "./test-web.ts";
import { withBrowser } from "./browser-test.ts";
import type { BrowserDriver } from "./browser-test.ts";

const csvText = "Телефон\n+12025550141\n+12025550142\n+12025550143";

const clickButton = (label: string) => `(() => {
  const button = [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === ${JSON.stringify(label)});
  if (!button) throw new Error('Недостасува копче.');
  button.click();
})()`;

const setSyntheticFile = (selector: string, content = csvText) => `(() => {
  const input = document.querySelector(${JSON.stringify(selector)});
  if (!input) throw new Error('Недостасува поле за датотека.');
  const transfer = new DataTransfer();
  transfer.items.add(new File([${JSON.stringify(content)}], 'synthetic.csv', { type: 'text/csv' }));
  Object.defineProperty(input, 'files', { configurable: true, value: transfer.files });
  input.dispatchEvent(new Event('change', { bubbles: true }));
})()`;

const selectPhoneColumn = `(() => {
  const select = [...document.querySelectorAll('select')].find((item) => [...item.options].some((option) => option.textContent.includes('Изберете колона')));
  if (!select) throw new Error('Недостасува избор на телефонска колона.');
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
  setter.call(select, '0');
  select.dispatchEvent(new Event('change', { bubbles: true }));
})()`;

async function prepareCsv(browser: BrowserDriver, content = csvText) {
  await browser.evaluate(clickButton("Преглед на датотека"));
  await browser.evaluate(setSyntheticFile("#preview-file", content));
  await browser.evaluate(clickButton("Прочитај колони"));
  await browser.waitFor(
    "[...document.querySelectorAll('option')].some((item) => item.textContent.includes('Колона 1'))",
    "Телефонската колона не се појави.",
  );
  await browser.evaluate(selectPhoneColumn);
  await browser.waitFor(
    "[...document.querySelectorAll('button')].some((item) => item.textContent.trim() === 'Зачувај валидни контакти')",
    "Прегледот не понуди зачувување.",
  );
  await browser.evaluate(clickButton("Зачувај валидни контакти"));
  await browser.waitFor(
    "[...document.querySelectorAll('button')].some((item) => item.textContent.trim() === 'Потврди зачувување')",
    "Не се појави потврдата за зачувување.",
  );
}

async function importCsv(browser: BrowserDriver, content = csvText) {
  await prepareCsv(browser, content);
  await browser.evaluate(clickButton("Потврди зачувување"));
  await browser.waitFor("document.body.innerText.includes('Увозот е зачуван')", "Увозот не заврши успешно.");
}

const setSearch = (value: string) => `(() => {
  const input = document.querySelector('input[type="search"]');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, ${JSON.stringify(value)});
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.form.requestSubmit();
})()`;

const hideNextImportResponse = `(() => {
  const original = window.fetch;
  window.__aevyraOriginalFetch = original;
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    const response = await original(input, init);
    if ((init?.method ?? 'GET').toUpperCase() === 'POST'
        && url.pathname.startsWith('/api/organizations/') && url.pathname.endsWith('/imports')
        && url.pathname.split('/').length === 5) {
      await response.arrayBuffer();
      throw new TypeError('Синтетички изгубен одговор по COMMIT.');
    }
    return response;
  };
})()`;

const restoreFetch = `(() => {
  if (window.__aevyraOriginalFetch) window.fetch = window.__aevyraOriginalFetch;
})()`;

const staleContactsOnNextDocument = `(() => {
  const original = window.fetch;
  let release;
  let held = false;
  window.__releaseStaleContacts = () => release?.();
  window.fetch = (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (!held && (init?.method ?? 'GET').toUpperCase() === 'GET'
        && url.pathname.startsWith('/api/organizations/') && url.pathname.endsWith('/contacts')
        && url.pathname.split('/').length === 5) {
      held = true;
      return new Promise((resolve) => {
        release = () => resolve(new Response(JSON.stringify({
          items: [], totalContacts: 0, matchedContacts: 0, nextCursor: null,
        }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } }));
      });
    }
    return original(input, init);
  };
})()`;

test("Потврдените увози ја освежуваат прикажаната контактна листа", { timeout: 180_000 }, async (suite) => {
  const requestedVisualDirectory = process.env.CONTACT_REFRESH_VISUAL_DIR;
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
    const user = { name: "Синтетички оператор", email: "contact-refresh@example.test", password: randomBytes(24).toString("base64url") };
    await createCredentialUser(databaseUrl, { baseURL, secureCookies: false, secret }, user);
    const { rows: organizations } = await admin.query<{ id: string; name: string }>(`
      INSERT INTO aevyra.organizations (kind, name) VALUES
        ('CLINIC', 'Обичен успех'),
        ('CLINIC', 'Пребарување и страница'),
        ('CLINIC', 'Изгубен одговор'),
        ('CLINIC', 'Обновување по освежување'),
        ('CLINIC', 'Преглед без зачувување')
      RETURNING id, name
    `);
    const organization = (name: string) => {
      const value = organizations.find((item) => item.name === name);
      if (!value) throw new Error(`Недостасува тест-организацијата ${name}.`);
      return value;
    };
    const direct = organization("Обичен успех");
    const searched = organization("Пребарување и страница");
    const lost = organization("Изгубен одговор");
    const restored = organization("Обновување по освежување");
    const previewOnly = organization("Преглед без зачувување");
    await admin.query(`
      INSERT INTO aevyra.contacts (organization_id, normalized_phone)
      SELECT $1, CASE WHEN n <= 27 THEN '+38970' || lpad(n::text, 6, '0') ELSE '+1202555' || lpad(n::text, 4, '0') END
      FROM generate_series(1, 30) AS n
    `, [searched.id]);
    const stop = await startTestWeb(port, {
      DATABASE_URL: appUrl.href, AUTH_BASE_URL: baseURL, AUTH_LOCAL_HTTP: "true", AUTH_SECRET: secret, REAL_SENDING_ENABLED: "false",
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
        const counts = async (organizationId: string) => (await admin.query<{ contacts: number; imports: number; links: number }>(`
          SELECT (SELECT count(*)::int FROM aevyra.contacts WHERE organization_id = $1) contacts,
                 (SELECT count(*)::int FROM aevyra.contact_imports WHERE organization_id = $1) imports,
                 (SELECT count(*)::int FROM aevyra.contact_import_contacts WHERE organization_id = $1) links
        `, [organizationId])).rows[0];
        const total = () => browser.evaluate<string>(
          "document.querySelector('#saved-contacts-title').closest('section').querySelector('strong').textContent",
        );

        await suite.test("Обичен успех освежува празна листа само еднаш", async (context) => {
          await browser.navigate(`${baseURL}/app/organizations/${direct.id}`);
          await browser.waitFor("document.body.innerText.includes('Вкупно во организацијата: 0')", "Почетната празна листа не се вчита.");
          await importCsv(browser);
          await browser.waitFor("document.body.innerText.includes('Вкупно во организацијата: 3')", "Листата не се освежи по потврдата.");
          const readsBefore = await browser.evaluate<number>(
            "performance.getEntriesByType('resource').filter((entry) => new URL(entry.name).pathname.endsWith('/contacts')).length",
          );
          await delay(700);
          const readsAfter = await browser.evaluate<number>(
            "performance.getEntriesByType('resource').filter((entry) => new URL(entry.name).pathname.endsWith('/contacts')).length",
          );
          assert.equal(await total(), "3");
          assert.deepEqual(await counts(direct.id), { contacts: 3, imports: 1, links: 3 });
          assert.equal(readsAfter, readsBefore, "Истиот резултат предизвикува повторливи вчитувања.");
          const desktopLayout = await browser.evaluate<{ clientWidth: number; scrollWidth: number }>(`({
            clientWidth: document.documentElement.clientWidth,
            scrollWidth: document.documentElement.scrollWidth,
          })`);
          assert.equal(desktopLayout.scrollWidth, desktopLayout.clientWidth);
          if (visualDirectory) await writeFile(join(visualDirectory, "contact-refresh-desktop.png"), await browser.captureScreenshot());
          context.diagnostic(`Празната листа автоматски премина од 0 на 3; GET читањата останаа ${readsAfter}.`);
        });

        await suite.test("Активното пребарување останува, а втората страница се враќа на прва", async () => {
          await browser.navigate(`${baseURL}/app/organizations/${searched.id}`);
          await browser.waitFor("document.body.innerText.includes('Вкупно во организацијата: 30')", "Почетните контакти не се вчитаа.");
          await browser.evaluate(setSearch("+38970"));
          await browser.waitFor("document.body.innerText.includes('Совпаднати резултати: 27')", "Пребарувањето не се примени.");
          await browser.evaluate(clickButton("Следна"));
          await browser.waitFor("document.body.innerText.includes('Страница 2')", "Втората страница не се отвори.");
          await importCsv(browser, "Телефон\n+38970900001\n+38970900002\n+441234567899");
          await browser.waitFor(
            "document.body.innerText.includes('Вкупно во организацијата: 33') && document.body.innerText.includes('Совпаднати резултати: 29')",
            "Бројачите не се освежија со активното пребарување.",
          );
          const state = await browser.evaluate<{ search: string; text: string }>(`({
            search: document.querySelector('input[type="search"]').value,
            text: document.querySelector('#saved-contacts-title').closest('section').innerText,
          })`);
          assert.equal(state.search, "+38970");
          assert.match(state.text, /Страница 1/);
          assert.doesNotMatch(state.text, /Страница 2/);
          assert.deepEqual(await counts(searched.id), { contacts: 33, imports: 1, links: 3 });
          await browser.setViewport(375, 820);
          await browser.evaluate("document.querySelector('#saved-contacts-title').scrollIntoView({ block: 'start' })");
          const mobileLayout = await browser.evaluate<{ clientWidth: number; scrollWidth: number }>(`({
            clientWidth: document.documentElement.clientWidth,
            scrollWidth: document.documentElement.scrollWidth,
          })`);
          assert.equal(mobileLayout.scrollWidth, mobileLayout.clientWidth);
          if (visualDirectory) await writeFile(join(visualDirectory, "contact-refresh-mobile.png"), await browser.captureScreenshot());
          await browser.setViewport(1280, 900);
        });

        await suite.test("Проверка на изгубен одговор го освежува резултатот без втор увоз", async () => {
          await browser.navigate(`${baseURL}/app/organizations/${lost.id}`);
          await browser.waitFor("document.body.innerText.includes('Вкупно во организацијата: 0')", "Празната листа не се вчита.");
          await prepareCsv(browser, "Телефон\n+12025550201\n+12025550202\n+12025550203");
          await browser.evaluate(hideNextImportResponse);
          await browser.evaluate(clickButton("Потврди зачувување"));
          await browser.waitFor("document.body.innerText.includes('Исходот на увозот е непознат')", "Не се прикажа непознатиот исход.");
          await browser.evaluate(restoreFetch);
          await browser.evaluate(clickButton("Провери исход"));
          await browser.waitFor(
            "document.body.innerText.includes('Увозот е зачуван') && document.body.innerText.includes('Вкупно во организацијата: 3')",
            "Проверката на исходот не ја освежи листата.",
          );
          assert.deepEqual(await counts(lost.id), { contacts: 3, imports: 1, links: 3 });
        });

        await suite.test("Обновувањето по странично освежување победува над стар одговор", async () => {
          const pageUrl = `${baseURL}/app/organizations/${restored.id}`;
          await browser.navigate(pageUrl);
          await browser.waitFor("document.body.innerText.includes('Вкупно во организацијата: 0')", "Празната листа не се вчита.");
          await prepareCsv(browser, "Телефон\n+12025550301\n+12025550302\n+12025550303");
          await browser.evaluate(hideNextImportResponse);
          await browser.evaluate(clickButton("Потврди зачувување"));
          await browser.waitFor("document.body.innerText.includes('Исходот на увозот е непознат')", "Не се зачува обидот за обновување.");
          const scriptId = await browser.addScript(staleContactsOnNextDocument);
          await browser.navigate(pageUrl);
          await browser.waitFor(
            "document.body.innerText.includes('Увозот е зачуван') && document.body.innerText.includes('Вкупно во организацијата: 3')",
            "Зачуваниот обид не ја освежи листата по освежување.",
          );
          await browser.evaluate("window.__releaseStaleContacts()");
          await delay(700);
          assert.equal(await total(), "3", "Задоцнетиот стар одговор ја замени новата листа.");
          await browser.removeScript(scriptId);
          assert.deepEqual(await counts(restored.id), { contacts: 3, imports: 1, links: 3 });
        });

        await suite.test("Преглед и враќање без потврда не менуваат контакти", async () => {
          await browser.navigate(`${baseURL}/app/organizations/${previewOnly.id}`);
          await browser.waitFor("document.body.innerText.includes('Вкупно во организацијата: 0')", "Празната листа не се вчита.");
          await prepareCsv(browser, "Телефон\n+12025550401\n+12025550402\n+12025550403");
          await browser.evaluate(clickButton("Назад кон прегледот"));
          await browser.evaluate(clickButton("Преглед на датотека"));
          await delay(500);
          assert.equal(await total(), "0");
          assert.deepEqual(await counts(previewOnly.id), { contacts: 0, imports: 0, links: 0 });
        });
      });
    } finally {
      await stop();
    }
  });
});
