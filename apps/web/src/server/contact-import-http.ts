import { createHash, randomUUID } from "node:crypto";
import { csvDelimiters, phonePolicyVersion } from "../import-preview.ts";
import type { CsvDelimiter, ImportSource, ImportSourceFormat, XlsxPreview } from "../import-preview.ts";
import type { Organization } from "../organizations.ts";
import {
  contactImportFingerprint, ContactImportError, contactImportLibraryVersion, expiredContactImport,
  listContactImports, readContactImport, savePreparedContactImport, uuidPattern,
} from "./contact-imports.ts";
import type { PreparedContactImport } from "./contact-imports.ts";
import { previewCsv } from "./csv-preview.ts";
import { ImportPreviewError } from "./import-preview-error.ts";
import { readImportFile, readImportForm, readPreviewSelection } from "./import-preview-upload.ts";
import { issueImportReceipt, readImportReceipt } from "./import-receipt.ts";
import type { VerifiedImportReceipt } from "./import-receipt.ts";
import type { PhoneCandidate } from "./phone-column-analysis.ts";
import { readBoundedUpload, readXlsxInWorker, withBoundedImportUpload } from "./xlsx-preview-runtime.ts";

type ReadingOptions = { hasHeader: boolean; phoneColumn: number | null } & (
  { format: "csv"; delimiter: CsvDelimiter } | { format: "xlsx"; sheetIndex: number | null }
);
type ImportIdentity = { organizationId: string; operatorId: string; idempotencyKey: string };

class ImportRequestError extends Error {
  readonly code: "INVALID_RECEIPT" | "PREVIEW_MISMATCH" | "INVALID_REQUEST";

