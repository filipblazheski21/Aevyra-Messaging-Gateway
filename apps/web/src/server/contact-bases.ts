import { createHash } from "node:crypto";
import type pg from "pg";
import {
  contactBasisChannels,
  contactBasisPurposes,
  contactBasisTypes,
} from "../contact-bases.ts";
import type {
  ContactBasisChannel,
  ContactBasisCurrentState,
  ContactBasisEvent,
  ContactBasisEventType,
  ContactBasisPurpose,
  ContactBasisStatus,
  ContactBasisType,
  ContactBasisWriteResult,
} from "../contact-bases.ts";
import type { OrganizationKind } from "../organizations.ts";
import { getRuntimeAuth } from "./auth.ts";
import type { ContactSuppressionRecord } from "./contact-suppressions.ts";
import { uuidPattern } from "./contact-imports.ts";

export { contactBasisChannels, contactBasisPurposes, contactBasisTypes };
export type {
  ContactBasisChannel,
  ContactBasisCurrentState,
  ContactBasisEvent,
  ContactBasisEventType,
  ContactBasisPurpose,
  ContactBasisStatus,
  ContactBasisType,
  ContactBasisWriteResult,
};

type PreparedContactBasisCommon = {
  organizationId: string;
  contactId: string;
  operatorId: string;
  purpose: ContactBasisPurpose;
  channel: ContactBasisChannel;
  expectedRevision: number;
  idempotencyKey: string;
};

export type PreparedContactBasisRecord = PreparedContactBasisCommon & {
  basisType: ContactBasisType;
  reference: string;
  expiresAt?: string | null;
};

export type PreparedContactBasisWithdrawal = PreparedContactBasisCommon & {
  reference?: string | null;
};

type CanonicalContactBasisRequest = PreparedContactBasisCommon & {
  eventType: ContactBasisEventType;
  basisType: ContactBasisType | null;
  reference: string | null;
  expiresAt: string | null;
};

export class ContactBasisError extends Error {
  readonly code:
    | "INVALID_INPUT"
    | "ORGANIZATION_NOT_FOUND"
    | "CONTACT_NOT_FOUND"
    | "OPERATOR_NOT_FOUND"
    | "PURPOSE_NOT_ALLOWED"
    | "REVISION_CONFLICT"
    | "IDEMPOTENCY_CONFLICT"
    | "DATABASE_ERROR"
    | "OUTCOME_UNKNOWN";

