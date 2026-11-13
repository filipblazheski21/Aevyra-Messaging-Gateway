import type {
  ContactBasisChannel,
  ContactBasisCurrentState,
  ContactBasisEvent,
  ContactBasisPurpose,
  ContactBasisType,
  ContactBasisWriteResult,
} from "./contact-bases.ts";
import type { ContactSuppression } from "./contact-suppressions.ts";

export type ContactBasisWriteRequest = {
  eventType: "RECORD";
  purpose: ContactBasisPurpose;
  channel: ContactBasisChannel;
  expectedRevision: number;
  idempotencyKey: string;
  basisType: ContactBasisType;
  reference: string;
  expiresAt: string | null;
} | {
  eventType: "WITHDRAW";
  purpose: ContactBasisPurpose;
  channel: ContactBasisChannel;
  expectedRevision: number;
  idempotencyKey: string;
  reference?: string;
};

export type ContactBasisOperationScope = {
  operatorId: string;
  organizationId: string;
  contactId: string;
  purpose: ContactBasisPurpose;
  channel: ContactBasisChannel;
};

export type PendingContactBasisOperation = ContactBasisOperationScope & {
  version: 1;
  createdAt: string;
  request: ContactBasisWriteRequest;
};

const uuidPattern = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const operatorPattern = /^[A-Za-z0-9_-]{1,128}$/;
const localDateTimePattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const skopjeParts = new Intl.DateTimeFormat("en-CA-u-nu-latn", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
  timeZone: "Europe/Skopje",
});

function keyPart(value: string) {
  return encodeURIComponent(value);
}

export function contactBasisOperationStorageKey(scope: ContactBasisOperationScope) {
  return [
    "aevyra.contact-basis-operation.v1",
    scope.operatorId,
    scope.organizationId,
    scope.contactId,
    scope.purpose,
    scope.channel,
  ].map(keyPart).join(":");
}

function isWriteRequest(value: unknown, scope: ContactBasisOperationScope): value is ContactBasisWriteRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  if (request.purpose !== scope.purpose || request.channel !== scope.channel
      || !Number.isSafeInteger(request.expectedRevision) || Number(request.expectedRevision) < 0
      || typeof request.idempotencyKey !== "string" || !uuidPattern.test(request.idempotencyKey)) return false;
  if (request.eventType === "RECORD") {
    return (request.basisType === "CONSENT" || request.basisType === "DOCUMENTED_BASIS")
      && typeof request.reference === "string" && request.reference.length > 0 && request.reference.length <= 250
      && request.reference.isWellFormed() && !request.reference.includes("\0")
      && (request.expiresAt === null || isTimestamp(request.expiresAt))
      && Object.keys(request).every((key) => [
        "eventType", "purpose", "channel", "expectedRevision", "idempotencyKey", "basisType", "reference", "expiresAt",
      ].includes(key));
  }
  if (request.eventType === "WITHDRAW") {
    return (request.reference === undefined || (typeof request.reference === "string" && request.reference.length <= 250
      && request.reference.isWellFormed() && !request.reference.includes("\0")))
      && Object.keys(request).every((key) => [
        "eventType", "purpose", "channel", "expectedRevision", "idempotencyKey", "reference",
      ].includes(key));
  }
  return false;
}

function isValidScope(scope: ContactBasisOperationScope) {
  return operatorPattern.test(scope.operatorId) && uuidPattern.test(scope.organizationId) && uuidPattern.test(scope.contactId)
    && ["PATIENT_INFORMATION", "AEVYRA_MARKETING"].includes(scope.purpose)
    && ["SMS", "VIBER"].includes(scope.channel);
}

export type PendingContactBasisReadResult =
  | { status: "EMPTY" }
  | { status: "VALID"; operation: PendingContactBasisOperation }
  | { status: "INVALID"; message: string }
  | { status: "UNAVAILABLE"; message: string };

export type PendingContactBasisWriteResult =
  | { ok: true }
  | { ok: false; message: string };

type StorageSource = Storage | (() => Storage);

function storageFrom(source: StorageSource) {
  return typeof source === "function" ? source() : source;
}

