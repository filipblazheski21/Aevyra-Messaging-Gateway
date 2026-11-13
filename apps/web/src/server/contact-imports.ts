import { createHash } from "node:crypto";
import phoneLibrary from "libphonenumber-js/package.json" with { type: "json" };
import type pg from "pg";
import { csvDelimiters, phonePolicyVersion, previewLimits, xlsxLimits } from "../import-preview.ts";
import type { ContactImportHistoryEntry, ContactImportResult, CsvDelimiter, ImportSource, PhoneAnalysisCounts } from "../import-preview.ts";
import { getRuntimeAuth } from "./auth.ts";
import type { PhoneCandidate } from "./phone-column-analysis.ts";
import { normalizePhone } from "./phone-normalization.ts";

export const contactImportLibraryVersion = phoneLibrary.version;

export type PreparedContactImport = {
  organizationId: string;
  operatorId: string;
  idempotencyKey: string;
  sourceSha256: string;
  source: ImportSource;
  policyVersion: typeof phonePolicyVersion;
  libraryVersion: string;
  totalRecords: number;
  counts: PhoneAnalysisCounts;
  candidates: readonly PhoneCandidate[];
};

export class ContactImportError extends Error {
  readonly code: "INVALID_INPUT" | "ORGANIZATION_NOT_FOUND" | "OPERATOR_NOT_FOUND" | "IDEMPOTENCY_CONFLICT" | "DATABASE_ERROR" | "OUTCOME_UNKNOWN" | "PREVIEW_EXPIRED";

  constructor(code: ContactImportError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

const invalid = (message: string) => new ContactImportError("INVALID_INPUT", message);
const databaseError = () => new ContactImportError("DATABASE_ERROR", "Зачувувањето на увозот не успеа.");
export const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function fields<Key extends string>(value: unknown, keys: readonly Key[], message: string): Record<Key, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw invalid(message);
  }
  return value as Record<Key, unknown>;
}

function uuid(value: unknown, message: string) {
  if (typeof value !== "string" || !uuidPattern.test(value)) throw invalid(message);
  return value.toLowerCase();
}

function integer(value: unknown, min: number, max: number, message: string) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw invalid(message);
  return value;
}

export function readImportSource(value: unknown): ImportSource {
  const message = "Форматот или поставките за читање не се поддржани.";
  if (!value || typeof value !== "object" || !("format" in value)) throw invalid(message);
  const { format } = value;
  if (format !== "csv" && format !== "xlsx") throw invalid(message);
  const commonKeys = ["format", "hasHeader", "phoneColumn"] as const;
  const settings = fields(value, [...commonKeys, format === "csv" ? "delimiter" : "sheetIndex"], message);
  if (typeof settings.hasHeader !== "boolean") throw invalid(message);
  const { hasHeader } = settings;
  const phoneColumn = integer(settings.phoneColumn, 0, previewLimits.columns - 1, message);
  if (format === "csv") {
    if (typeof settings.delimiter !== "string" || !Object.hasOwn(csvDelimiters, settings.delimiter)) throw invalid(message);
    return { format, hasHeader, phoneColumn, delimiter: settings.delimiter as CsvDelimiter };
  }
  return { format, hasHeader, phoneColumn, sheetIndex: integer(settings.sheetIndex, 0, xlsxLimits.sheets - 1, message) };
}

const countKeys = ["excludedEmptyRecords", "emptyPhone", "invalid", "review", "uniqueValid", "duplicateValid"] as const;

