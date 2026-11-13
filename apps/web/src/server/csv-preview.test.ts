import assert from "node:assert/strict";
import test from "node:test";
import { previewLimits } from "../import-preview.ts";
import type { ImportPreview } from "../import-preview.ts";
import { CsvPreviewError, previewCsv } from "./csv-preview.ts";

type Options = Parameters<typeof previewCsv>[1];
const encode = (csv: string) => new TextEncoder().encode(csv);
const read = (csv: string, options: Partial<Options> = {}) =>
  previewCsv(encode(csv), { delimiter: "comma", hasHeader: true, phoneColumn: 0, ...options });
const rejects = (readFile: () => unknown, status: CsvPreviewError["status"], message: RegExp) =>
  assert.throws(readFile, (error) =>
    error instanceof CsvPreviewError && error.status === status && message.test(error.message));
const sourceSamples = (preview: ImportPreview) => preview.samples.map(({ recordNumber, value }) => ({ recordNumber, value }));

test("CSV разделувачи, UTF-8 со и без BOM, кирилица и CRLF/LF", () => {
  for (const [delimiter, separator, newline, bom] of [
    ["comma", ",", "\r\n", "\uFEFF"],
    ["semicolon", ";", "\n", ""],
    ["tab", "\t", "\r\n", ""],
  ] as const) {
    const csv = `${bom}Телефон${separator}Белешка${newline}+000123${separator}Кирилица\n001234${separator}Текст`;
    const preview = read(csv, { delimiter });
    assert.deepEqual({
      columns: preview.columns, phoneColumn: preview.phoneColumn, totalRecords: preview.totalRecords,
      skippedEmptyRecords: preview.skippedEmptyRecords, samples: sourceSamples(preview),
    }, {
      columns: [{ index: 0, name: "Телефон" }, { index: 1, name: "Белешка" }],
      phoneColumn: 0, totalRecords: 2, skippedEmptyRecords: 0,
      samples: [{ recordNumber: 2, value: "+000123" }, { recordNumber: 3, value: "001234" }],
    });
  }
});

test("Наводници, внатрешен разделувач и повеќелиниски полиња се читаат како еден логички запис", () => {
  const preview = read('Телефон,Белешка\r\n"+0001,""A""\r\n0002","Прв\nвтор"\r\n 0012 ,друг');
  assert.deepEqual(sourceSamples(preview), [
    { recordNumber: 2, value: '+0001,"A"\r\n0002' },
    { recordNumber: 3, value: " 0012 " },
  ]);
  assert.equal(preview.totalRecords, 2);
  assert.ok(!JSON.stringify(preview).includes("Прв"));
});

test("Празни и повторени имиња се одделни по индекс, а заглавието е опционално", () => {
  const csv = "Телефон,,Телефон\n001,002,003";
  const columns = read(csv, { phoneColumn: null });
  assert.deepEqual(columns.columns, [
    { index: 0, name: "Телефон" }, { index: 1, name: "" }, { index: 2, name: "Телефон" },
  ]);
  assert.deepEqual(columns.samples, []);
  assert.equal(columns.analysis, null);
  assert.deepEqual(sourceSamples(read(csv, { phoneColumn: 2 })), [{ recordNumber: 2, value: "003" }]);
  const noHeader = read("\n001,002,003\n0004,005,006", { hasHeader: false, phoneColumn: 1 });
  assert.deepEqual(noHeader.columns, [{ index: 0, name: null }, { index: 1, name: null }, { index: 2, name: null }]);
  assert.deepEqual(sourceSamples(noHeader), [{ recordNumber: 2, value: "002" }, { recordNumber: 3, value: "005" }]);
  assert.equal(noHeader.skippedEmptyRecords, 1);
  assert.equal(read("Телефон").totalRecords, 0);
});

test("Целосно празните записи се бројат, а празните и белите телефонски полиња остануваат", () => {
  const result = read('Телефон,Белешка\r\n,содржина\r\n\r\n"",""\r\n,\r\n ,\r\n001,крај\r\n');
  assert.equal(result.totalRecords, 6);
  assert.equal(result.skippedEmptyRecords, 3);
  assert.deepEqual(sourceSamples(result), [
    { recordNumber: 2, value: "" }, { recordNumber: 6, value: " " }, { recordNumber: 7, value: "001" },
  ]);
  assert.deepEqual(result.samples.map(({ phone }) => phone.status), ["EMPTY", "EMPTY", "INVALID"]);
});

test("Неважечки наводници, ширина, кодирање и избор на колона даваат локализирани грешки", () => {
  for (const csv of ['Телефон\n"001', 'Телефон\n00"1', 'Телефон\n"001"потоа']) {
    rejects(() => read(csv), 400, /наводниците/);
  }
  for (const csv of ['Телефон,Вид\n001', 'Телефон,Вид\n""', 'Телефон,Вид\n001,а,б', 'Телефон\n1,2']) {
    rejects(() => read(csv, { phoneColumn: null }), 400, /различен број полиња/);
  }
  for (const file of [Buffer.from([0xc3, 0x28]), Buffer.from([0xff, 0xfe, 0x41, 0]), Buffer.from("A\0B\0")]) {
    rejects(() => previewCsv(file, { delimiter: "comma", hasHeader: true, phoneColumn: 0 }), 415, /UTF-8/);
  }
  for (const phoneColumn of [-1, 0.5, 1]) {
    rejects(() => read("Телефон\n001", { phoneColumn }), 400, /телефонска колона/);
  }
  rejects(() => read(""), 400, /колони/);
});

test("Содржина што личи на HTML, формула или научна нотација останува текст", () => {
  const values = ["<img src=x onerror=alert(1)>", "=1+1", "+001", "00012", "1E+13"];
  assert.deepEqual(read(["Телефон", ...values].join("\n")).samples.map(({ value }) => value), values);
});

test("Точните граници за бајти, колони и знаци се прифатени, а надминувањето е одбиено", () => {
  const { fileBytes, columns, fieldCharacters } = previewLimits;
  const row = "0".repeat(fieldCharacters) + "\n";
  const remainder = fileBytes % row.length;
  const exact = row.repeat(Math.floor(fileBytes / row.length)) + "0".repeat(remainder);
  assert.equal(Buffer.byteLength(exact), fileBytes);
  assert.ok(read(exact).samples.length > 0);
  rejects(() => read(exact + "\n"), 413, /5 MiB/);

  const columnNames = Array(columns).fill("Телефон").join(",");
  const field = "☎😀".repeat(fieldCharacters / 2);
  const wideRow = Array(columns).fill(field).join(",");
  assert.deepEqual(sourceSamples(read(`${columnNames}\n${wideRow}`, { phoneColumn: columns - 1 })), [{ recordNumber: 2, value: field }]);
  rejects(() => read(columnNames + ",уште"), 413, /50 колони/);
  rejects(() => read("Телефон\n" + field + "0"), 413, /4\.096 знаци/);
});

test("20.000 податочни записи се бројат, со најмногу 100 примероци и без делумен успех", () => {
  const csv = "Телефон,Белешка\n" + "0001,синтетички запис\n".repeat(previewLimits.records);
  const preview = read(csv);
  assert.equal(preview.totalRecords, 20_000);
  assert.equal(preview.samples.length, 100);
  assert.deepEqual(sourceSamples(preview).at(-1), { recordNumber: 101, value: "0001" });
  rejects(() => read(csv + "\n"), 413, /20\.000/);
  rejects(() => read(csv + '"незатворено'), 400, /наводниците/);
});
