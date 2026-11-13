import type { CountryCode, PhoneNumberType } from "libphonenumber-js/max";

export const previewLimits = {
  fileBytes: 5 * 1024 * 1024,
  multipartOverheadBytes: 64 * 1024,
  records: 20_000,
  columns: 50,
  fieldCharacters: 4_096,
  samples: 100,
} as const;
export const previewFileSize = `${previewLimits.fileBytes / (1024 * 1024)} MiB`;

export const xlsxLimits = {
  sheets: 10,
  zipEntries: 1_000,
  expandedBytes: 50 * 1024 * 1024,
  concurrent: 2,
  uploadMs: 15_000,
  processingMs: 12_000,
  workerHeapMiB: 256,
  xmlDepth: 128,
} as const;

export function formatPreviewCount(count: number) {
  return String(count).replace(/\B(?=(?:\d{3})+$)/g, ".");
}

export const csvDelimiters = { comma: ",", semicolon: ";", tab: "\t" } as const;
export type CsvDelimiter = keyof typeof csvDelimiters;

export type ImportSourceFormat = "csv" | "xlsx";
export type ImportSource = { hasHeader: boolean; phoneColumn: number } & (
  { format: "csv"; delimiter: CsvDelimiter } | { format: "xlsx"; sheetIndex: number }
);
export type ImportConfirmation = {
  receipt: string;
  idempotencyKey: string;
  expiresAt: number;
  source: ImportSource;
};
export type ContactImportHistoryEntry = {
  importId: string;
  createdAt: string;
  format: ImportSourceFormat;
  newContacts: number;
  existingContacts: number;
};
export type ContactImportResult = Omit<ContactImportHistoryEntry, "format"> & {
  organizationId: string;
  operatorId: string;
  totalRecords: number;
  counts: PhoneAnalysisCounts;
};
export type ImportSample = { recordNumber: number; value: string };

export const phonePolicyVersion = "phone-normalization-v1";
export type PhoneSourceKind = "text" | "number" | "empty";
type PhoneReason = { reason: string };
type ValidPhone = PhoneReason & {
  status: "VALID";
  reasonCode: "VALID_FORMAT";
  normalizedPhone: string;
  country?: CountryCode;
  phoneType?: PhoneNumberType;
};
type OtherPhone = PhoneReason & (
  { status: "EMPTY"; reasonCode: "EMPTY_VALUE" }
  | { status: "INVALID"; reasonCode: "INVALID_NUMBER" | "UNSUPPORTED_CONTENT" }
  | { status: "REVIEW"; reasonCode: "AMBIGUOUS_PREFIX" | "NUMERIC_SOURCE" | "DIGITS_CHANGED" }
);
export type PhoneNormalization = ValidPhone | OtherPhone;
export type PhoneAssessment = (ValidPhone & { duplicate: boolean; firstRecordNumber: number }) | (OtherPhone & { duplicate: false });
export type PhoneAnalysisCounts = {
  excludedEmptyRecords: number;
  emptyPhone: number;
  invalid: number;
  review: number;
  uniqueValid: number;
  duplicateValid: number;
};
export type AnalyzedPhoneSample<Sample extends ImportSample = ImportSample> = Sample & {
  sourceKind: PhoneSourceKind;
  phone: PhoneAssessment;
};

export type ImportPreview<Sample extends ImportSample = ImportSample> = {
  columns: { index: number; name: string | null }[];
  phoneColumn: number | null;
  totalRecords: number;
  skippedEmptyRecords: number;
  analysis: { policyVersion: typeof phonePolicyVersion; counts: PhoneAnalysisCounts } | null;
  samples: AnalyzedPhoneSample<Sample>[];
};

export type XlsxSheet = { index: number; name: string; hidden: boolean };
export type XlsxSample = ImportSample & (
  { cellKind: "text" | "empty" } | { cellKind: "number"; warning: "numeric-phone" }
);
export type XlsxPreview = { format: "xlsx"; sheets: XlsxSheet[] } & (
  { sheet: null; preview: null } | { sheet: XlsxSheet; preview: ImportPreview<XlsxSample> }
);
