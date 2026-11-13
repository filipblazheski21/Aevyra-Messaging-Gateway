import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { utils } from "xlsx";
import { editXlsx, syntheticXlsx } from "../../test/xlsx-fixtures.ts";
import { phonePolicyVersion, previewLimits, xlsxLimits } from "../import-preview.ts";
import type { ImportPreview, XlsxSample } from "../import-preview.ts";
import { ImportPreviewError } from "./import-preview-error.ts";
import { confirmContactImport, previewContactImport } from "./contact-import-http.ts";
import { contactImportFingerprint, contactImportLibraryVersion } from "./contact-imports.ts";
import type { PreparedContactImport } from "./contact-imports.ts";
import { issueImportReceipt } from "./import-receipt.ts";
import { previewXlsx } from "./xlsx-preview.ts";
import type { XlsxPreviewOptions } from "./xlsx-preview.ts";

const sheetXml = "xl/worksheets/sheet1.xml";
const options = { sheet: 0, hasHeader: true, phoneColumn: 0 };
const fixture = (values: unknown[][]) => syntheticXlsx([{ name: "Лист", grid: utils.aoa_to_sheet(values) }]);
const preview = async (file: Buffer, settings: Partial<XlsxPreviewOptions> = {}) => {
  const result = await previewXlsx(file, { ...options, ...settings });
  assert.ok(result.preview);
  return result.preview;
};
const rejects = (result: Promise<unknown>, status: number, message: RegExp) =>
  assert.rejects(result, (error) => error instanceof ImportPreviewError && error.status === status && message.test(error.message));
const sourceSamples = (result: ImportPreview<XlsxSample>) =>
  result.samples.map(({ recordNumber, value, cellKind }) => ({ recordNumber, value, cellKind }));

test("XLSX прво враќа само листови и бара експлицитен избор", async () => {
  const file = syntheticXlsx([
    { name: "Пациенти", grid: utils.aoa_to_sheet([["Телефон"], ["+00001"]]) },
    { name: "Скриен", hidden: 2, grid: utils.aoa_to_sheet([["Број"], ["PRIVATE_FIXTURE"]]) },
  ]);
  assert.deepEqual(await previewXlsx(file, { sheet: null, hasHeader: true, phoneColumn: null }), {
    format: "xlsx",
    sheets: [{ index: 0, name: "Пациенти", hidden: false }, { index: 1, name: "Скриен", hidden: true }],
    sheet: null, preview: null,
  });
  await rejects(preview(file, { sheet: 2 }), 400, /работен лист/);
  await rejects(previewXlsx(file, { ...options, sheet: null }), 400, /Прво изберете/);
  assert.deepEqual(sourceSamples(await preview(file, { sheet: 1 })), [{ recordNumber: 2, value: "PRIVATE_FIXTURE", cellKind: "text" }]);
  assert.doesNotMatch(JSON.stringify(await preview(file)), /PRIVATE_FIXTURE/);
});

test("XLSX ги зачувува индексите, празните редови, филтрираните и скриените записи и ги игнорира завршните стилови", async () => {
  const grid = utils.aoa_to_sheet([["Телефон", null, "Телефон"], [" +00001 ", null, "БЕЛЕШКА"], [], [null, null, "друго"]]);
  grid["!rows"] = [ {}, { hidden: true } ];
  grid["!autofilter"] = { ref: "A1:C4" };
  const file = editXlsx(syntheticXlsx([{ name: "Лист", grid }]), (part) => {
    part(sheetXml, (xml) => xml.replace('ref="A1:C4"', 'ref="A1:XFD1048576"')
      .replace("</sheetData>", '<row r="1048576"><c r="XFD1048576" s="0"/></row></sheetData>'));
  });
  const data = await preview(file);
  assert.deepEqual(data.columns, [{ index: 0, name: "Телефон" }, { index: 1, name: "" }, { index: 2, name: "Телефон" }]);
  assert.equal(data.totalRecords, 3);
  assert.equal(data.skippedEmptyRecords, 1);
  assert.deepEqual(sourceSamples(data), [
    { recordNumber: 2, value: " +00001 ", cellKind: "text" },
    { recordNumber: 4, value: "", cellKind: "empty" },
  ]);
  assert.doesNotMatch(JSON.stringify(data), /БЕЛЕШКА|друго/);
  const withoutHeader = await preview(file, { hasHeader: false, phoneColumn: 2 });
  assert.equal(withoutHeader.columns[0].name, null);
  assert.deepEqual(withoutHeader.samples.map(({ recordNumber, value }) => [recordNumber, value]), [[1, "Телефон"], [2, "БЕЛЕШКА"], [4, "друго"]]);
  const blankHeader = await preview(fixture([[], [], ["0005"]]));
  assert.equal(blankHeader.columns[0].name, "");
  assert.equal(blankHeader.skippedEmptyRecords, 1);
  assert.equal(blankHeader.samples[0].recordNumber, 3);
  await rejects(preview(file, { phoneColumn: 3 }), 400, /телефонска колона/);
});