  constructor(code: ContactBasisError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

type EventRow = {
  id: string;
  organization_id: string;
  contact_id: string;
  purpose: ContactBasisPurpose;
  channel: ContactBasisChannel;
  event_type: ContactBasisEventType;
  operator_id: string;
  recorded_at: Date;
  revision: number;
  idempotency_key: string;
  request_fingerprint: string;
  basis_type: ContactBasisType | null;
  reference: string | null;
  expires_at: Date | null;
};

type CurrentRow = Partial<EventRow> & {
  organization_kind: OrganizationKind;
  selected_contact_id: string | null;
  database_now: Date;
  suppression_id: string | null;
  suppression_operator_id: string | null;
  suppression_reason: ContactSuppressionRecord["reason"] | null;
  suppression_reference: string | null;
  suppression_recorded_at: Date | null;
};

const eventColumns = `id, organization_id, contact_id, purpose, channel, event_type, operator_id,
  recorded_at, revision, idempotency_key, request_fingerprint, basis_type, reference, expires_at`;
const operatorPattern = /^[A-Za-z0-9_-]{1,128}$/;
const purposeSet = new Set<string>(contactBasisPurposes);
const channelSet = new Set<string>(contactBasisChannels);
const basisTypeSet = new Set<string>(contactBasisTypes);
const timestampPattern = /^(?!0000)(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/;

function invalid(message: string) {
  return new ContactBasisError("INVALID_INPUT", message);
}

function databaseError() {
  return new ContactBasisError("DATABASE_ERROR", "Евиденцијата за основа за контакт е привремено недостапна.");
}

function readUuid(value: unknown, message: string) {
  if (typeof value !== "string" || !uuidPattern.test(value)) throw invalid(message);
  return value.toLowerCase();
}

function readReference(value: unknown, required: boolean) {
  if (value === undefined || value === null) {
    if (required) throw invalid("Референцата кон доказ е задолжителна.");
    return null;
  }
  if (typeof value !== "string" || !value.isWellFormed() || value.includes("\0")) {
    throw invalid("Референцата не е валиден текст.");
  }
  const reference = value.trim();
  if (reference === "" || Array.from(reference).length > 250) {
    throw invalid("Референцата мора да има од 1 до 250 знаци.");
  }
  return reference;
}

function isLeapYear(year: number) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function hasValidTimestampComponents(match: RegExpExecArray) {
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[10] === undefined ? 0 : Number(match[10]);
  const offsetMinute = match[11] === undefined ? 0 : Number(match[11]);
  const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return daysInMonth !== undefined
    && day >= 1 && day <= daysInMonth
    && hour <= 23 && minute <= 59 && second <= 59
    && offsetHour <= 23 && offsetMinute <= 59;
}

function readExpiry(value: unknown) {
  if (value === undefined || value === null) return null;
  const match = typeof value === "string" ? timestampPattern.exec(value) : null;
  if (!match || !hasValidTimestampComponents(match)) {
    throw invalid("Рокот на важност мора да биде ISO датум и време со временска зона.");
  }
  const milliseconds = Date.parse(match[0]);
  if (!Number.isFinite(milliseconds)) throw invalid("Рокот на важност не е валиден датум и време.");
  return new Date(milliseconds).toISOString();
}

function readCommon(value: Record<string, unknown>): PreparedContactBasisCommon {
  const organizationId = readUuid(value.organizationId, "Организацијата мора да има валиден UUID.");
  const contactId = readUuid(value.contactId, "Контактот мора да има валиден UUID.");
  const idempotencyKey = readUuid(value.idempotencyKey, "Клучот за повторување мора да има валиден UUID.");
  if (typeof value.operatorId !== "string" || !operatorPattern.test(value.operatorId)) {
    throw invalid("Идентификаторот на операторот не е валиден.");
  }
  if (typeof value.purpose !== "string" || !purposeSet.has(value.purpose)) {
    throw invalid("Намената за контакт не е поддржана.");
  }
  if (typeof value.channel !== "string" || !channelSet.has(value.channel)) {
    throw invalid("Каналот за контакт не е поддржан.");
  }
  if (typeof value.expectedRevision !== "number" || !Number.isInteger(value.expectedRevision)
      || value.expectedRevision < 0 || value.expectedRevision >= 2_147_483_647) {
    throw invalid("Очекуваната revision мора да биде ненегативен цел број.");
  }
  return {
    organizationId,
    contactId,
    operatorId: value.operatorId,
    purpose: value.purpose as ContactBasisPurpose,
    channel: value.channel as ContactBasisChannel,
    expectedRevision: value.expectedRevision,
    idempotencyKey,
  };
}

function canonicalize(value: unknown, eventType: ContactBasisEventType): CanonicalContactBasisRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalid("Податоците за основата за контакт не се валидни.");
  }
  const input = value as Record<string, unknown>;
  const allowed = eventType === "RECORD"
    ? ["organizationId", "contactId", "operatorId", "purpose", "channel", "expectedRevision", "idempotencyKey", "basisType", "reference", "expiresAt"]
    : ["organizationId", "contactId", "operatorId", "purpose", "channel", "expectedRevision", "idempotencyKey", "reference"];
  const required = eventType === "RECORD"
    ? ["organizationId", "contactId", "operatorId", "purpose", "channel", "expectedRevision", "idempotencyKey", "basisType", "reference"]
    : ["organizationId", "contactId", "operatorId", "purpose", "channel", "expectedRevision", "idempotencyKey"];
  if (Object.keys(input).some((key) => !allowed.includes(key)) || required.some((key) => !Object.hasOwn(input, key))) {
    throw invalid("Податоците содржат недозволени или недостасувачки полиња.");
  }
  const common = readCommon(input);
  if (eventType === "RECORD" && (typeof input.basisType !== "string" || !basisTypeSet.has(input.basisType))) {
    throw invalid("Видот на евидентираната основа не е поддржан.");
  }
  return {
    ...common,
    eventType,
    basisType: eventType === "RECORD" ? input.basisType as ContactBasisType : null,
    reference: readReference(input.reference, eventType === "RECORD"),
    expiresAt: eventType === "RECORD" ? readExpiry(input.expiresAt) : null,
  };
}

function fingerprint(input: CanonicalContactBasisRequest) {
  return createHash("sha256").update(JSON.stringify({ version: 1, ...input })).digest("hex");
}

function serializeEvent(row: EventRow): ContactBasisEvent {
  return {
    id: row.id,
    organizationId: row.organization_id,
    contactId: row.contact_id,
    purpose: row.purpose,
    channel: row.channel,
    eventType: row.event_type,
    operatorId: row.operator_id,
    recordedAt: row.recorded_at.toISOString(),
    revision: row.revision,
    idempotencyKey: row.idempotency_key,
    basisType: row.basis_type,
    reference: row.reference,
    expiresAt: row.expires_at?.toISOString() ?? null,
  };
}

function purposeAllowed(kind: OrganizationKind, purpose: ContactBasisPurpose) {
  return (kind === "CLINIC" && purpose === "PATIENT_INFORMATION")
    || (kind === "MARKETING" && purpose === "AEVYRA_MARKETING");
}

function assertPurpose(kind: OrganizationKind, purpose: ContactBasisPurpose) {
  if (!purposeAllowed(kind, purpose)) {
    throw new ContactBasisError("PURPOSE_NOT_ALLOWED", "Намената не е дозволена за избраниот вид организација.");
  }
}

async function currentState(
  client: pg.PoolClient | pg.Pool,
  organizationId: string,
  contactId: string,
  purpose: ContactBasisPurpose,
  channel: ContactBasisChannel,
): Promise<ContactBasisCurrentState> {
  const { rows: [row] } = await client.query<CurrentRow>(`
    SELECT organization.kind AS organization_kind, contact.id AS selected_contact_id,
      event.id, event.organization_id, event.contact_id, event.purpose, event.channel, event.event_type,
      event.operator_id, event.recorded_at, event.revision, event.idempotency_key,
      event.request_fingerprint, event.basis_type, event.reference, event.expires_at,
      suppression.id AS suppression_id, suppression.operator_id AS suppression_operator_id,
      suppression.reason AS suppression_reason, suppression.reference AS suppression_reference,
      suppression.recorded_at AS suppression_recorded_at, clock_timestamp() AS database_now
    FROM aevyra.organizations AS organization
    LEFT JOIN aevyra.contacts AS contact
      ON contact.organization_id = organization.id AND contact.id = $2
    LEFT JOIN LATERAL (
      SELECT ${eventColumns}
      FROM aevyra.contact_basis_events
      WHERE organization_id = organization.id AND contact_id = contact.id AND purpose = $3 AND channel = $4
      ORDER BY revision DESC LIMIT 1
    ) AS event ON true
    LEFT JOIN aevyra.contact_suppressions AS suppression
      ON suppression.organization_id = organization.id AND suppression.contact_id = contact.id
    WHERE organization.id = $1
  `, [organizationId, contactId, purpose, channel]);
  if (!row) throw new ContactBasisError("ORGANIZATION_NOT_FOUND", "Организацијата не е пронајдена.");
  if (!row.selected_contact_id) {
    throw new ContactBasisError("CONTACT_NOT_FOUND", "Контактот не е пронајден во избраната организација.");
  }
  assertPurpose(row.organization_kind, purpose);
  const latestEvent = row.id ? serializeEvent(row as EventRow) : null;
  let status: ContactBasisStatus = "MISSING";
  if (latestEvent?.eventType === "WITHDRAW") status = "WITHDRAWN";
  else if (latestEvent?.expiresAt && Date.parse(latestEvent.expiresAt) <= row.database_now.getTime()) status = "EXPIRED";
  else if (latestEvent) status = "RECORDED";
  const suppression = row.suppression_id ? {
    id: row.suppression_id,
    organizationId,
    contactId,
    operatorId: row.suppression_operator_id!,
    reason: row.suppression_reason!,
    reference: row.suppression_reference,
    recordedAt: row.suppression_recorded_at!.toISOString(),
  } : null;
  return {
    organizationId,
    contactId,
    purpose,
    channel,
    revision: latestEvent?.revision ?? 0,
    status,
    latestEvent,
    suppression,
  };
}

async function requireWriteIdentities(client: pg.PoolClient, input: CanonicalContactBasisRequest) {
  const { rows: [organization] } = await client.query<{ kind: OrganizationKind; contact_exists: boolean; operator_exists: boolean }>(`
    SELECT kind,
      EXISTS (SELECT FROM aevyra.contacts WHERE organization_id = $1 AND id = $2) AS contact_exists,
      EXISTS (SELECT FROM aevyra_auth."user" WHERE id = $3) AS operator_exists
    FROM aevyra.organizations WHERE id = $1
  `, [input.organizationId, input.contactId, input.operatorId]);
  if (!organization) throw new ContactBasisError("ORGANIZATION_NOT_FOUND", "Организацијата не е пронајдена.");
  if (!organization.contact_exists) {
    throw new ContactBasisError("CONTACT_NOT_FOUND", "Контактот не е пронајден во избраната организација.");
  }
  if (!organization.operator_exists) {
    throw new ContactBasisError("OPERATOR_NOT_FOUND", "Внатрешниот оператор не е пронајден.");
  }
  assertPurpose(organization.kind, input.purpose);
}

async function appendEvent(
  client: pg.PoolClient,
  input: CanonicalContactBasisRequest,
  requestFingerprint: string,
): Promise<ContactBasisWriteResult> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('aevyra.contact-basis:' || $1::text, 0))", [input.organizationId]);

  const { rows: [repeated] } = await client.query<EventRow>(`
    SELECT ${eventColumns} FROM aevyra.contact_basis_events
    WHERE organization_id = $1 AND idempotency_key = $2
  `, [input.organizationId, input.idempotencyKey]);
  if (repeated) {
    if (repeated.request_fingerprint !== requestFingerprint) {
      throw new ContactBasisError("IDEMPOTENCY_CONFLICT", "Клучот за повторување веќе е употребен за различно барање.");
    }
    return {
      outcome: "REPLAYED",
      event: serializeEvent(repeated),
      current: await currentState(client, input.organizationId, input.contactId, input.purpose, input.channel),
    };
  }

  await requireWriteIdentities(client, input);
  const { rows: [latest] } = await client.query<{ revision: number }>(`
    SELECT revision FROM aevyra.contact_basis_events
    WHERE organization_id = $1 AND contact_id = $2 AND purpose = $3 AND channel = $4
    ORDER BY revision DESC LIMIT 1
  `, [input.organizationId, input.contactId, input.purpose, input.channel]);
  const actualRevision = latest?.revision ?? 0;
  if (actualRevision !== input.expectedRevision) {
    throw new ContactBasisError("REVISION_CONFLICT", "Евиденцијата е променета. Прочитајте ја повторно пред ново запишување.");
  }
  if (input.expiresAt) {
    const { rows: [databaseTime] } = await client.query<{ now: Date }>("SELECT now() AS now");
    if (Date.parse(input.expiresAt) <= databaseTime.now.getTime()) {
      throw invalid("Рокот на важност мора да биде по времето на евидентирање.");
    }
  }

  const { rows: [inserted] } = await client.query<EventRow>(`
    INSERT INTO aevyra.contact_basis_events (
      organization_id, contact_id, purpose, channel, event_type, operator_id, revision,
      idempotency_key, request_fingerprint, basis_type, reference, expires_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    RETURNING ${eventColumns}
  `, [
    input.organizationId, input.contactId, input.purpose, input.channel, input.eventType, input.operatorId,
    actualRevision + 1, input.idempotencyKey, requestFingerprint, input.basisType, input.reference, input.expiresAt,
  ]);
  if (!inserted) throw databaseError();
  return {
    outcome: "APPENDED",
    event: serializeEvent(inserted),
    current: await currentState(client, input.organizationId, input.contactId, input.purpose, input.channel),
  };
}