  constructor(code: ImportRequestError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

const mismatch = () => new ImportRequestError("PREVIEW_MISMATCH", "Датотеката, поставките или анализата се разликуваат од потврдениот преглед. Потребен е нов преглед.");
const invalidReceipt = () => new ImportRequestError("INVALID_RECEIPT", "Потврдата за преглед не е валидна. Потребен е нов преглед.");

async function respond<T>(action: () => Promise<T>) {
  try {
    return await action();
  } catch (error) {
    if (error instanceof ImportRequestError) return Response.json({ code: error.code, message: error.message }, { status: error.code === "PREVIEW_MISMATCH" ? 409 : 400 });
    if (error instanceof ImportPreviewError) {
      const code = error.status === 503 || error.status === 429 ? "TEMPORARILY_UNAVAILABLE"
        : error.status === 413 ? "IMPORT_LIMIT_EXCEEDED" : "INVALID_REQUEST";
      return Response.json({ code, message: error.message }, { status: error.status });
    }
    if (!(error instanceof ContactImportError)) throw error;
    const status = {
      INVALID_INPUT: 400, ORGANIZATION_NOT_FOUND: 404, OPERATOR_NOT_FOUND: 401, IDEMPOTENCY_CONFLICT: 409,
      PREVIEW_EXPIRED: 410, OUTCOME_UNKNOWN: 503, DATABASE_ERROR: 503,
    }[error.code];
    const code = error.code === "DATABASE_ERROR" ? "TEMPORARILY_UNAVAILABLE" : error.code;
    const message = error.code === "DATABASE_ERROR" ? "Увозот моментално е недостапен. Обидете се повторно." : error.message;
    return Response.json({ code, message }, { status });
  }
}

async function prepareImport(
  file: File, options: ReadingOptions, signal: AbortSignal, identity: ImportIdentity, expected?: VerifiedImportReceipt,
) {
  const bytes = await file.arrayBuffer();
  const sourceSha256 = createHash("sha256").update(new Uint8Array(bytes)).digest("hex");
  if (expected && (
    expected.sourceSha256 !== sourceSha256 || expected.policyVersion !== phonePolicyVersion
    || expected.libraryVersion !== contactImportLibraryVersion || expected.source.format !== options.format
    || expected.source.hasHeader !== options.hasHeader || expected.source.phoneColumn !== options.phoneColumn
    || (expected.source.format === "csv" && options.format === "csv" && expected.source.delimiter !== options.delimiter)
    || (expected.source.format === "xlsx" && options.format === "xlsx" && expected.source.sheetIndex !== options.sheetIndex)
  )) throw mismatch();

  let result: { format: "csv"; preview: ReturnType<typeof previewCsv> } | XlsxPreview;
  let candidates: PhoneCandidate[] = [];
  if (options.format === "csv") {
    result = { format: "csv", preview: previewCsv(new Uint8Array(bytes), options, (candidate) => candidates.push(candidate)) };
  } else {
    ({ result, candidates } = await readXlsxInWorker(bytes, {
      hasHeader: options.hasHeader, phoneColumn: options.phoneColumn, sheet: options.sheetIndex,
    }, signal));
  }
  const { preview } = result;
  const counts = preview?.analysis?.counts;
  const { hasHeader, phoneColumn } = options;
  const source: ImportSource | null = phoneColumn === null ? null : options.format === "csv"
    ? { format: options.format, hasHeader, phoneColumn, delimiter: options.delimiter }
    : options.sheetIndex === null ? null : { format: options.format, hasHeader, phoneColumn, sheetIndex: options.sheetIndex };
  if (!preview || !counts?.uniqueValid || !source) {
    if (expected) throw mismatch();
    return { result };
  }
  const prepared: PreparedContactImport = {
    ...identity, sourceSha256, source, policyVersion: phonePolicyVersion, libraryVersion: contactImportLibraryVersion,
    totalRecords: preview.totalRecords, counts, candidates,
  };
  const fingerprint = contactImportFingerprint(prepared);
  if (expected && fingerprint !== expected.fingerprint) throw mismatch();
  return { result, prepared, fingerprint };
}

function readOptions(format: ImportSourceFormat, form: FormData): ReadingOptions {
  const selection = readPreviewSelection(form);
  if (format === "csv") {
    const delimiter = form.get("delimiter");
    if (typeof delimiter !== "string" || !Object.hasOwn(csvDelimiters, delimiter)) {
      throw new ImportPreviewError("Изберете поддржан разделувач.");
    }
    return { format, ...selection, delimiter: delimiter as CsvDelimiter };
  }
  const index = form.get("sheet");
  if (index !== null && (typeof index !== "string" || !/^(0|[1-9][0-9]?)$/.test(index))) {
    throw new ImportPreviewError("Изберете постоечки работен лист.");
  }
  return { format, ...selection, sheetIndex: index === null ? null : Number(index) };
}

export function previewContactImport(request: Request, { id, name, kind }: Organization, operatorId: string, format: ImportSourceFormat) {
  return respond(async () => {
    const preview = async (signal: AbortSignal) => {
      const fields = ["file", "receipt", "hasHeader", "phoneColumn", format === "csv" ? "delimiter" : "sheet"];
      const form = await readBoundedUpload(request, signal, () => readImportForm(request, format.toUpperCase(), fields, signal));
      const oldReceipt = form.has("receipt") ? readImportReceipt(form.get("receipt"), id, operatorId) : undefined;
      if (oldReceipt === null) throw invalidReceipt();
      const options = readOptions(format, form);
      const file = readImportFile(form, format);
      const identity = { organizationId: id, operatorId, idempotencyKey: oldReceipt?.idempotencyKey ?? randomUUID() };
      const { result, prepared, fingerprint } = await prepareImport(file, options, request.signal, identity, oldReceipt);
      const confirmation = prepared && fingerprint ? issueImportReceipt(prepared, fingerprint) : undefined;
      return { code: "IMPORT_PREVIEW", message: "Прегледот е подготвен", organization: { id, name, kind }, ...result, confirmation };
    };
    return format === "xlsx" ? withBoundedImportUpload(request, preview) : preview(request.signal);
  });
}

export function confirmContactImport(request: Request, organizationId: string, operatorId: string) {
  return respond(async () => {
    const { prepared, expiresAt } = await withBoundedImportUpload(request, async (signal) => {
      const form = await readBoundedUpload(request, signal, () => readImportForm(request, "CSV/XLSX", ["file", "receipt"], signal));
      const receipt = readImportReceipt(form.get("receipt"), organizationId, operatorId);
      if (!receipt) throw invalidReceipt();
      if (Date.now() >= receipt.expiresAt) throw expiredContactImport();
      const file = readImportFile(form, receipt.source.format);
      const identity = { organizationId, operatorId, idempotencyKey: receipt.idempotencyKey };
      const { prepared } = await prepareImport(file, receipt.source, request.signal, identity, receipt);
      if (!prepared) throw mismatch();
      return { prepared, expiresAt: receipt.expiresAt };
    });
    if (request.signal.aborted) throw new ImportPreviewError("Барањето е откажано.");
    const result = await savePreparedContactImport(prepared, undefined, expiresAt);
    return { code: "IMPORT_SAVED", message: "Увозот е зачуван", result };
  });
}

export function getContactImports(request: Request, organizationId: string, operatorId: string) {
  return respond(async () => {
    const params = [...new URL(request.url).searchParams];
    if (params.length === 0) {
      return { code: "IMPORT_HISTORY", message: "Последни увози", imports: await listContactImports(organizationId) };
    }
    const [[name, key]] = params;
    if (params.length !== 1 || name !== "idempotencyKey" || !uuidPattern.test(key)) {
      throw new ImportRequestError("INVALID_REQUEST", "Клучот за проверка на исходот не е валиден.");
    }
    const result = await readContactImport(organizationId, operatorId, key);
    return result ? { code: "IMPORT_SAVED", message: "Увозот е зачуван", result }
      : { code: "PENDING", message: "Сè уште нема потврден резултат" };
  });
}