test("Rich text, хиперврски и текст сличен на код се прикажуваат само како текст", async () => {
  const grid = utils.aoa_to_sheet([["Телефон"], [" +0001 "], ["<img src=x onerror=alert(1)>"], ["=1+1"]]);
  grid.A2.l = { Target: "https://example.test/private-fixture" };
  const file = editXlsx(syntheticXlsx([{ name: "Лист", grid }]), (part) => {
    part("xl/sharedStrings.xml", (xml) => xml.replace(/<si><t[^>]*> \+0001 <\/t><\/si>/,
      '<si><r><t xml:space="preserve"> +00</t></r><r><t xml:space="preserve">01 </t></r></si>'));
  });
  const data = await preview(file);
  assert.deepEqual(data.samples.map(({ value }) => value), [" +0001 ", "<img src=x onerror=alert(1)>", "=1+1"]);
  assert.doesNotMatch(JSON.stringify(data), /example\.test/);
});

test("Безбеден број се прикажува без формат и со предупредување", async () => {
  const grid = utils.aoa_to_sheet([["Телефон"], [21], [123000], [0], [Number.MAX_SAFE_INTEGER]]);
  grid.A2.z = "0000000";
  grid.A3.z = "0.00E+00";
  const data = await preview(syntheticXlsx([{ name: "Лист", grid }]));
  assert.deepEqual(data.samples.map(({ value }) => value), ["21", "123000", "0", "9007199254740991"]);
  assert.ok(data.samples.every((sample) => sample.cellKind === "number" && sample.warning === "numeric-phone"));
  assert.ok(data.samples.every(({ phone }) => phone.status === "REVIEW" && phone.reasonCode === "NUMERIC_SOURCE" && !("normalizedPhone" in phone)));

  const sameDigits = utils.aoa_to_sheet([["Телефон"], ["070123456"], [70123456], ["70123456"]]);
  sameDigits.A3.z = "000000000";
  const compared = await preview(syntheticXlsx([{ name: "Лист", grid: sameDigits }]));
  assert.deepEqual(compared.samples.map(({ value, sourceKind, phone }) => [value, sourceKind, phone.status, phone.reasonCode]), [
    ["070123456", "text", "VALID", "VALID_FORMAT"],
    ["70123456", "number", "REVIEW", "NUMERIC_SOURCE"],
    ["70123456", "text", "REVIEW", "AMBIGUOUS_PREFIX"],
  ]);
});

test("Формула, датум, логичка вредност, Excel грешка и неподдржан број се одбиваат со адреса", async () => {
  const replacements = [
    [{ t: "n", f: "1+1", v: 2 }, /A2.*формула/],
    [{ t: "n", f: "1+1" }, /A2.*формула/],
    [{ t: "n", v: 46000, z: "yyyy-mm-dd" }, /A2.*датум/],
    [{ t: "b", v: true }, /A2.*логичка/],
    [{ t: "e", v: 7 }, /A2.*Excel грешка/],
    ...[0.5, -1, 9007199254740992].map((value) => [{ t: "n", v: value }, /A2.*безбеден цел број/] as const),
  ] as const;
  for (const [replacement, message] of replacements) {
    const grid = utils.aoa_to_sheet([["Телефон"], ["0002"]]);
    grid.A2 = replacement;
    await rejects(preview(syntheticXlsx([{ name: "Лист", grid }])), 400, message);
  }
  const fraction = editXlsx(fixture([["Телефон"], [1]]), (part) =>
    part(sheetXml, (xml) => xml.replace("<v>1</v>", "<v>1.0000000000000001</v>")));
  await rejects(preview(fraction), 400, /A2.*безбеден цел број/);
  const invalidNumber = editXlsx(fixture([["Телефон"], [1]]), (part) =>
    part(sheetXml, (xml) => xml.replace("<v>1</v>", "<v>1abc</v>")));
  await rejects(preview(invalidNumber), 400, /A2.*безбеден цел број/);
  const duplicateValue = editXlsx(fixture([["Телефон"], [1]]), (part) =>
    part(sheetXml, (xml) => xml.replace("<v>1</v>", "<v>1</v><v>2</v>")));
  await rejects(preview(duplicateValue), 415, /оштетена/);

  const grid = utils.aoa_to_sheet([["Телефон", "Друго"], ["0002", null]]);
  grid.B2 = { t: "n", f: "1+1", v: 2 };
  assert.equal((await preview(syntheticXlsx([{ name: "Лист", grid }]))).samples[0].value, "0002");
});

