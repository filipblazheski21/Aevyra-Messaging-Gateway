import assert from "node:assert/strict";
import test from "node:test";
import {
  clearPendingContactBasisOperation,
  contactBasisOperationStorageKey,
  readPendingContactBasisOperation,
  skopjeLocalDateTimeToIso,
  storePendingContactBasisOperation,
  validateContactBasisWriteResult,
} from "./contact-basis-write.ts";
import type { ContactBasisOperationScope, PendingContactBasisOperation } from "./contact-basis-write.ts";

class MemoryStorage implements Storage {
  readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

test("локалниот рок во Europe/Skopje ги користи зимските и летните правила", () => {
  assert.deepEqual(skopjeLocalDateTimeToIso("2027-01-15T12:30"), { ok: true, iso: "2027-01-15T11:30:00.000Z" });
  assert.deepEqual(skopjeLocalDateTimeToIso("2027-07-15T12:30"), { ok: true, iso: "2027-07-15T10:30:00.000Z" });
});

test("непостоечко и двосмислено локално време не се поместуваат тивко", () => {
  const missing = skopjeLocalDateTimeToIso("2027-03-28T02:30");
  const ambiguous = skopjeLocalDateTimeToIso("2027-10-31T02:30");
  assert.equal(missing.ok, false);
  assert.match(missing.ok ? "" : missing.message, /не постои/);
  assert.equal(ambiguous.ok, false);
  assert.match(ambiguous.ok ? "" : ambiguous.message, /двосмислено/);
});

test("невалидниот календарски датум се одбива", () => {
  const invalid = skopjeLocalDateTimeToIso("2027-02-29T10:00");
  assert.equal(invalid.ok, false);
  assert.match(invalid.ok ? "" : invalid.message, /не постои/);
});

test("зачуваната операција е врзана за точниот оператор и опсег", () => {
  const storage = new MemoryStorage();
  const scope: ContactBasisOperationScope = {
    operatorId: "11111111-1111-4111-8111-111111111111",
    organizationId: "22222222-2222-4222-8222-222222222222",
    contactId: "33333333-3333-4333-8333-333333333333",
    purpose: "PATIENT_INFORMATION",
    channel: "SMS",
  };
  const operation: PendingContactBasisOperation = {
    version: 1,
    ...scope,
    createdAt: "2026-11-13T10:00:00.000Z",
    request: {
      eventType: "RECORD",
      purpose: scope.purpose,
      channel: scope.channel,
      expectedRevision: 0,
      idempotencyKey: "44444444-4444-4444-8444-444444444444",
      basisType: "CONSENT",
      reference: "SYNTHETIC-REF",
      expiresAt: null,
    },
  };
  assert.deepEqual(storePendingContactBasisOperation(storage, operation), { ok: true });
  assert.deepEqual(readPendingContactBasisOperation(storage, scope), { status: "VALID", operation });
  assert.deepEqual(readPendingContactBasisOperation(storage, { ...scope, operatorId: "55555555-5555-4555-8555-555555555555" }), { status: "EMPTY" });
  assert.deepEqual(clearPendingContactBasisOperation(storage, operation), { ok: true });
  assert.deepEqual(readPendingContactBasisOperation(storage, scope), { status: "EMPTY" });
});

test("оштетен и недостапен storage се разликуваат од празен scope", () => {
  const storage = new MemoryStorage();
  const scope: ContactBasisOperationScope = {
    operatorId: "11111111-1111-4111-8111-111111111111",
    organizationId: "22222222-2222-4222-8222-222222222222",
    contactId: "33333333-3333-4333-8333-333333333333",
    purpose: "PATIENT_INFORMATION",
    channel: "SMS",
  };
  storage.setItem(contactBasisOperationStorageKey(scope), "{invalid-json");
  assert.equal(readPendingContactBasisOperation(storage, scope).status, "INVALID");
  assert.equal(readPendingContactBasisOperation(() => { throw new Error("blocked"); }, scope).status, "UNAVAILABLE");
});

function recordOperation(): PendingContactBasisOperation {
  return {
    version: 1,
    operatorId: "11111111-1111-4111-8111-111111111111",
    organizationId: "22222222-2222-4222-8222-222222222222",
    contactId: "33333333-3333-4333-8333-333333333333",
    purpose: "PATIENT_INFORMATION",
    channel: "SMS",
    createdAt: "2026-11-13T10:00:00.000Z",
    request: {
      eventType: "RECORD",
      purpose: "PATIENT_INFORMATION",
      channel: "SMS",
      expectedRevision: 0,
      idempotencyKey: "44444444-4444-4444-8444-444444444444",
      basisType: "CONSENT",
      reference: "SYNTHETIC-REF",
      expiresAt: null,
    },
  };
}

function recordEvent(operation = recordOperation()) {
  return {
    id: "55555555-5555-4555-8555-555555555555",
    organizationId: operation.organizationId,
    contactId: operation.contactId,
    purpose: operation.purpose,
    channel: operation.channel,
    eventType: "RECORD" as const,
    operatorId: operation.operatorId,
    recordedAt: "2026-11-13T10:01:00.000Z",
    revision: 1,
    idempotencyKey: operation.request.idempotencyKey,
    basisType: "CONSENT" as const,
    reference: "SYNTHETIC-REF",
    expiresAt: null,
  };
}

test("успешниот POST одговор се прифаќа само со целосен и конзистентен договор", () => {
  const operation = recordOperation();
  const event = recordEvent(operation);
  const response = {
    outcome: "APPENDED",
    event,
    current: {
      organizationId: operation.organizationId,
      contactId: operation.contactId,
      purpose: operation.purpose,
      channel: operation.channel,
      revision: 1,
      status: "RECORDED",
      latestEvent: event,
      suppression: null,
    },
  };
  assert.deepEqual(validateContactBasisWriteResult(response, operation), response);
  assert.equal(validateContactBasisWriteResult({ outcome: "APPENDED", event: {
    idempotencyKey: operation.request.idempotencyKey,
    organizationId: operation.organizationId,
    contactId: operation.contactId,
    purpose: operation.purpose,
    channel: operation.channel,
  }, current: {
    organizationId: operation.organizationId,
    contactId: operation.contactId,
    purpose: operation.purpose,
    channel: operation.channel,
  } }, operation), null);
  assert.equal(validateContactBasisWriteResult({ ...response, event: { ...event, reference: "OTHER" } }, operation), null);
});

test("стар RECORD replay може валидно да врати понова WITHDRAWN current состојба", () => {
  const operation = recordOperation();
  const event = recordEvent(operation);
  const withdrawn = {
    ...event,
    id: "66666666-6666-4666-8666-666666666666",
    eventType: "WITHDRAW" as const,
    revision: 2,
    idempotencyKey: "77777777-7777-4777-8777-777777777777",
    basisType: null,
    reference: "SYNTHETIC-WITHDRAW",
    expiresAt: null,
  };
  const response = {
    outcome: "REPLAYED",
    event,
    current: {
      organizationId: operation.organizationId,
      contactId: operation.contactId,
      purpose: operation.purpose,
      channel: operation.channel,
      revision: 2,
      status: "WITHDRAWN",
      latestEvent: withdrawn,
      suppression: {
        id: "88888888-8888-4888-8888-888888888888",
        organizationId: operation.organizationId,
        contactId: operation.contactId,
        reason: "CONTACT_REQUEST",
        reference: null,
        recordedAt: "2026-11-13T10:02:00.000Z",
      },
    },
  };
  assert.deepEqual(validateContactBasisWriteResult(response, operation), response);
});
