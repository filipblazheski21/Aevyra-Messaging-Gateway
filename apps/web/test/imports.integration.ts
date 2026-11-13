import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { text } from "node:stream/consumers";
import test from "node:test";
import { utils } from "xlsx";
import { applyMigrations } from "../../../packages/db/src/migrations.ts";
import { provisionAppRole } from "../../../packages/db/src/provision.ts";
import { verifyTestTarget, withTestDatabase } from "../../../packages/db/test/test-database.ts";
import { previewLimits, xlsxLimits } from "../src/import-preview.ts";
import type { ImportPreview, XlsxPreview } from "../src/import-preview.ts";
import type { Organization, OrganizationKind } from "../src/organizations.ts";
import { createCredentialUser } from "../src/server/create-credential-user.ts";
import { reserveWebPort, startTestWeb } from "./test-web.ts";
import { editXlsx, syntheticXlsx } from "./xlsx-fixtures.ts";

const previewPath = (id: string) => `/api/organizations/${id}/imports/preview`;

function upload(content: BlobPart, name = "synthetic.csv", type = "text/csv") {
  const form = new FormData();
  form.set("file", new File([content], name, { type }));
  form.set("delimiter", "comma");
  form.set("hasHeader", "true");
  return form;
}

function xlsxUpload(content: Buffer, name = "synthetic.xlsx") {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(content)], name, {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  }));
  form.set("hasHeader", "true");
  return form;
}

function fullColumnRows() {
  return [
    ["070123456", "PRIVATE_FIXTURE"],
    ["+389 70 123-456", "PRIVATE_FIXTURE"],
    ["", ""],
    ["", "PRIVATE_FIXTURE"],
    ["70123456", "PRIVATE_FIXTURE"],
    ...Array.from({ length: 19_993 }, () => ["+12025550123", "PRIVATE_FIXTURE"]),
    ["07012", "PRIVATE_FIXTURE"],
    ["0038970123456", "PRIVATE_FIXTURE"],
  ];
}

function assertFullColumn(preview: ImportPreview, proof: { diagnostic(message: string): void }) {
  assert.equal(preview.totalRecords, 20_000);
  assert.equal(preview.skippedEmptyRecords, 1);
  assert.equal(preview.samples.length, 100);
  assert.equal(preview.samples.at(-1)?.recordNumber, 102);
  assert.equal(preview.samples.some(({ phone }) => phone.status === "INVALID"), false);
  const duplicate = preview.samples[1];
  assert.equal(duplicate.recordNumber, 3);
  assert.equal(duplicate.phone.status, "VALID");
  assert.equal(duplicate.phone.normalizedPhone, "+38970123456");
  assert.equal(duplicate.phone.duplicate, true);
  assert.equal(duplicate.phone.firstRecordNumber, 2);
  assert.deepEqual(preview.analysis, {
    policyVersion: "phone-normalization-v1",
    counts: { excludedEmptyRecords: 1, emptyPhone: 1, invalid: 1, review: 1, uniqueValid: 2, duplicateValid: 19_994 },
  });
  const counts = preview.analysis.counts;
  assert.equal(Object.values(counts).reduce((sum, count) => sum + count, 0), preview.totalRecords);
  assert.doesNotMatch(JSON.stringify(preview), /PRIVATE_FIXTURE/);
  proof.diagnostic(`Редови ${preview.totalRecords}, примероци ${preview.samples.length}, последен примерок од ред ${preview.samples.at(-1)?.recordNumber}. Категории ${JSON.stringify(counts)}. Невалидниот ред 20000 и дупликатот на ред 20001 се надвор од примероците.`);
}