function validateImport(value: unknown): PreparedContactImport {
  const input = fields(value, [
    "organizationId", "operatorId", "idempotencyKey", "sourceSha256", "source",
    "policyVersion", "libraryVersion", "totalRecords", "counts", "candidates",
  ], "Подготвениот увоз содржи невалидни или недозволени полиња.");
  const organizationId = uuid(input.organizationId, "Организацијата мора да има валиден UUID.");
  const idempotencyKey = uuid(input.idempotencyKey, "Клучот за повторување мора да биде валиден UUID.");
  const { operatorId, sourceSha256 } = input;
  if (typeof operatorId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(operatorId)) throw invalid("Идентификаторот на операторот не е валиден.");
  if (typeof sourceSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(sourceSha256)) throw invalid("Изворниот SHA-256 не е валиден.");
  if (input.policyVersion !== phonePolicyVersion || input.libraryVersion !== contactImportLibraryVersion) {
    throw invalid("Верзијата на нормализацијата не е поддржана.");
  }
  const source = readImportSource(input.source);
  const countError = "Бројачите на увозот не се усогласени.";
  const totalRecords = integer(input.totalRecords, 1, previewLimits.records, countError);
  const rawCounts = fields(input.counts, countKeys, countError);
  const counts = {} as PhoneAnalysisCounts;
  for (const key of countKeys) counts[key] = integer(rawCounts[key], 0, totalRecords, countError);
  if (Object.values(counts).reduce((sum, count) => sum + count, 0) !== totalRecords) throw invalid(countError);
  if (counts.uniqueValid === 0) throw invalid("За зачувување е потребен барем еден единствен валиден контакт.");
  if (!Array.isArray(input.candidates) || input.candidates.length !== counts.uniqueValid) {
    throw invalid("Бројот на кандидати мора да одговара на бројот единствени валидни записи.");
  }

  const seenPhones = new Set<string>();
  const seenRecords = new Set<number>();
  const header = Number(source.hasHeader);
  const candidates: PhoneCandidate[] = [];
  for (const item of input.candidates as unknown[]) {
    const candidate = fields(item, ["normalizedPhone", "sourceRecordNumber"], "Кандидатот содржи недозволени полиња.");
    const { normalizedPhone } = candidate;
    const sourceRecordNumber = integer(candidate.sourceRecordNumber, 1 + header, totalRecords + header, "Изворната позиција на кандидатот не е валидна.");
    if (typeof normalizedPhone !== "string" || !/^\+[1-9][0-9]{1,14}$/.test(normalizedPhone)) {
      throw invalid("Кандидатот мора да има канонски E.164 број.");
    }
    const phone = normalizePhone(normalizedPhone, "text");
    if (phone.status !== "VALID" || phone.normalizedPhone !== normalizedPhone) throw invalid("Кандидатот нема валиден канонски E.164 број.");
    if (seenPhones.has(normalizedPhone) || seenRecords.has(sourceRecordNumber)) {
      throw invalid("Кандидатите мора да имаат единствени броеви и изворни позиции.");
    }
    seenPhones.add(normalizedPhone);
    seenRecords.add(sourceRecordNumber);
    candidates.push({ normalizedPhone, sourceRecordNumber });
  }
  candidates.sort((left, right) => left.sourceRecordNumber - right.sourceRecordNumber);
  return {
    organizationId, operatorId, idempotencyKey, sourceSha256: sourceSha256.toLowerCase(), source,
    policyVersion: phonePolicyVersion, libraryVersion: contactImportLibraryVersion, totalRecords, counts, candidates,
  };
}

type ImportRow = {
  id: string; organization_id: string; operator_id: string; created_at: Date; request_fingerprint: string;
  total_records: number; excluded_empty_records: number; empty_phone: number; invalid: number;
  review: number; unique_valid: number; duplicate_valid: number; new_contacts: number; existing_contacts: number;
};
const summaryColumns = `id, organization_id, operator_id, created_at, request_fingerprint,
  total_records, excluded_empty_records, empty_phone, invalid, review, unique_valid, duplicate_valid, new_contacts, existing_contacts`;

function summarize(row: ImportRow): ContactImportResult {
  return {
    importId: row.id, organizationId: row.organization_id, operatorId: row.operator_id, createdAt: row.created_at.toISOString(),
    totalRecords: row.total_records,
    counts: {
      excludedEmptyRecords: row.excluded_empty_records, emptyPhone: row.empty_phone, invalid: row.invalid,
      review: row.review, uniqueValid: row.unique_valid, duplicateValid: row.duplicate_valid,
    },
    newContacts: row.new_contacts, existingContacts: row.existing_contacts,
  };
}

export async function readContactImport(organizationId: string, operatorId: string, key: string) {
  const { rows: [row] } = await getRuntimeAuth().pool.query<ImportRow>(`
    SELECT ${summaryColumns} FROM aevyra.contact_imports
    WHERE organization_id = $1 AND operator_id = $2 AND idempotency_key = $3
  `, [organizationId, operatorId, key]);
  return row ? summarize(row) : null;
}

export async function listContactImports(organizationId: string): Promise<ContactImportHistoryEntry[]> {
  const { rows } = await getRuntimeAuth().pool.query<{
    id: string; created_at: Date; source_format: ContactImportHistoryEntry["format"];
    new_contacts: number; existing_contacts: number;
  }>(`
    SELECT id, created_at, source_format, new_contacts, existing_contacts
    FROM aevyra.contact_imports WHERE organization_id = $1 ORDER BY created_at DESC, id DESC LIMIT 20
  `, [organizationId]);
  return rows.map((row) => ({
    importId: row.id, createdAt: row.created_at.toISOString(), format: row.source_format,
    newContacts: row.new_contacts, existingContacts: row.existing_contacts,
  }));
}

export const expiredContactImport = () => new ContactImportError("PREVIEW_EXPIRED", "Прегледот е истечен. Обновете го со истата датотека.");