async function writeContactBasis(value: unknown, eventType: ContactBasisEventType, pool?: pg.Pool) {
  const input = canonicalize(value, eventType);
  const requestFingerprint = fingerprint(input);
  const connectionPool = pool ?? getRuntimeAuth().pool;
  const client = await connectionPool.connect().catch(() => { throw databaseError(); });
  let discard = false;
  let committing = false;
  const connectionFailed = () => { discard = true; };
  client.on("error", connectionFailed);
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    const result = await appendEvent(client, input, requestFingerprint);
    committing = true;
    const committed = await client.query("COMMIT");
    committing = false;
    if (committed.command !== "COMMIT") throw databaseError();
    return result;
  } catch (error) {
    if (committing) {
      discard = true;
      throw new ContactBasisError(
        "OUTCOME_UNKNOWN",
        "Исходот на евидентирањето е непознат. Повторете со истиот клуч за повторување.",
      );
    }
    if (!discard) {
      try {
        await client.query("ROLLBACK");
      } catch {
        discard = true;
      }
    }
    if (error instanceof ContactBasisError) throw error;
    throw databaseError();
  } finally {
    client.removeListener("error", connectionFailed);
    client.release(discard);
  }
}

// Идниот HTTP слој мора да го земе operatorId од проверената серверска сесија.
export function recordContactBasis(prepared: PreparedContactBasisRecord, pool?: pg.Pool) {
  return writeContactBasis(prepared, "RECORD", pool);
}

// Повлекувањето е нов непроменлив настан и не го брише претходниот RECORD.
export function withdrawContactBasis(prepared: PreparedContactBasisWithdrawal, pool?: pg.Pool) {
  return writeContactBasis(prepared, "WITHDRAW", pool);
}

export async function readContactBasisState(
  organizationId: string,
  contactId: string,
  purpose: ContactBasisPurpose,
  channel: ContactBasisChannel,
  pool?: pg.Pool,
) {
  const organization = readUuid(organizationId, "Организацијата мора да има валиден UUID.");
  const contact = readUuid(contactId, "Контактот мора да има валиден UUID.");
  if (!purposeSet.has(purpose)) throw invalid("Намената за контакт не е поддржана.");
  if (!channelSet.has(channel)) throw invalid("Каналот за контакт не е поддржан.");
  try {
    return await currentState(pool ?? getRuntimeAuth().pool, organization, contact, purpose, channel);
  } catch (error) {
    if (error instanceof ContactBasisError) throw error;
    throw databaseError();
  }
}
