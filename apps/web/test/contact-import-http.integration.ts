import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { text } from "node:stream/consumers";
import test from "node:test";
import { utils } from "xlsx";
import { applyMigrations } from "../../../packages/db/src/migrations.ts";
import { provisionAppRole } from "../../../packages/db/src/provision.ts";
import { verifyTestTarget, withTestDatabase } from "../../../packages/db/test/test-database.ts";
import { previewLimits, xlsxLimits } from "../src/import-preview.ts";
import type { ContactImportHistoryEntry, ContactImportResult, ImportConfirmation, ImportPreview, ImportSource } from "../src/import-preview.ts";
import type { Organization, OrganizationKind } from "../src/organizations.ts";
import { createCredentialUser } from "../src/server/create-credential-user.ts";
import { bulkSyntheticPhones } from "./phone-fixtures.ts";
import { reserveWebPort, startTestWeb } from "./test-web.ts";
import { editXlsx, syntheticXlsx } from "./xlsx-fixtures.ts";

const csvSource = { format: "csv", delimiter: "comma", hasHeader: true, phoneColumn: 0 } as const;
const xlsxSource = { format: "xlsx", sheetIndex: 0, hasHeader: true, phoneColumn: 0 } as const;
const importPath = (org: Organization) => `/api/organizations/${org.id}/imports`;
const csv = (value: string) => new File([value], "synthetic.csv", { type: "text/csv" });
const xlsx = (value: Buffer) => new File([new Uint8Array(value)], "synthetic.xlsx");
const workbook = (rows: (string | number)[][]) => syntheticXlsx([
  { name: "Синтетички лист", grid: utils.aoa_to_sheet(rows) },
  { name: "Друг лист", grid: utils.aoa_to_sheet([["Телефон"], ["+12025550104"]]) },
], { compression: true });
const phoneHeader = "Телефон,Белешка";
const smallCsv = csv(`${phoneHeader}\n+12025550100,a\n+1 202 555 0100,b\n\n,note\n2025550100,review\nabc,invalid\n+12025550101,c`);
const smallXlsxBytes = workbook([["Телефон", "Белешка"], ["+12025550100", "a"], ["+12025550102", "b"], [2025550103, "review"]]);
const smallXlsx = xlsx(smallXlsxBytes);

function formFor(file: File, receipt?: string) {
  const form = new FormData();
  form.set("file", file);
  if (receipt !== undefined) form.set("receipt", receipt);
  return form;
}

// Only the isolated test owns this signing secret. This lets HTTP tests reach the
// real expiry, fingerprint and parser defenses without adding a simulation API.
function signTestVariant(receipt: string, secret: string, update: (data: Record<string, unknown>) => void) {
  const data = JSON.parse(Buffer.from(receipt.split(".")[0], "base64url").toString("utf8"));
  update(data);
  const body = Buffer.from(JSON.stringify(data)).toString("base64url");
  const key = createHmac("sha256", secret).update("aevyra.contact-import.preview.signing-key.v1").digest();
  return `${body}.${createHmac("sha256", key).update(body, "ascii").digest("base64url")}`;
}

async function readJson<T>(response: Response, status: number): Promise<T> {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  return response.json();
}

async function expectError(response: Response, status: number, code: string) {
  const body = await readJson<{ code: string; message: string }>(response, status);
  assert.equal(body.code, code);
  assert.match(body.message, /\p{Script=Cyrillic}/u);
  return body;
}