test("XLSX ја проверува колоната и по стотиот примерок и одбива споени ќелии", async () => {
  const grid = utils.aoa_to_sheet([["Телефон"], ...Array.from({ length: 101 }, () => ["+0001"])]);
  grid.A102 = { t: "n", f: "1+1", v: 2 };
  await rejects(preview(syntheticXlsx([{ name: "Лист", grid }])), 400, /A102.*формула/);

  const merged = utils.aoa_to_sheet([["Телефон", "Друго"], ["0001", "а"], ["0002", "б"]]);
  merged["!merges"] = [utils.decode_range("A2:A3")];
  const mergedFile = syntheticXlsx([{ name: "Лист", grid: merged }]);
  await rejects(preview(mergedFile), 400, /колона.*споени/);
  assert.equal((await preview(mergedFile, { phoneColumn: 1 })).samples.length, 2);
  merged["!merges"] = [utils.decode_range("A1:B1")];
  await rejects(preview(syntheticXlsx([{ name: "Лист", grid: merged }]), { phoneColumn: null }), 400, /Заглавието.*споени/);
});

test("XLSX ги применува границите за редови, колони, текст и листови", async (proof) => {
  const rows = [["Телефон"], ...Array.from({ length: previewLimits.records }, (_, index) => ["+000" + index])];
  const result = await preview(fixture(rows));
  assert.equal(result.totalRecords, 20_000);
  assert.equal(result.samples.length, 100);
  assert.equal(result.samples.at(-1)?.recordNumber, 101);
  proof.diagnostic(`Excel редови ${result.totalRecords}, примероци ${result.samples.length}, последен Excel ред ${result.samples.at(-1)?.recordNumber}.`);
  await rejects(preview(fixture([...rows, ["0001"]])), 413, /20\.000/);

  const columns = Array(previewLimits.columns).fill("Име");
  assert.equal((await preview(fixture([columns]))).columns.length, 50);
  await rejects(preview(fixture([[...columns, "Вишок"]])), 413, /50 колони/);
  const text = "☎😀".repeat(previewLimits.fieldCharacters / 2);
  assert.equal((await preview(fixture([["Телефон"], [text]]))).samples[0].value, text);
  await rejects(preview(fixture([["Телефон", "Друго"], ["001", text + "0"]])), 413, /B2.*4\.096/);

  const sheets = Array.from({ length: xlsxLimits.sheets + 1 }, (_, index) => ({
    name: "Лист " + index, grid: utils.aoa_to_sheet([["Телефон"], ["001"]]),
  }));
  assert.equal((await previewXlsx(syntheticXlsx(sheets.slice(1)), { ...options, sheet: null, phoneColumn: null })).sheets.length, 10);
  await rejects(preview(syntheticXlsx(sheets)), 413, /10 работни листови/);
});

test("XLSX одбива лажни формати, оштетување, DTD, активни делови и повторени ZIP патеки", async () => {
  const file = fixture([["Телефон"], ["0001"]]);
  await rejects(preview(Buffer.from("Телефон\n0001")), 415, /оштетена/);
  await rejects(preview(file.subarray(0, file.length - 15)), 415, /оштетена/);
  const corrupt = Buffer.from(file);
  const offset = 30 + corrupt.readUInt16LE(26) + corrupt.readUInt16LE(28);
  corrupt[offset] ^= 1;
  await rejects(preview(corrupt), 415, /оштетена/);
  const encrypted = Buffer.from(file);
  const centralDirectory = encrypted.readUInt32LE(encrypted.length - 6);
  encrypted.writeUInt16LE(encrypted.readUInt16LE(6) | 1, 6);
  encrypted.writeUInt16LE(encrypted.readUInt16LE(centralDirectory + 8) | 1, centralDirectory + 8);
  await rejects(preview(encrypted), 415, /шифрирана/);
  const grid = utils.aoa_to_sheet([["Телефон"], ["001"]]);
  for (const bookType of ["xlsm", "xlsb", "xls"] as const) {
    await rejects(preview(syntheticXlsx([{ name: "Лист", grid }], { bookType })), 415, /XLSX/);
  }
  const dtd = editXlsx(file, (part) => part(sheetXml, (xml) =>
    xml.replace("?>", '?><!DOCTYPE worksheet [<!ENTITY x SYSTEM "file:///synthetic-secret">]>')));
  await rejects(preview(dtd), 415, /активна/);
  const active = editXlsx(file, (_part, add) => add("xl/vbaProject.bin", Buffer.from("synthetic")));
  await rejects(preview(active), 415, /активна/);
  const duplicate = editXlsx(file, (_part, add) => add("XL/WORKBOOK.XML", Buffer.from("<fake/>"), true));
  await rejects(preview(duplicate), 415, /оштетена/);
});