test("CSV и XLSX преглед со вистинска сесија и привремена PostgreSQL база", { timeout: 90_000 }, async (suite) => {
  await withTestDatabase(verifyTestTarget(), async (admin, databaseUrl, database) => {
    await applyMigrations(databaseUrl);
    const appUrl = new URL(databaseUrl);
    appUrl.username = database;
    appUrl.password = randomBytes(32).toString("base64url");
    await provisionAppRole(new URL(databaseUrl), appUrl);
    const port = await reserveWebPort();
    const baseURL = `http://127.0.0.1:${port}`;
    const settings = { baseURL, secureCookies: false, secret: randomBytes(32).toString("base64url") };
    const user = { name: "Синтетички оператор", email: "imports@example.test", password: randomBytes(24).toString("base64url") };
    await createCredentialUser(databaseUrl, settings, user);
    const stop = await startTestWeb(port, {
      DATABASE_URL: appUrl.href, AUTH_BASE_URL: baseURL, AUTH_LOCAL_HTTP: "true", AUTH_SECRET: settings.secret, REAL_SENDING_ENABLED: "false",
    });

    const request = (path: string, init: RequestInit = {}) => fetch(`${baseURL}${path}`, {
      ...init, redirect: "manual", signal: AbortSignal.timeout(12_000),
    });
    const json = async <T,>(response: Response, status: number): Promise<T> => {
      assert.equal(response.status, status);
      assert.equal(response.headers.get("Cache-Control"), "private, no-store");
      return response.json();
    };
    const error = async (response: Response, status: number) => {
      assert.match((await json<{ message: string }>(response, status)).message, /\p{Script=Cyrillic}/u);
    };
    const snapshot = async () => ({
      organizations: (await admin.query("SELECT * FROM aevyra.organizations ORDER BY id")).rows,
      businessTables: (await admin.query("SELECT tablename FROM pg_tables WHERE schemaname = 'aevyra' ORDER BY tablename")).rows,
      tables: (await admin.query("SELECT schemaname, tablename FROM pg_tables WHERE schemaname IN ('aevyra', 'aevyra_auth', 'public') ORDER BY 1, 2")).rows,
      saved: (await admin.query(`SELECT (SELECT count(*)::int FROM aevyra.contacts) AS contacts,
        (SELECT count(*)::int FROM aevyra.contact_imports) AS imports,
        (SELECT count(*)::int FROM aevyra.contact_import_contacts) AS links,
        (SELECT count(*)::int FROM aevyra.contact_suppressions) AS suppressions,
        (SELECT count(*)::int FROM aevyra.contact_basis_events) AS basis_events`)).rows[0],
    });

    try {
      const signIn = await request("/api/auth/sign-in/email", {
        method: "POST", headers: { Origin: baseURL, "Content-Type": "application/json" },
        body: JSON.stringify({ email: user.email, password: user.password }),
      });
      assert.equal(signIn.status, 200);
      const session = signIn.headers.getSetCookie().find((value) => value.startsWith("better-auth.session_token="));
      assert.ok(session, "Недостасува сесиска cookie.");
      const cookie = session.split(";")[0];
      const create = async (kind: OrganizationKind, name: string) => json<Organization>(await request("/api/organizations", {
        method: "POST", headers: { Origin: baseURL, Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ kind, name }),
      }), 201);
      const clinic = await create("CLINIC", "Синтетичка клиника");
      const marketing = await create("MARKETING", "Синтетичка маркетинг база");
      const before = await snapshot();
      const post = (id: string, body: BodyInit, headers: Record<string, string> = { Origin: baseURL, Cookie: cookie }) =>
        request(previewPath(id), { method: "POST", headers, body });
      const postXlsx = (id: string, body: BodyInit, headers: Record<string, string> = { Origin: baseURL, Cookie: cookie }) =>
        request(previewPath(id) + "/xlsx", { method: "POST", headers, body });

      await suite.test("Сесијата, фиксниот Origin и организацијата се проверуваат пред форматот на телото", async () => {
        await error(await post(clinic.id, "невалидно тело", { Origin: baseURL }), 401);
        await error(await post(clinic.id, "невалидно тело", { Cookie: cookie }), 403);
        await error(await post(clinic.id, "невалидно тело", { Cookie: cookie, Origin: "https://elsewhere.example.test" }), 403);
        await error(await post("invalid", "невалидно тело"), 400);
        await error(await post(randomUUID(), "невалидно тело"), 404);
      });

      await suite.test("CLINIC и MARKETING враќаат свој контекст и само избрана телефонска колона", async () => {
        for (const organization of [clinic, marketing]) {
          const form = upload("Телефон,Белешка\r\n070123456,PRIVATE_FIXTURE\r\n,друга белешка");
          const read = async () => json<{ organization: Omit<Organization, "created_at">; format: "csv"; preview: ImportPreview }>(
            await post(organization.id, form), 200);
          const metadata = await read();
          assert.equal(metadata.format, "csv");
          assert.deepEqual(metadata.preview.columns, [{ index: 0, name: "Телефон" }, { index: 1, name: "Белешка" }]);
          assert.deepEqual(metadata.preview.samples, []);
          assert.equal(metadata.preview.analysis, null);
          form.set("phoneColumn", "0");
          const result = await read();
          assert.deepEqual(result.organization, { id: organization.id, name: organization.name, kind: organization.kind });
          assert.deepEqual(result.preview.samples.map(({ recordNumber, value, phone }) => [recordNumber, value, phone.status, phone.duplicate]), [
            [2, "070123456", "VALID", false], [3, "", "EMPTY", false],
          ]);
          assert.equal(result.preview.analysis?.counts.uniqueValid, 1);
          assert.equal(result.preview.analysis?.counts.duplicateValid, 0);
          assert.ok(!JSON.stringify(result).includes("PRIVATE_FIXTURE"));
          form.set("analysis", JSON.stringify({ uniqueValid: 20000 }));
          await error(await post(organization.id, form), 400);
        }
        const invalid = upload("Телефон\n0001");
        invalid.set("phoneColumn", "1");
        await error(await post(clinic.id, invalid), 400);
        invalid.delete("phoneColumn");
        invalid.set("kind", "MARKETING");
        await error(await post(clinic.id, invalid), 400);
      });

      await suite.test("Се одбиваат неподдржан формат, невалиден CSV и преголема датотека или тело", async () => {
        await error(await post(clinic.id, "Телефон\n0001"), 415);
        await error(await post(clinic.id, upload("Телефон\n0001", "synthetic.xlsx")), 415);
        await error(await post(clinic.id, upload(new Uint8Array([0xff, 0xfe]))), 415);
        await error(await post(clinic.id, upload('Телефон\n"0001')), 400);
        await error(await post(clinic.id, upload("0".repeat(previewLimits.fileBytes + 1))), 413);
        await error(await post(clinic.id, upload("0".repeat(previewLimits.fileBytes + previewLimits.multipartOverheadBytes))), 413);
      });

      await suite.test("Преголем пренос во делови се одбива пред клиентот да го заврши телото", async () => {
        const reply = await new Promise<Response>((resolve, reject) => {
          const upload = httpRequest(baseURL + previewPath(clinic.id), {
            method: "POST", signal: AbortSignal.timeout(8_000),
            headers: {
              Origin: baseURL, Cookie: cookie, "Transfer-Encoding": "chunked",
              "Content-Type": "multipart/form-data; boundary=synthetic",
            },
          }, async (response) => {
            try {
              resolve(new Response(await text(response), {
                status: response.statusCode, headers: { "Cache-Control": response.headers["cache-control"] ?? "" },
              }));
            } catch (error) {
              reject(error);
            } finally {
              upload.destroy();
            }
          });
          upload.on("error", reject);
          upload.write(Buffer.alloc(previewLimits.fileBytes + previewLimits.multipartOverheadBytes + 1));
          // Leave the chunked request open so a response proves the server stopped reading.
        });
        await error(reply, 413);
      });

      await suite.test("CSV анализира 20.000 записи, вклучувајќи невалиден и дупликат по стотиот примерок", async (proof) => {
        const csv = "Телефон,Белешка\n" + fullColumnRows().map((row) => row.join(",")).join("\n") + "\n";
        const form = upload(csv);
        form.set("phoneColumn", "0");
        const response = await json<{ preview: ImportPreview }>(await post(marketing.id, form), 200);
        assertFullColumn(response.preview, proof);
        form.set("file", new File([csv + "0002,вишок\n"], "synthetic.csv", { type: "text/csv" }));
        await error(await post(marketing.id, form), 413);
      });

      await suite.test("XLSX ја користи истата заштита и ги одбива неподдржаните формати", async () => {
        await error(await postXlsx(clinic.id, "невалидно тело", { Origin: baseURL }), 401);
        await error(await postXlsx(clinic.id, "невалидно тело", { Cookie: cookie }), 403);
        await error(await postXlsx(clinic.id, "невалидно тело", { Cookie: cookie, Origin: "https://elsewhere.example.test" }), 403);
        await error(await postXlsx("invalid", "невалидно тело"), 400);
        await error(await postXlsx(randomUUID(), "невалидно тело"), 404);
        await error(await postXlsx(clinic.id, "Телефон\n0001"), 415);
        await error(await postXlsx(clinic.id, xlsxUpload(Buffer.from("Телефон\n0001"))), 415);
        for (const extension of ["xls", "xlsm", "xlsb"]) {
          await error(await postXlsx(clinic.id, xlsxUpload(Buffer.from("synthetic"), "synthetic." + extension)), 415);
        }
        await error(await postXlsx(clinic.id, xlsxUpload(Buffer.alloc(previewLimits.fileBytes + 1))), 413);
      });

      await suite.test("Вистински XLSX враќа одделен организациски контекст, листови и избрани вредности", async () => {
        const grid = utils.aoa_to_sheet([["Телефон", "Белешка"], ["070123456", "PRIVATE_OTHER_COLUMN"], [70123456, null]]);
        grid.A3.z = "000000000";
        const file = syntheticXlsx([
          { name: "Прв", grid },
          { name: "Втор", hidden: 1, grid: utils.aoa_to_sheet([["Број"], ["070123456"], ["PRIVATE_OTHER_SHEET"]]) },
        ]);
        for (const organization of [clinic, marketing]) {
          const form = xlsxUpload(file);
          const read = async () => json<XlsxPreview & { organization: Omit<Organization, "created_at"> }>(
            await postXlsx(organization.id, form), 200);
          const metadata = await read();
          assert.deepEqual(metadata.sheets, [{ index: 0, name: "Прв", hidden: false }, { index: 1, name: "Втор", hidden: true }]);
          assert.equal(metadata.preview, null);
          assert.doesNotMatch(JSON.stringify(metadata), /Телефон|PRIVATE/);
          form.set("sheet", "7");
          await error(await postXlsx(organization.id, form), 400);
          form.set("sheet", "0");
          form.set("kind", organization.kind);
          await error(await postXlsx(organization.id, form), 400);
          form.delete("kind");
          const columns = await read();
          assert.deepEqual(columns.preview?.columns, [{ index: 0, name: "Телефон" }, { index: 1, name: "Белешка" }]);
          assert.deepEqual(columns.preview?.samples, []);
          assert.equal(columns.preview?.analysis, null);
          form.set("phoneColumn", "0");
          const result = await read();
          assert.deepEqual(result.organization, { id: organization.id, name: organization.name, kind: organization.kind });
          assert.deepEqual(result.sheet, { index: 0, name: "Прв", hidden: false });
          assert.deepEqual(result.preview?.samples.map(({ recordNumber, value, cellKind, sourceKind, phone }) =>
            [recordNumber, value, cellKind, sourceKind, phone.status, phone.reasonCode, phone.duplicate]), [
            [2, "070123456", "text", "text", "VALID", "VALID_FORMAT", false],
            [3, "70123456", "number", "number", "REVIEW", "NUMERIC_SOURCE", false],
          ]);
          const numeric = result.preview?.samples[1];
          assert.equal(numeric?.cellKind === "number" && numeric.warning, "numeric-phone");
          assert.ok(numeric && !("normalizedPhone" in numeric.phone));
          assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
          form.set("sheet", "1");
          const other = await read();
          assert.equal(other.sheet?.index, 1);
          assert.equal(other.preview?.samples[0].phone.duplicate, false);
          assert.equal(other.preview?.analysis?.counts.uniqueValid, 1);
        }
      });

      await suite.test("XLSX HTTP обработува 20.000 редови и прекинува при преголема декомпресија", async (proof) => {
        const grid = utils.aoa_to_sheet([["Телефон", "Белешка"], ...fullColumnRows()]);
        const file = syntheticXlsx([{ name: "Лист", grid }]);
        const form = xlsxUpload(file);
        form.set("sheet", "0");
        form.set("phoneColumn", "0");
        const { preview } = await json<XlsxPreview>(await postXlsx(marketing.id, form), 200);
        assert.ok(preview);
        assertFullColumn(preview, proof);

        const expanded = editXlsx(file, (_part, add) => add("xl/expanded.xml", Buffer.alloc(xlsxLimits.expandedBytes + 1, 0x61)));
        assert.ok(expanded.length < previewLimits.fileBytes);
        const rejected = await json<{ message: string }>(await postXlsx(marketing.id, xlsxUpload(expanded)), 413);
        assert.match(rejected.message, /Декомпресираната.*50 MiB/);
      });

      await suite.test("Прегледите не запишуваат контакти, увози, врски или ограничувања и не ги менуваат организациите", async () => {
        assert.deepEqual(before.businessTables, [
          "contact_basis_events", "contact_import_contacts", "contact_imports", "contact_suppressions", "contacts", "organizations",
        ].map((tablename) => ({ tablename })));
        assert.deepEqual(before.saved, { contacts: 0, imports: 0, links: 0, suppressions: 0, basis_events: 0 });
        assert.deepEqual(await snapshot(), before);
      });
    } finally {
      await stop();
    }
  });
});