async function persistImport(client: pg.PoolClient, input: PreparedContactImport, fingerprint: string, startBefore?: number) {
  const { organizationId, operatorId, idempotencyKey, source, counts, candidates } = input;
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('aevyra.contact-import:' || $1::text, 0))", [organizationId]);

  const { rows: [identity] } = await client.query<{ organization_exists: boolean; operator_exists: boolean }>(`
    SELECT EXISTS (SELECT FROM aevyra.organizations WHERE id = $1) AS organization_exists,
           EXISTS (SELECT FROM aevyra_auth."user" WHERE id = $2) AS operator_exists
  `, [organizationId, operatorId]);
  if (!identity.organization_exists) throw new ContactImportError("ORGANIZATION_NOT_FOUND", "Организацијата не е пронајдена.");
  if (!identity.operator_exists) throw new ContactImportError("OPERATOR_NOT_FOUND", "Внатрешниот оператор не е пронајден.");

  const { rows: [previous] } = await client.query<ImportRow>(`
    SELECT ${summaryColumns} FROM aevyra.contact_imports WHERE organization_id = $1 AND idempotency_key = $2
  `, [organizationId, idempotencyKey]);
  if (previous) {
    if (previous.request_fingerprint !== fingerprint) {
      throw new ContactImportError("IDEMPOTENCY_CONFLICT", "Клучот за повторување веќе е употребен за различен увоз.");
    }
    return summarize(previous);
  }
  if (startBefore !== undefined && Date.now() >= startBefore) throw expiredContactImport();

  const phones = candidates.map(({ normalizedPhone }) => normalizedPhone);
  const inserted = await client.query(`
    INSERT INTO aevyra.contacts (organization_id, normalized_phone)
    SELECT $1::uuid, phone FROM unnest($2::text[]) AS candidate(phone)
    ON CONFLICT (organization_id, normalized_phone) DO NOTHING
  `, [organizationId, phones]);
  const newContacts = inserted.rowCount;
  if (newContacts === null) throw databaseError();

  const { rows: [row] } = await client.query<ImportRow>(`
    INSERT INTO aevyra.contact_imports (
      organization_id, operator_id, idempotency_key, request_fingerprint, source_sha256,
      source_format, delimiter, sheet_index, has_header, phone_column, policy_version, library_version,
      total_records, excluded_empty_records, empty_phone, invalid, review, unique_valid, duplicate_valid, new_contacts, existing_contacts
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21
    ) RETURNING ${summaryColumns}
  `, [
    organizationId, operatorId, idempotencyKey, fingerprint, input.sourceSha256,
    source.format, source.format === "csv" ? source.delimiter : null, source.format === "xlsx" ? source.sheetIndex : null,
    source.hasHeader, source.phoneColumn, input.policyVersion, input.libraryVersion,
    input.totalRecords, counts.excludedEmptyRecords, counts.emptyPhone, counts.invalid, counts.review,
    counts.uniqueValid, counts.duplicateValid, newContacts, candidates.length - newContacts,
  ]);
  if (!row) throw databaseError();

  const links = await client.query(`
    INSERT INTO aevyra.contact_import_contacts (organization_id, import_id, contact_id, source_record_number)
    SELECT $1::uuid, $2::uuid, contact.id, candidate.record_number
    FROM unnest($3::text[], $4::int[]) AS candidate(phone, record_number)
    JOIN aevyra.contacts AS contact ON contact.organization_id = $1 AND contact.normalized_phone = candidate.phone
  `, [organizationId, row.id, phones, candidates.map(({ sourceRecordNumber }) => sourceRecordNumber)]);
  if (links.rowCount !== counts.uniqueValid) throw databaseError();
  return summarize(row);
}

function canonicalImport(prepared: PreparedContactImport) {
  const { idempotencyKey, ...content } = validateImport(prepared);
  const fingerprint = createHash("sha256").update(JSON.stringify({ version: 1, ...content })).digest("hex");
  return { input: { idempotencyKey, ...content }, fingerprint };
}

export function contactImportFingerprint(prepared: PreparedContactImport) {
  return canonicalImport(prepared).fingerprint;
}

// Accept only server-prepared input. The default pool is the application's restricted LOGIN connection.
export async function savePreparedContactImport(prepared: PreparedContactImport, pool?: pg.Pool, startBefore?: number) {
  const { input, fingerprint } = canonicalImport(prepared);
  const connectionPool = pool ?? getRuntimeAuth().pool;
  const client = await connectionPool.connect().catch(() => { throw databaseError(); });
  let discard = false;
  let committing = false;
  const connectionFailed = () => { discard = true; };
  client.on("error", connectionFailed);
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    const result = await persistImport(client, input, fingerprint, startBefore);
    committing = true;
    const committed = await client.query("COMMIT");
    committing = false;
    if (committed.command !== "COMMIT") throw databaseError();
    return result;
  } catch (error) {
    if (committing) {
      discard = true;
      throw new ContactImportError("OUTCOME_UNKNOWN", "Исходот на увозот е непознат. Повторете со истиот клуч за повторување.");
    }
    if (!discard) {
      try {
        await client.query("ROLLBACK");
      } catch {
        discard = true;
      }
    }
    if (error instanceof ContactImportError) throw error;
    throw databaseError();
  } finally {
    client.removeListener("error", connectionFailed);
    client.release(discard);
  }
}