test("Потврден CSV/XLSX увоз преку продукциска изградба и ограничена LOGIN улога", { timeout: 180_000 }, async (suite) => {
  await withTestDatabase(verifyTestTarget(), async (admin, databaseUrl, database) => {
    assert.equal((await applyMigrations(databaseUrl)).length, 5);
    const appUrl = new URL(databaseUrl);
    appUrl.username = database;
    appUrl.password = randomBytes(32).toString("base64url");
    await provisionAppRole(new URL(databaseUrl), appUrl);
    const port = await reserveWebPort();
    const baseURL = `http://127.0.0.1:${port}`;
    const settings = { baseURL, secureCookies: false, secret: randomBytes(32).toString("base64url") };
    const webEnv = {
      DATABASE_URL: appUrl.href, AUTH_BASE_URL: baseURL, AUTH_LOCAL_HTTP: "true",
      AUTH_SECRET: settings.secret, REAL_SENDING_ENABLED: "false",
    };
    const users = ["primary", "other"].map((name) => ({ name, email: `${name}@example.test`, password: randomBytes(24).toString("base64url") }));
    for (const user of users) await createCredentialUser(databaseUrl, settings, user);
    let stop = await startTestWeb(port, webEnv);
    const request = (path: string, init: RequestInit = {}) => fetch(`${baseURL}${path}`, {
      ...init, redirect: "manual", signal: AbortSignal.timeout(35_000),
    });

    try {
      const signIn = async ({ email, password }: typeof users[number]) => {
        const response = await request("/api/auth/sign-in/email", {
          method: "POST", headers: { Origin: baseURL, "Content-Type": "application/json" }, body: JSON.stringify({ email, password }),
        });
        assert.equal(response.status, 200);
        await response.body?.cancel();
        const session = response.headers.getSetCookie().find((value) => value.startsWith("better-auth.session_token="));
        assert.ok(session, "Недостасува тест-сесија.");
        return session.split(";")[0];
      };
      const [cookie, otherCookie] = await Promise.all(users.map(signIn));
      const create = async (kind: OrganizationKind, name: string) => readJson<Organization>(await request("/api/organizations", {
        method: "POST", headers: { Origin: baseURL, Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ name, kind }),
      }), 201);
      const clinic = await create("CLINIC", "Синтетичка клиника");
      const other = await create("MARKETING", "Синтетичка база");
      const post = (org: Organization, form: FormData, session = cookie, origin = baseURL) =>
        request(importPath(org), { method: "POST", headers: { Origin: origin, Cookie: session }, body: form });
      const preview = (org: Organization, file: File, source: ImportSource, receipt?: string) => {
        const form = formFor(file, receipt);
        form.set("hasHeader", String(source.hasHeader));
        form.set("phoneColumn", String(source.phoneColumn));
        if (source.format === "csv") form.set("delimiter", source.delimiter);
        else form.set("sheet", String(source.sheetIndex));
        return request(`${importPath(org)}/preview${source.format === "xlsx" ? "/xlsx" : ""}`, {
          method: "POST", headers: { Origin: baseURL, Cookie: cookie }, body: form,
        });
      };
      const analyze = async (org: Organization, file: File, source: ImportSource, receipt?: string) => {
        const result = await readJson<{ preview: ImportPreview; confirmation: ImportConfirmation }>(await preview(org, file, source, receipt), 200);
        assert.ok(result.confirmation && typeof result.confirmation.receipt === "string", "Недостасува потврда.");
        assert.deepEqual(result.confirmation.source, source);
        assert.equal(Object.hasOwn(result, "candidates"), false);
        assert.equal(Object.hasOwn(result.preview, "candidates"), false);
        return result;
      };
      const save = async (org: Organization, file: File, receipt: string) => {
        const result = await readJson<{ code: string; result: ContactImportResult }>(await post(org, formFor(file, receipt)), 200);
        assert.equal(result.code, "IMPORT_SAVED");
        return result.result;
      };
      const outcome = (org: Organization, key: string, session = cookie) =>
        request(`${importPath(org)}?idempotencyKey=${encodeURIComponent(key)}`, { headers: { Cookie: session } });
      const history = async (org: Organization) => {
        const { code, imports } = await readJson<{ code: string; imports: ContactImportHistoryEntry[] }>(await request(importPath(org), {
          headers: { Cookie: cookie },
        }), 200);
        assert.equal(code, "IMPORT_HISTORY");
        return imports;
      };
      const counts = async () => (await admin.query(`SELECT
        (SELECT count(*)::int FROM aevyra.contacts) AS contacts,
        (SELECT count(*)::int FROM aevyra.contact_imports) AS imports,
        (SELECT count(*)::int FROM aevyra.contact_import_contacts) AS links`)).rows[0];
      const noWrites = { contacts: 0, imports: 0, links: 0 };
      const { confirmation: csvConfirmation } = await analyze(clinic, smallCsv, csvSource);
      const { confirmation: xlsxConfirmation } = await analyze(clinic, smallXlsx, xlsxSource);
      const variant = (receipt: string, update: Parameters<typeof signTestVariant>[2]) => signTestVariant(receipt, settings.secret, update);
      const expired = (receipt: string) => variant(receipt, (data) => {
        const end = Date.now() - 1000;
        data.issuedAt = end - 30 * 60 * 1000;
        data.expiresAt = end;
      });

      await suite.test("Прегледот и проверката на непознат исход се само читање", async () => {
        assert.deepEqual(await counts(), noWrites);
        assert.deepEqual(await history(clinic), []);
        const pending = await readJson<{ code: string; message: string }>(await outcome(clinic, csvConfirmation.idempotencyKey), 200);
        assert.deepEqual(pending, { code: "PENDING", message: "Сè уште нема потврден резултат" });
        const zero = await readJson<{ preview: ImportPreview; confirmation?: ImportConfirmation }>(
          await preview(clinic, csv("Телефон\nabc"), csvSource), 200,
        );
        assert.equal(zero.preview.analysis?.counts.uniqueValid, 0);
        assert.equal(Object.hasOwn(zero, "confirmation"), false);
        assert.deepEqual(await counts(), noWrites);
      });

      await suite.test("Сесија, Origin, организација, оператор, потпис и дозволени полиња", async () => {
        const form = formFor(smallCsv, csvConfirmation.receipt);
        await expectError(await post(clinic, form, ""), 401, "AUTH_REQUIRED");
        await expectError(await post(clinic, form, cookie, "https://elsewhere.example.test"), 403, "ORIGIN_DENIED");
        await expectError(await request(importPath(clinic)), 401, "AUTH_REQUIRED");
        await expectError(await post({ ...clinic, id: randomUUID() }, form), 404, "ORGANIZATION_NOT_FOUND");
        await expectError(await post(clinic, form, otherCookie), 400, "INVALID_RECEIPT");
        await expectError(await post(other, form), 400, "INVALID_RECEIPT");
        await expectError(await post(clinic, formFor(smallCsv)), 400, "INVALID_RECEIPT");
        const [payload, sig] = csvConfirmation.receipt.split(".");
        const changed = `${payload}.${sig[0] === "A" ? "B" : "A"}${sig.slice(1)}`;
        await expectError(await post(clinic, formFor(smallCsv, changed)), 400, "INVALID_RECEIPT");
        await expectError(await post(clinic, formFor(smallCsv, "a".repeat(2049))), 400, "INVALID_RECEIPT");
        for (const field of ["candidates", "counts", "operatorId", "fingerprint", "phoneColumn", "hasHeader", "delimiter", "sheet"]) {
          form.set(field, "untrusted");
          await expectError(await post(clinic, form), 400, "INVALID_REQUEST");
          form.delete(field);
        }
        form.append("receipt", csvConfirmation.receipt);
        await expectError(await post(clinic, form), 400, "INVALID_REQUEST");
        assert.deepEqual(await counts(), noWrites);
      });

      await suite.test("Бајти, колона, заглавие, разделувач, лист, верзија и отпечаток се врзани со прегледот", async () => {
        await expectError(await post(clinic, formFor(csv("Телефон\n+12025550109"), csvConfirmation.receipt)), 409, "PREVIEW_MISMATCH");
        for (const source of [{ ...csvSource, phoneColumn: 1 }, { ...csvSource, hasHeader: false }, { ...csvSource, delimiter: "semicolon" } as const]) {
          await expectError(await preview(clinic, smallCsv, source, csvConfirmation.receipt), 409, "PREVIEW_MISMATCH");
        }
        await expectError(await preview(clinic, smallXlsx, { ...xlsxSource, sheetIndex: 1 }, xlsxConfirmation.receipt), 409, "PREVIEW_MISMATCH");
        for (const [field, value] of [["fingerprint", "a".repeat(64)], ["policyVersion", "phone-normalization-v2"], ["libraryVersion", "0.0.1"]]) {
          const changed = variant(csvConfirmation.receipt, (data) => { data[field] = value; });
          await expectError(await post(clinic, formFor(smallCsv, changed)), 409, "PREVIEW_MISMATCH");
          await expectError(await preview(clinic, smallCsv, csvSource, changed), 409, "PREVIEW_MISMATCH");
        }
        assert.deepEqual(await counts(), noWrites);
      });

      let savedCsv: ContactImportResult;
      let savedXlsx: ContactImportResult;
      await suite.test("Истекување, обновен преглед без запис и две паралелни потврди со ист клуч", async () => {
        const old = expired(csvConfirmation.receipt);
        await expectError(await post(clinic, formFor(smallCsv, old)), 410, "PREVIEW_EXPIRED");
        assert.deepEqual(await counts(), noWrites);
        const { confirmation } = await analyze(clinic, smallCsv, csvSource, old);
        assert.equal(confirmation.idempotencyKey, csvConfirmation.idempotencyKey);
        assert.ok(confirmation.expiresAt > Date.now() && confirmation.expiresAt <= Date.now() + 30 * 60 * 1000);
        assert.deepEqual(await counts(), noWrites);
        const [first, concurrent] = await Promise.all([save(clinic, smallCsv, confirmation.receipt), save(clinic, smallCsv, confirmation.receipt)]);
        assert.deepEqual(first, concurrent);
        savedCsv = first;
        assert.deepEqual({ ...first.counts, new: first.newContacts, existing: first.existingContacts }, {
          excludedEmptyRecords: 1, emptyPhone: 1, invalid: 1, review: 1, uniqueValid: 2, duplicateValid: 1, new: 2, existing: 0,
        });
        assert.deepEqual(await counts(), { contacts: 2, imports: 1, links: 2 });
        const positions = (await admin.query("SELECT source_record_number FROM aevyra.contact_import_contacts WHERE import_id = $1 ORDER BY 1", [first.importId])).rows;
        assert.deepEqual(positions.map((row) => row.source_record_number), [2, 8]);
        const collision = variant(xlsxConfirmation.receipt, (data) => { data.idempotencyKey = confirmation.idempotencyKey; });
        await expectError(await post(clinic, formFor(smallXlsx, collision)), 409, "IDEMPOTENCY_CONFLICT");
      });

      await suite.test("Игнориран одговор по COMMIT, точни постојни контакти, читање и повторување по рестарт", async () => {
        const ignored = await post(clinic, formFor(smallXlsx, xlsxConfirmation.receipt));
        assert.equal(ignored.status, 200);
        await ignored.body?.cancel();
        await stop();
        stop = await startTestWeb(port, webEnv);
        const reply = await readJson<{ code: string; result: ContactImportResult }>(await outcome(clinic, xlsxConfirmation.idempotencyKey), 200);
        assert.equal(reply.code, "IMPORT_SAVED");
        savedXlsx = reply.result;
        assert.equal(savedXlsx.newContacts, 1);
        assert.equal(savedXlsx.existingContacts, 1);
        assert.equal(savedXlsx.counts.review, 1);
        assert.deepEqual(await save(clinic, smallXlsx, xlsxConfirmation.receipt), savedXlsx);
        await expectError(await post(clinic, formFor(smallXlsx, expired(xlsxConfirmation.receipt))), 410, "PREVIEW_EXPIRED");
        const csvReply = await readJson<{ result: ContactImportResult }>(await outcome(clinic, csvConfirmation.idempotencyKey), 200);
        assert.deepEqual(csvReply.result, savedCsv);
        for (const [org, session] of [[other, cookie], [clinic, otherCookie]] as const) {
          assert.equal((await readJson<{ code: string }>(await outcome(org, xlsxConfirmation.idempotencyKey, session), 200)).code, "PENDING");
        }
        assert.deepEqual(await counts(), { contacts: 3, imports: 2, links: 4 });
        assert.deepEqual((await history(clinic)).map(({ importId, format }) => [importId, format]), [[savedXlsx.importId, "xlsx"], [savedCsv.importId, "csv"]]);
        assert.deepEqual(await history(other), []);
      });

      await suite.test("20.000 единствени VALID кандидати по CSV и XLSX преку HTTP", async (proof) => {
        const bulkOrg = await create("MARKETING", "Синтетички голем увоз");
        const phones = bulkSyntheticPhones();
        const csvFile = csv(`Телефон\n${phones.join("\n")}`);
        const xlsxFile = xlsx(workbook([["Телефон"], ...phones.map((phone) => [phone])]));
        for (const [file, source] of [[csvFile, csvSource], [xlsxFile, xlsxSource]] as const) {
          const { preview: data, confirmation } = await analyze(bulkOrg, file, source);
          assert.equal(data.analysis?.counts.uniqueValid, 20_000);
          assert.equal(data.samples.length, 100);
          assert.ok(!JSON.stringify(data).includes(phones[100]), "Телефон по стотиот примерок е присутен во HTTP прегледот.");
          const result = await save(bulkOrg, file, confirmation.receipt);
          const xlsxFileSelected = source.format === "xlsx";
          assert.equal(result.newContacts, xlsxFileSelected ? 0 : 20_000);
          assert.equal(result.existingContacts, xlsxFileSelected ? 20_000 : 0);
          const { rows: [links] } = await admin.query(`SELECT count(*)::int AS count, max(source_record_number) AS last
            FROM aevyra.contact_import_contacts WHERE import_id = $1`, [result.importId]);
          assert.deepEqual(links, { count: 20_000, last: 20_001 });
          proof.diagnostic(`${source.format.toUpperCase()} 20.000 единствени, 100 примероци, ${result.newContacts} нови, ${result.existingContacts} постојни, 20.000 врски.`);
        }
        assert.deepEqual(await counts(), { contacts: 20_003, imports: 4, links: 40_004 });
      });

      await suite.test("Историјата е ограничена на 20 и стабилна во организацијата", async () => {
        for (let index = 0; index < 21; index++) {
          const { confirmation } = await analyze(other, smallCsv, csvSource);
          await save(other, smallCsv, confirmation.receipt);
        }
        // An identical timestamp verifies the secondary ordering key.
        await admin.query("UPDATE aevyra.contact_imports SET created_at = '2026-01-01T00:00:00Z' WHERE organization_id = $1", [other.id]);
        const rows = await history(other);
        assert.equal(rows.length, 20);
        assert.deepEqual(rows.map(({ importId }) => importId), rows.map(({ importId }) => importId).sort().reverse());
        assert.deepEqual(Object.keys(rows[0]).sort(), ["createdAt", "existingContacts", "format", "importId", "newContacts"]);
        assert.equal((await history(clinic)).length, 2);
      });

      await suite.test("Зачувувањето ги одбива преголемо реално тело, XLSX декомпресија и бавно прикачување", async () => {
        const before = await counts();
        const tooBig = new File([new Uint8Array(previewLimits.fileBytes + 1)], "synthetic.xlsx");
        await expectError(await post(clinic, formFor(tooBig, xlsxConfirmation.receipt)), 413, "IMPORT_LIMIT_EXCEEDED");
        const expanded = editXlsx(smallXlsxBytes, (_part, add) => add("xl/expanded.xml", Buffer.alloc(xlsxLimits.expandedBytes + 1, 0x61)));
        assert.ok(expanded.length < previewLimits.fileBytes);
        const token = variant(xlsxConfirmation.receipt, (data) => { data.sourceSha256 = createHash("sha256").update(expanded).digest("hex"); });
        const zip = await expectError(await post(clinic, formFor(xlsx(expanded), token)), 413, "IMPORT_LIMIT_EXCEEDED");
        assert.match(zip.message, /Декомпресираната.*50 MiB/);

        function chunked(initial: Buffer, finish: boolean) {
          return new Promise<{ status?: number; body: { code: string; message: string }; cache?: string }>((resolve, reject) => {
            const req = httpRequest(`${baseURL}${importPath(clinic)}`, {
              method: "POST", headers: { Origin: baseURL, Cookie: cookie, "Content-Type": "multipart/form-data; boundary=synthetic" },
            }, async (res) => {
              try {
                resolve({ status: res.statusCode, body: JSON.parse(await text(res)), cache: res.headers["cache-control"] });
              } catch (error) {
                reject(error);
              } finally {
                req.destroy();
              }
            });
            req.on("error", reject);
            req.setTimeout(22_000, () => req.destroy(new Error("Не пристигна одговор за ограничено прикачување.")));
            if (finish) req.end(initial);
            else req.write(initial);
          });
        }
        const body = await chunked(Buffer.alloc(previewLimits.fileBytes + previewLimits.multipartOverheadBytes + 1), true);
        assert.equal(body.status, 413);
        assert.equal(body.body.code, "IMPORT_LIMIT_EXCEEDED");
        const started = Date.now();
        const slow = await chunked(Buffer.from("--synthetic\r\n"), false);
        assert.equal(slow.status, 400);
        assert.equal(slow.cache, "private, no-store");
        assert.equal(slow.body.code, "INVALID_REQUEST");
        assert.match(slow.body.message, /Истече времето за прикачување/);
        assert.ok(Date.now() - started >= xlsxLimits.uploadMs - 1000);
        assert.deepEqual(await counts(), before);
      });
    } finally {
      await stop();
    }
  });
});