export function readPendingContactBasisOperation(source: StorageSource, scope: ContactBasisOperationScope): PendingContactBasisReadResult {
  if (!isValidScope(scope)) {
    return { status: "INVALID", message: "Опсегот за локалното повторување е невалиден." };
  }
  let storage: Storage;
  try {
    storage = storageFrom(source);
  } catch {
    return { status: "UNAVAILABLE", message: "Локалното безбедно складирање во ова јазиче не е достапно." };
  }
  try {
    const raw = storage.getItem(contactBasisOperationStorageKey(scope));
    if (raw === null) return { status: "EMPTY" };
    if (raw.length > 4096) {
      return { status: "INVALID", message: "Зачуваниот контекст за повторување е оштетен или преголем." };
    }
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value.version !== 1 || value.operatorId !== scope.operatorId
        || value.organizationId !== scope.organizationId || value.contactId !== scope.contactId
        || value.purpose !== scope.purpose || value.channel !== scope.channel
        || !isTimestamp(value.createdAt)
        || !isWriteRequest(value.request, scope)) {
      return { status: "INVALID", message: "Зачуваниот контекст за повторување е невалиден и не смее да се препише." };
    }
    return { status: "VALID", operation: value as PendingContactBasisOperation };
  } catch {
    return { status: "INVALID", message: "Зачуваниот контекст за повторување не може безбедно да се прочита." };
  }
}

export function storePendingContactBasisOperation(source: StorageSource, operation: PendingContactBasisOperation): PendingContactBasisWriteResult {
  if (operation.version !== 1 || !isValidScope(operation) || !isTimestamp(operation.createdAt)
      || !isWriteRequest(operation.request, operation)) {
    return { ok: false, message: "Операцијата не е валидна за безбедно локално зачувување." };
  }
  const key = contactBasisOperationStorageKey(operation);
  let storage: Storage;
  try {
    storage = storageFrom(source);
  } catch {
    return { ok: false, message: "Локалното безбедно складирање во ова јазиче не е достапно." };
  }
  try {
    const raw = JSON.stringify(operation);
    if (raw.length > 4096) return { ok: false, message: "Операцијата е преголема за безбедно локално зачувување." };
    storage.setItem(key, raw);
    if (storage.getItem(key) !== raw) {
      return { ok: false, message: "Операцијата не може да се потврди во локалното складирање." };
    }
    return { ok: true };
  } catch {
    return { ok: false, message: "Операцијата не може безбедно да се зачува во ова јазиче." };
  }
}

