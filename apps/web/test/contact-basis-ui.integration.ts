import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { applyMigrations } from "../../../packages/db/src/migrations.ts";
import { provisionAppRole } from "../../../packages/db/src/provision.ts";
import { verifyTestTarget, withTestDatabase } from "../../../packages/db/test/test-database.ts";
import { createCredentialUser } from "../src/server/create-credential-user.ts";
import { withBrowser } from "./browser-test.ts";
import type { BrowserDriver } from "./browser-test.ts";
import { reserveWebPort, startTestWeb } from "./test-web.ts";

const clickButton = (label: string, root = "document") => `(() => {
  const scope = ${root};
  const button = [...scope.querySelectorAll('button')].find((item) => item.textContent.trim() === ${JSON.stringify(label)});
  if (!button) throw new Error('Недостасува копче: ${label}');
  button.click();
})()`;

const setSearch = (value: string) => `(() => {
  const input = document.querySelector('input[type="search"]');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, ${JSON.stringify(value)});
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.form.requestSubmit();
})()`;

const setChannel = (value: "SMS" | "VIBER") => `(() => {
  const select = document.querySelector('[role="dialog"] select');
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
  setter.call(select, ${JSON.stringify(value)});
  select.dispatchEvent(new Event('change', { bubbles: true }));
})()`;

const installBasisFetchInspector = `(() => {
  const original = window.fetch;
  window.__basisOriginalFetch = original;
  window.__basisRequests = [];
  window.__basisMode = null;
  window.__basisStats = { held: false, ready: false, released: false, delivered: false, aborted: false, bodyStarted: false };
  window.__releaseBasis = null;
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    const method = (init?.method ?? 'GET').toUpperCase();
    const isBasis = url.pathname.endsWith('/basis');
    if (isBasis) window.__basisRequests.push({ method, path: url.pathname, search: url.search });
    const mode = window.__basisMode;
    if (!isBasis || method !== 'GET' || !mode || mode.used) return original(input, init);
    mode.used = true;
    const signal = init?.signal;
    window.__basisStats = { held: false, ready: false, released: false, delivered: false, aborted: false, bodyStarted: false };
    if (mode.kind === 'request-timeout') {
      window.__basisStats.held = true;
      return new Promise((resolve, reject) => {
        const abort = () => {
          window.__basisStats.aborted = true;
          reject(signal?.reason ?? new DOMException('Прекинато тест-барање.', 'AbortError'));
        };
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
      });
    }
    const response = await original(input, init);
    const body = await response.text();
    if (mode.kind === 'body-timeout') {
      const bytes = new TextEncoder().encode(body);
      return new Response(new ReadableStream({
        start(controller) {
          window.__basisStats.held = true;
          window.__basisStats.bodyStarted = true;
          controller.enqueue(bytes);
          const abort = () => {
            window.__basisStats.aborted = true;
            controller.error(signal?.reason ?? new DOMException('Прекинато JSON тело.', 'AbortError'));
          };
          if (signal?.aborted) abort();
          else signal?.addEventListener('abort', abort, { once: true });
        },
      }), { status: response.status, headers: response.headers });
    }
    if (mode.kind === 'stale') {
      return new Promise((resolve) => {
        window.__releaseBasis = () => {
          window.__basisStats.released = true;
          resolve(new Response(body, { status: response.status, headers: response.headers }));
        };
        window.__basisStats.held = true;
        window.__basisStats.ready = true;
      }).then((releasedResponse) => {
        window.__basisStats.delivered = true;
        return releasedResponse;
      });
    }
    return new Response(body, { status: response.status, headers: response.headers });
  };
})()`;

async function searchAndOpen(browser: BrowserDriver, phone: string, waitForResult = true) {
  await browser.evaluate(setSearch(phone));
  await browser.waitFor(`document.body.innerText.includes(${JSON.stringify(phone)})`, `Контактот ${phone} не се појави.`);
  await browser.evaluate(`(() => {
    const row = [...document.querySelectorAll('li')].find((item) => item.innerText.includes(${JSON.stringify(phone)}));
    const button = [...row.querySelectorAll('button')].find((item) => item.textContent.trim() === 'Основа за контакт');
    button.click();
  })()`);
  await browser.waitFor("Boolean(document.querySelector('[role=dialog]'))", "Дијалогот за основата не се отвори.");
  if (waitForResult) {
    await browser.waitFor("!document.querySelector('[role=dialog]').innerText.includes('Се вчитува основата')", "Основата не се вчита.");
  }
}