test("XLSX ги прекинува ZIP архивите над 1.000 записи или 50 MiB реална декомпресија", async () => {
  const file = fixture([["Телефон"], ["0001"]]);
  const manyEntries = editXlsx(file, (_part, add) => {
    for (let index = 0; index < xlsxLimits.zipEntries; index++) add(`xl/extra${index}.xml`, Buffer.from("<data/>"), true);
  });
  await rejects(preview(manyEntries), 413, /1\.000 записи/);
  const oversized = editXlsx(file, (_part, add) => {
    add("xl/expanded.xml", Buffer.alloc(xlsxLimits.expandedBytes + 1, 0x61));
  });
  assert.ok(oversized.length < previewLimits.fileBytes);
  await rejects(preview(oversized), 413, /Декомпресираната.*50 MiB/);
});

test("Паралелните XLSX прикачувања, откажувањето и рокот на работната нишка се ограничени", async (suite) => {
  const organization = { id: "synthetic", name: "Синтетичка клиника", kind: "CLINIC", created_at: "" } as const;
  const previewXlsxUpload = (request: Request) => previewContactImport(request, organization, "synthetic", "xlsx");
  const controls = Array.from({ length: xlsxLimits.concurrent }, () => new AbortController());
  const uploads = controls.map(({ signal }) => previewXlsxUpload(new Request("http://localhost", {
    method: "POST", signal, body: new ReadableStream(), duplex: "half",
    headers: { "Content-Type": "multipart/form-data; boundary=synthetic" },
  } as RequestInit & { duplex: "half" })));
  try {
    const busy = await previewXlsxUpload(new Request("http://localhost", { method: "POST" }));
    assert.ok(busy instanceof Response);
    assert.equal(busy.status, 429);
  } finally {
    controls.forEach((controller) => controller.abort());
    for (const result of await Promise.all(uploads)) {
      assert.ok(result instanceof Response);
      assert.match(await result.text(), /откажан/);
    }
  }
  const form = new FormData();
  form.set("file", new File([new Uint8Array(fixture([["Телефон"], ["0001"]]))], "synthetic.xlsx"));
  form.set("hasHeader", "true");
  const upload = () => previewXlsxUpload(new Request("http://localhost", { method: "POST", body: form }));
  const schedule = globalThis.setTimeout;
  const deadline = suite.mock.method(globalThis, "setTimeout", (callback: () => void, delay: number) =>
    schedule(callback, delay === xlsxLimits.processingMs ? 0 : delay));
  try {
    const timedOut = await upload();
    assert.ok(timedOut instanceof Response);
    assert.equal(timedOut.status, 503);
    assert.match(await timedOut.text(), /Истече времето за обработка/);
  } finally {
    deadline.mock.restore();
  }
  const result = await upload();
  assert.ok(!(result instanceof Response));
  assert.equal(result.format, "xlsx");
  assert.equal(result.sheets[0].name, "Лист");
});

test("XLSX зачувувањето го прекинува парсирањето на истиот рок пред трансакција", async (suite) => {
  const bytes = fixture([["Телефон"], ["+12025550123"]]);
  const input: PreparedContactImport = {
    organizationId: randomUUID(), operatorId: "synthetic", idempotencyKey: randomUUID(),
    sourceSha256: createHash("sha256").update(bytes).digest("hex"),
    source: { format: "xlsx", sheetIndex: 0, hasHeader: true, phoneColumn: 0 },
    policyVersion: phonePolicyVersion, libraryVersion: contactImportLibraryVersion,
    totalRecords: 1, counts: { excludedEmptyRecords: 0, emptyPhone: 0, invalid: 0, review: 0, uniqueValid: 1, duplicateValid: 0 },
    candidates: [{ normalizedPhone: "+12025550123", sourceRecordNumber: 2 }],
  };
  const env = { AUTH_SECRET: randomBytes(32).toString("base64url"), AUTH_BASE_URL: "http://127.0.0.1:3000", AUTH_LOCAL_HTTP: "true" };
  for (const [key, value] of Object.entries(env)) {
    const previous = process.env[key];
    suite.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
    process.env[key] = value;
  }
  const { receipt } = issueImportReceipt(input, contactImportFingerprint(input));
  const form = new FormData();
  form.set("file", new File([new Uint8Array(bytes)], "synthetic.xlsx"));
  form.set("receipt", receipt);
  const schedule = globalThis.setTimeout;
  suite.mock.method(globalThis, "setTimeout", (callback: () => void, delay: number) =>
    schedule(callback, delay === xlsxLimits.processingMs ? 0 : delay));
  const response = await confirmContactImport(new Request("http://localhost", { method: "POST", body: form }), input.organizationId, input.operatorId);
  assert.ok(response instanceof Response);
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.code, "TEMPORARILY_UNAVAILABLE");
  assert.match(body.message, /Истече времето за обработка/);
});