export function clearPendingContactBasisOperation(source: StorageSource, operation: PendingContactBasisOperation): PendingContactBasisWriteResult {
  const key = contactBasisOperationStorageKey(operation);
  let storage: Storage;
  try {
    storage = storageFrom(source);
  } catch {
    return { ok: false, message: "Локалното складирање не е достапно за чистење на потврдениот контекст." };
  }
  try {
    const saved = readPendingContactBasisOperation(storage, operation);
    if (saved.status === "VALID" && saved.operation.request.idempotencyKey === operation.request.idempotencyKey) {
      storage.removeItem(key);
      if (storage.getItem(key) !== null) {
        return { ok: false, message: "Потврдениот локален контекст не може да се исчисти." };
      }
    } else if (saved.status !== "EMPTY") {
      return { ok: false, message: "Локалниот контекст не се совпаѓа и не е исчистен." };
    }
    return { ok: true };
  } catch {
    return { ok: false, message: "Потврдениот локален контекст не може да се исчисти." };
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && uuidPattern.test(value);
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function isReference(value: unknown) {
  return value === null || (typeof value === "string" && value.length <= 250 && value.isWellFormed() && !value.includes("\0"));
}

function readEvent(value: unknown, scope: ContactBasisOperationScope): ContactBasisEvent | null {
  if (!isObject(value) || !hasOnlyKeys(value, [
    "id", "organizationId", "contactId", "purpose", "channel", "eventType", "operatorId", "recordedAt",
    "revision", "idempotencyKey", "basisType", "reference", "expiresAt",
  ])) return null;
  if (!isUuid(value.id) || value.organizationId !== scope.organizationId || value.contactId !== scope.contactId
      || value.purpose !== scope.purpose || value.channel !== scope.channel
      || (value.eventType !== "RECORD" && value.eventType !== "WITHDRAW")
      || typeof value.operatorId !== "string" || !operatorPattern.test(value.operatorId)
      || !isTimestamp(value.recordedAt) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1
      || !isUuid(value.idempotencyKey) || !isReference(value.reference)
      || (value.expiresAt !== null && !isTimestamp(value.expiresAt))) return null;
  if (value.eventType === "RECORD") {
    if ((value.basisType !== "CONSENT" && value.basisType !== "DOCUMENTED_BASIS")
        || typeof value.reference !== "string" || value.reference.length === 0) return null;
  } else if (value.basisType !== null || value.expiresAt !== null) return null;
  return value as ContactBasisEvent;
}

function readSuppression(value: unknown, scope: ContactBasisOperationScope): ContactSuppression | null | undefined {
  if (value === null) return null;
  if (!isObject(value) || !hasOnlyKeys(value, [
    "id", "organizationId", "contactId", "operatorId", "reason", "reference", "recordedAt",
  ])) return undefined;
  if (!isUuid(value.id) || value.organizationId !== scope.organizationId || value.contactId !== scope.contactId
      || (value.operatorId !== undefined && (typeof value.operatorId !== "string" || !operatorPattern.test(value.operatorId)))
      || !["CONTACT_REQUEST", "ORGANIZATION_REQUEST", "INTERNAL_BLOCK"].includes(String(value.reason))
      || !isReference(value.reference) || !isTimestamp(value.recordedAt)) return undefined;
  return value as ContactSuppression;
}

function readCurrent(value: unknown, scope: ContactBasisOperationScope): ContactBasisCurrentState | null {
  if (!isObject(value) || !hasOnlyKeys(value, [
    "organizationId", "contactId", "purpose", "channel", "revision", "status", "latestEvent", "suppression",
  ]) || value.organizationId !== scope.organizationId || value.contactId !== scope.contactId
      || value.purpose !== scope.purpose || value.channel !== scope.channel
      || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0
      || !["MISSING", "RECORDED", "WITHDRAWN", "EXPIRED"].includes(String(value.status))) return null;
  const latestEvent = value.latestEvent === null ? null : readEvent(value.latestEvent, scope);
  const suppression = readSuppression(value.suppression, scope);
  if (value.latestEvent !== null && latestEvent === null || suppression === undefined) return null;
  if (value.status === "MISSING") {
    if (value.revision !== 0 || latestEvent !== null) return null;
  } else {
    if (!latestEvent || latestEvent.revision !== value.revision) return null;
    if (value.status === "WITHDRAWN" ? latestEvent.eventType !== "WITHDRAW" : latestEvent.eventType !== "RECORD") return null;
    if (value.status === "EXPIRED" && latestEvent.expiresAt === null) return null;
  }
  return { ...value, latestEvent, suppression } as ContactBasisCurrentState;
}

function eventMatchesRequest(event: ContactBasisEvent, request: ContactBasisWriteRequest) {
  if (event.eventType !== request.eventType || event.revision !== request.expectedRevision + 1
      || event.idempotencyKey !== request.idempotencyKey) return false;
  if (request.eventType === "RECORD") {
    return event.basisType === request.basisType && event.reference === request.reference && event.expiresAt === request.expiresAt;
  }
  return event.basisType === null && event.reference === (request.reference ?? null) && event.expiresAt === null;
}

export function validateContactBasisWriteResult(
  value: unknown,
  operation: PendingContactBasisOperation,
): ContactBasisWriteResult | null {
  if (!isObject(value) || !hasOnlyKeys(value, ["outcome", "event", "current"])
      || (value.outcome !== "APPENDED" && value.outcome !== "REPLAYED")) return null;
  const event = readEvent(value.event, operation);
  const current = readCurrent(value.current, operation);
  if (!event || !current || event.operatorId !== operation.operatorId
      || !eventMatchesRequest(event, operation.request) || current.revision < event.revision) return null;
  if (value.outcome === "APPENDED"
      && (current.revision !== event.revision || current.latestEvent?.id !== event.id)) return null;
  return { outcome: value.outcome, event, current };
}

function partsAt(timestamp: number) {
  const values: Record<string, number> = {};
  for (const part of skopjeParts.formatToParts(new Date(timestamp))) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  return values;
}

export function skopjeLocalDateTimeToIso(value: string): { ok: true; iso: string } | { ok: false; message: string } {
  const match = localDateTimePattern.exec(value);
  if (!match) return { ok: false, message: "Внеси целосен датум и време." };
  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  const [year, month, day, hour, minute] = [yearText, monthText, dayText, hourText, minuteText].map(Number);
  const calendar = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1
      || calendar.getUTCDate() !== day || calendar.getUTCHours() !== hour
      || calendar.getUTCMinutes() !== minute) {
    return { ok: false, message: "Датумот или времето не постои." };
  }

  const wallClock = calendar.getTime();
  const matches: number[] = [];
  for (let offsetMinutes = -14 * 60; offsetMinutes <= 14 * 60; offsetMinutes += 15) {
    const candidate = wallClock - offsetMinutes * 60_000;
    const parts = partsAt(candidate);
    if (parts.year === year && parts.month === month && parts.day === day
        && parts.hour === hour && parts.minute === minute && parts.second === 0) matches.push(candidate);
  }
  const unique = [...new Set(matches)];
  if (unique.length === 0) {
    return { ok: false, message: "Ова локално време не постои поради промената на часовникот во Europe/Skopje." };
  }
  if (unique.length > 1) {
    return { ok: false, message: "Ова локално време е двосмислено поради промената на часовникот. Избери друго време." };
  }
  return { ok: true, iso: new Date(unique[0]).toISOString() };
}