async function dialogText(browser: BrowserDriver) {
  return browser.evaluate<string>("document.querySelector('[role=dialog]').innerText");
}

const prepareBasisMode = (kind: "request-timeout" | "body-timeout" | "stale") => `(() => {
  window.__basisMode = { kind: ${JSON.stringify(kind)}, used: false };
  window.__releaseBasis = null;
  window.__basisStats = { held: false, ready: false, released: false, delivered: false, aborted: false, bodyStarted: false };
})()`;

test("преглед на основата за контакт во интерфејсот", { timeout: 300_000 }, async (suite) => {
  const requestedVisualDirectory = process.env.CONTACT_BASIS_VISUAL_DIR;
  const visualDirectory = requestedVisualDirectory ? resolve(requestedVisualDirectory) : null;
  if (visualDirectory && !visualDirectory.startsWith(`${resolve(process.cwd())}${sep}`)) {
    throw new Error("Папката за визуелни докази мора да биде во проектот.");
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
    const user = { name: "Синтетички UI оператор", email: "contact-basis-ui@example.test", password: randomBytes(24).toString("base64url") };
    const operatorId = await createCredentialUser(databaseUrl, { baseURL, secureCookies: false, secret }, user);
    const { rows: organizations } = await admin.query<{ id: string; kind: "CLINIC" | "MARKETING" }>(`
      INSERT INTO aevyra.organizations (kind, name) VALUES
        ('CLINIC', 'Синтетичка клиника за основи'),
        ('MARKETING', 'Синтетичка маркетинг организација')
      RETURNING id, kind
    `);
    const clinic = organizations.find((item) => item.kind === "CLINIC")!;
    const marketing = organizations.find((item) => item.kind === "MARKETING")!;
    const clinicPhones = Array.from({ length: 30 }, (_, index) => `+3897010${String(index + 1).padStart(4, "0")}`);
    const marketingPhone = "+38970200001";
    const { rows: contacts } = await admin.query<{ id: string; organization_id: string; normalized_phone: string }>(`
      INSERT INTO aevyra.contacts (organization_id, normalized_phone)
      SELECT $1::uuid, unnest($3::text[])
      UNION ALL SELECT $2::uuid, $4
      RETURNING id, organization_id, normalized_phone
    `, [clinic.id, marketing.id, clinicPhones, marketingPhone]);
    const contactId = (phone: string) => contacts.find((item) => item.normalized_phone === phone)!.id;

    async function event(phone: string, purpose: string, channel: string, eventType: "RECORD" | "WITHDRAW", revision: number,
      options: { basisType?: "CONSENT" | "DOCUMENTED_BASIS"; reference?: string; recordedAt?: string; expiresAt?: string } = {}) {
      await admin.query(`
        INSERT INTO aevyra.contact_basis_events (
          organization_id, contact_id, purpose, channel, event_type, operator_id, recorded_at, revision,
          idempotency_key, request_fingerprint, basis_type, reference, expires_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8, $9, $10, $11, $12, $13::timestamptz)
      `, [
        phone === marketingPhone ? marketing.id : clinic.id,
        contactId(phone), purpose, channel, eventType, operatorId,
        options.recordedAt ?? `2026-01-${String(revision + 10).padStart(2, "0")}T10:15:00Z`, revision,
        randomUUID(), randomBytes(32).toString("hex"), eventType === "RECORD" ? options.basisType ?? "CONSENT" : null,
        options.reference ?? null, eventType === "RECORD" ? options.expiresAt ?? null : null,
      ]);
    }

    await event(clinicPhones[1], "PATIENT_INFORMATION", "SMS", "RECORD", 1, {
      basisType: "CONSENT", reference: '<img src=x onerror="window.__referenceExecuted=true"> Синтетичка референца',
    });
    await event(clinicPhones[2], "PATIENT_INFORMATION", "SMS", "RECORD", 1, { basisType: "DOCUMENTED_BASIS", reference: "Првична основа" });
    await event(clinicPhones[2], "PATIENT_INFORMATION", "SMS", "WITHDRAW", 2, { reference: "Синтетичко повлекување" });
    await event(clinicPhones[3], "PATIENT_INFORMATION", "SMS", "RECORD", 1, {
      basisType: "CONSENT", reference: "Истечена синтетичка основа", recordedAt: "2020-01-11T10:15:00Z", expiresAt: "2020-07-15T10:15:00Z",
    });
    await event(clinicPhones[4], "PATIENT_INFORMATION", "SMS", "RECORD", 1, { reference: "Независен SMS" });
    await event(clinicPhones[4], "PATIENT_INFORMATION", "VIBER", "RECORD", 1, { reference: "Независен Viber" });
    await event(clinicPhones[4], "PATIENT_INFORMATION", "VIBER", "WITHDRAW", 2, { reference: "Повлечен Viber" });
    await event(clinicPhones[5], "PATIENT_INFORMATION", "SMS", "RECORD", 1, { reference: "Основа со забрана" });
    await admin.query(`
      INSERT INTO aevyra.contact_suppressions (organization_id, contact_id, operator_id, reason, reference)
      VALUES ($1, $2, $3, 'CONTACT_REQUEST', 'Синтетичка забрана')
    `, [clinic.id, contactId(clinicPhones[5]), operatorId]);
    await event(marketingPhone, "AEVYRA_MARKETING", "SMS", "RECORD", 1, { basisType: "DOCUMENTED_BASIS", reference: "Маркетинг основа" });

    const initialCounts = (await admin.query(`SELECT
      (SELECT count(*)::int FROM aevyra.contact_basis_events) AS events,
      (SELECT count(*)::int FROM aevyra.contact_suppressions) AS suppressions,
      (SELECT count(*)::int FROM aevyra.contacts) AS contacts
    `)).rows[0];

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
        await browser.navigate(`${baseURL}/app/organizations/${clinic.id}`);
        await browser.waitFor("document.body.innerText.includes('Вкупно во организацијата: 30')", "Контактите не се вчитаа.");
        await browser.evaluate(installBasisFetchInspector);

        await suite.test("четирите состојби, македонските ознаки и безбеден текст", async () => {
          const checks = [
            [clinicPhones[0], "Нема евидентирана основа"],
            [clinicPhones[1], "Евидентирана основа"],
            [clinicPhones[2], "Повлечена основа"],
            [clinicPhones[3], "Истечена основа"],
          ] as const;
          for (const [phone, label] of checks) {
            await searchAndOpen(browser, phone);
            const text = await dialogText(browser);
            assert.match(text, new RegExp(label));
            assert.match(text, /Информативни пораки за пациенти/);
            if (phone === clinicPhones[1]) {
              assert.match(text, /Согласност/);
              assert.match(text, /<img src=x onerror=/);
              assert.equal(await browser.evaluate<number>("document.querySelectorAll('[role=dialog] img').length"), 0);
              assert.equal(await browser.evaluate<boolean>("window.__referenceExecuted === true"), false);
              assert.match(text, /Без наведен рок/);
            }
            if (phone === clinicPhones[3]) {
              assert.match(text, /11\.01\.2020, 11:15:00/);
              assert.match(text, /15\.07\.2020, 12:15:00/);
              assert.doesNotMatch(text, /\b(?:AM|PM|Jan|Jul)\b/);
              if (visualDirectory) await writeFile(join(visualDirectory, "contact-basis-wide.png"), await browser.captureScreenshot());
            }
            if (phone === clinicPhones[2]) assert.doesNotMatch(text, /Документирана основа/);
            await browser.evaluate(clickButton("Затвори", "document.querySelector('[role=dialog]')"));
          }
        });

        await suite.test("SMS и Viber имаат независна состојба и нема стара состојба при вчитување", async () => {
          await searchAndOpen(browser, clinicPhones[4]);
          assert.match(await dialogText(browser), /Евидентирана основа[\s\S]*Без наведен рок/);
          await browser.evaluate(setChannel("VIBER"));
          const loadingText = await dialogText(browser);
          assert.match(loadingText, /Се вчитува основата/);
          assert.doesNotMatch(loadingText, /Евидентирана основа/);
          await browser.waitFor("document.querySelector('[role=dialog]').innerText.includes('Повлечена основа')", "Viber состојбата не се вчита.");
          assert.match(await dialogText(browser), /Изборот на Viber не потврдува/);
          await browser.evaluate(clickButton("Затвори", "document.querySelector('[role=dialog]')"));
        });

        await suite.test("Не контактирај останува независно видливо со RECORDED", async () => {
          await searchAndOpen(browser, clinicPhones[5]);
          const text = await dialogText(browser);
          assert.match(text, /Евидентирана основа/);
          assert.match(text, /Не контактирај/);
          assert.match(text, /не одобрува испраќање/);
          await browser.evaluate(clickButton("Затвори", "document.querySelector('[role=dialog]')"));
        });

        await suite.test("пребарувањето, страницата и фокусот се зачувуваат", async () => {
          await browser.evaluate(setSearch(""));
          await browser.waitFor("document.body.innerText.includes('Следна')", "Пагинацијата не се појави.");
          await browser.evaluate(clickButton("Следна"));
          await browser.waitFor("document.body.innerText.includes('Страница 2')", "Втората страница не се отвори.");
          await browser.evaluate(clickButton("Основа за контакт"));
          await browser.waitFor("Boolean(document.querySelector('[role=dialog]'))", "Дијалогот не се отвори на втората страница.");
          await browser.evaluate(clickButton("Затвори", "document.querySelector('[role=dialog]')"));
          await browser.waitFor(
            "document.activeElement?.textContent?.trim() === 'Основа за контакт'",
            "Фокусот не се врати на копчето за основата.",
          );
          const state = await browser.evaluate<{ search: string; page: boolean; focus: string }>(`({
            search: document.querySelector('input[type="search"]').value,
            page: document.body.innerText.includes('Страница 2'),
            focus: document.activeElement?.textContent?.trim() ?? '',
          })`);
          assert.deepEqual(state, { search: "", page: true, focus: "Основа за контакт" });
          await browser.evaluate(clickButton("Претходна"));
          await browser.waitFor("document.body.innerText.includes('Страница 1')", "Првата страница не се врати.");
        });

        await suite.test("timeout го прекинува GET, не прикажува MISSING и рачното повторување успева", async (context) => {
          await browser.evaluate(prepareBasisMode("request-timeout"));
          const startedAt = Date.now();
          await searchAndOpen(browser, clinicPhones[1], false);
          await browser.waitFor("window.__basisStats.held === true", "Тест-барањето не беше задржано.");
          await browser.waitFor("document.querySelector('[role=dialog]')?.innerText.includes('траеше предолго')", "Timeout грешката не се појави.");
          const elapsed = Date.now() - startedAt;
          const timedOut = await browser.evaluate<{ aborted: boolean; text: string; closeDisabled: boolean }>(`({
            aborted: window.__basisStats.aborted,
            text: document.querySelector('[role=dialog]').innerText,
            closeDisabled: [...document.querySelectorAll('[role=dialog] button')].find((item) => item.textContent.trim() === 'Затвори').disabled,
          })`);
          assert.equal(timedOut.aborted, true);
          assert.equal(timedOut.closeDisabled, false);
          assert.doesNotMatch(timedOut.text, /Нема евидентирана основа/);
          assert.ok(elapsed >= 9_500 && elapsed < 13_000, `GET timeout: ${elapsed} ms`);
          await browser.evaluate("window.__basisMode = null");
          await browser.evaluate(clickButton("Обиди се повторно", "document.querySelector('[role=dialog]')"));
          await browser.waitFor("document.querySelector('[role=dialog]').innerText.includes('Евидентирана основа')", "Рачното повторување не успеа.");
          await browser.evaluate(clickButton("Затвори", "document.querySelector('[role=dialog]')"));
          context.diagnostic(`GET timeout измерен на ${elapsed} ms.`);
        });

        await suite.test("рокот го покрива и недовршеното JSON тело", async () => {
          await browser.evaluate(prepareBasisMode("body-timeout"));
          await searchAndOpen(browser, clinicPhones[0], false);
          await browser.waitFor("window.__basisStats.bodyStarted === true", "JSON телото не започна.");
          await browser.waitFor("document.querySelector('[role=dialog]')?.innerText.includes('траеше предолго')", "Недовршеното тело не беше прекинато.");
          const state = await browser.evaluate<{ aborted: boolean; text: string }>(`({
            aborted: window.__basisStats.aborted,
            text: document.querySelector('[role=dialog]').innerText,
          })`);
          assert.equal(state.aborted, true);
          assert.doesNotMatch(state.text, /Нема евидентирана основа/);
          await browser.evaluate("window.__basisMode = null");
          await browser.evaluate(clickButton("Затвори", "document.querySelector('[role=dialog]')"));
        });

        await suite.test("задоцнет одговор не ја заменува состојбата по промена на канал", async () => {
          await browser.evaluate(prepareBasisMode("stale"));
          await searchAndOpen(browser, clinicPhones[4], false);
          await browser.waitFor(
            "window.__basisStats.ready === true && typeof window.__releaseBasis === 'function'",
            "SMS одговорот не беше подготвен за контролирано ослободување.",
          );
          await browser.evaluate(setChannel("VIBER"));
          await browser.waitFor("document.querySelector('[role=dialog]').innerText.includes('Повлечена основа')", "Новата Viber состојба не се вчита.");
          await browser.evaluate("window.__releaseBasis(); window.__basisMode = null");
          await browser.waitFor("window.__basisStats.delivered === true", "Стариот SMS одговор не беше доставен.");
          const text = await dialogText(browser);
          assert.match(text, /Повлечена основа/);
          assert.doesNotMatch(text, /Независен SMS/);
          await browser.evaluate(clickButton("Затвори", "document.querySelector('[role=dialog]')"));
        });

        await suite.test("затворањето го откажува стариот контакт и тесниот приказ не прелева", async () => {
          await browser.evaluate(prepareBasisMode("stale"));
          await searchAndOpen(browser, clinicPhones[1], false);
          await browser.waitFor(
            "window.__basisStats.ready === true && typeof window.__releaseBasis === 'function'",
            "Одговорот за стариот контакт не беше подготвен за контролирано ослободување.",
          );
          await browser.evaluate(clickButton("Затвори", "document.querySelector('[role=dialog]')"));
          await searchAndOpen(browser, clinicPhones[0]);
          await browser.evaluate("window.__releaseBasis(); window.__basisMode = null");
          await browser.waitFor("window.__basisStats.delivered === true", "Одговорот за стариот контакт не беше доставен.");
          const text = await dialogText(browser);
          assert.match(text, /Нема евидентирана основа/);
          assert.match(text, new RegExp(clinicPhones[0].replace('+', '\\+')));
          await browser.setViewport(375, 820);
          const layout = await browser.evaluate<{ clientWidth: number; scrollWidth: number; name: string; focused: string }>(`({
            clientWidth: document.documentElement.clientWidth,
            scrollWidth: document.documentElement.scrollWidth,
            name: document.querySelector('[role=dialog]').getAttribute('aria-labelledby'),
            focused: document.activeElement?.textContent?.trim() ?? '',
          })`);
          assert.equal(layout.scrollWidth, layout.clientWidth);
          assert.ok(layout.name);
          if (visualDirectory) await writeFile(join(visualDirectory, "contact-basis-narrow.png"), await browser.captureScreenshot());
          await browser.evaluate(clickButton("Затвори", "document.querySelector('[role=dialog]')"));
          await browser.setViewport(1280, 900);
        });

        await suite.test("маркетинг организацијата ја користи точната намена", async () => {
          await browser.navigate(`${baseURL}/app/organizations/${marketing.id}`);
          await browser.waitFor("document.body.innerText.includes('Вкупно во организацијата: 1')", "Маркетинг контактот не се вчита.");
          await browser.evaluate(installBasisFetchInspector);
          await searchAndOpen(browser, marketingPhone);
          const text = await dialogText(browser);
          assert.match(text, /Маркетинг на Aevyra/);
          assert.match(text, /Документирана основа/);
          await browser.evaluate(clickButton("Затвори", "document.querySelector('[role=dialog]')"));
        });

        await suite.test("новиот тек користи само GET и не менува деловни записи", async () => {
          const methods = await browser.evaluate<string[]>("window.__basisRequests.map((item) => item.method)");
          assert.ok(methods.length > 0);
          assert.deepEqual([...new Set(methods)], ["GET"]);
          const finalCounts = (await admin.query(`SELECT
            (SELECT count(*)::int FROM aevyra.contact_basis_events) AS events,
            (SELECT count(*)::int FROM aevyra.contact_suppressions) AS suppressions,
            (SELECT count(*)::int FROM aevyra.contacts) AS contacts
          `)).rows[0];
          assert.deepEqual(finalCounts, initialCounts);
        });
      });
    } finally {
      await stop();
    }
  });
});
