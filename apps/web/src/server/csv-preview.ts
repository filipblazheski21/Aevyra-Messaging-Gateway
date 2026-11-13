import { CsvError, parse } from "csv-parse/sync";
import { csvDelimiters, formatPreviewCount, previewFileSize, previewLimits } from "../import-preview.ts";
import type { CsvDelimiter, ImportPreview } from "../import-preview.ts";
import { ImportPreviewError as CsvPreviewError } from "./import-preview-error.ts";
import { createPhoneColumnAnalysis } from "./phone-column-analysis.ts";
import type { CollectPhoneCandidate } from "./phone-column-analysis.ts";

export { CsvPreviewError };

export function previewCsv(file: Uint8Array, options: {
  delimiter: CsvDelimiter;
  hasHeader: boolean;
  phoneColumn: number | null;
}, collect?: CollectPhoneCandidate): ImportPreview {
  if (file.byteLength > previewLimits.fileBytes) {
    throw new CsvPreviewError(`CSV датотеката надминува ${previewFileSize}.`, 413);
  }
  const { delimiter, hasHeader, phoneColumn } = options;
  if (phoneColumn !== null && (!Number.isInteger(phoneColumn) || phoneColumn < 0)) {
    throw new CsvPreviewError("Изберете постоечка телефонска колона.");
  }

  const encodingError = () => new CsvPreviewError("Зачувајте ја CSV датотеката со UTF-8 кодирање.", 415);
  let csv: string;
  try {
    csv = new TextDecoder("utf-8", { fatal: true }).decode(file);
  } catch {
    throw encodingError();
  }
  if (csv.includes("\0")) throw encodingError();

  const columns: ImportPreview["columns"] = [];
  const analysis = phoneColumn === null ? null : createPhoneColumnAnalysis(collect);
  let recordNumber = 0;
  let totalRecords = 0;
  let skippedEmptyRecords = 0;

  try {
    parse(csv, {
      delimiter: csvDelimiters[delimiter],
      record_delimiter: ["\r\n", "\n"],
      raw: true,
      // Check widths ourselves so a bare blank line still counts as a record.
      relax_column_count: true,
      max_record_size: previewLimits.columns * previewLimits.fieldCharacters * 4,
      cast(value, { index }) {
        if (index >= previewLimits.columns) {
          throw new CsvPreviewError(`CSV датотеката може да има најмногу ${previewLimits.columns} колони.`, 413);
        }
        if (value.length > previewLimits.fieldCharacters && [...value].length > previewLimits.fieldCharacters) {
          throw new CsvPreviewError(`Едно CSV поле може да има најмногу ${formatPreviewCount(previewLimits.fieldCharacters)} знаци.`, 413);
        }
        return value;
      },
      on_record(row) {
        // The raw option wraps the record even though the array overload omits it.
        const { record, raw } = row as unknown as { record: string[]; raw: string };
        recordNumber++;
        const header = hasHeader && recordNumber === 1;
        // csv-parse includes the first byte of the record delimiter in raw.
        const blankLine = record[0] === "" && (raw === "\n" || raw === "\r");
        if (header || (!blankLine && columns.length === 0)) {
          columns.push(...record.map((value, index) => ({ index, name: header ? value : null })));
          if (phoneColumn !== null && phoneColumn >= columns.length) {
            throw new CsvPreviewError("Изберете постоечка телефонска колона.");
          }
        }
        if (header) return null;
        if (++totalRecords > previewLimits.records) {
          throw new CsvPreviewError(`CSV датотеката може да има најмногу ${formatPreviewCount(previewLimits.records)} податочни записи.`, 413);
        }
        if (!blankLine && record.length !== columns.length) {
          throw new CsvPreviewError(`CSV записот ${recordNumber} има различен број полиња.`);
        }
        if (record.every((value) => value === "")) {
          skippedEmptyRecords++;
        } else if (phoneColumn !== null) {
          analysis?.add({ recordNumber, value: record[phoneColumn] }, "text");
        }
        return null;
      },
    });
  } catch (error) {
    if (!(error instanceof CsvError)) throw error;
    if (error.code === "CSV_MAX_RECORD_SIZE") {
      throw new CsvPreviewError("Еден CSV запис ги надминува дозволените граници.", 413);
    }
    throw new CsvPreviewError("CSV датотеката не е правилно оформена. Проверете ги наводниците и разделувачот.");
  }
  if (columns.length === 0) {
    throw new CsvPreviewError("CSV датотеката не содржи колони.");
  }
  return {
    columns, phoneColumn, totalRecords, skippedEmptyRecords,
    ...(analysis?.finish(skippedEmptyRecords) ?? { analysis: null, samples: [] }),
  };
}
