import type pg from "pg";
import { contactSuppressionReasons } from "../contact-suppressions.ts";
import type {
  ContactSuppression,
  ContactSuppressionReason,
} from "../contact-suppressions.ts";
import { getRuntimeAuth } from "./auth.ts";
import { uuidPattern } from "./contact-imports.ts";

export type PreparedContactSuppression = {
  organizationId: string;
  contactId: string;
  operatorId: string;
  reason: ContactSuppressionReason;
  reference?: string | null;
};

export type ContactSuppressionRecord = ContactSuppression & { operatorId: string };

export type ContactSuppressionWriteResult = {
  outcome: "RECORDED" | "ALREADY_RECORDED" | "ALREADY_RECORDED_DIFFERENT_METADATA";
  suppression: ContactSuppressionRecord;
};

export class ContactSuppressionError extends Error {
  readonly code: "INVALID_INPUT" | "CONTACT_NOT_FOUND" | "OPERATOR_NOT_FOUND" | "DATABASE_ERROR" | "OUTCOME_UNKNOWN";

  constructor(code: ContactSuppressionError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

type SuppressionRow = {
  id: string;
  organization_id: string;
  contact_id: string;
  operator_id: string;
  reason: ContactSuppressionReason;
  reference: string | null;
  recorded_at: Date;
};

const columns = "id, organization_id, contact_id, operator_id, reason, reference, recorded_at";
const allowedFields = ["organizationId", "contactId", "operatorId", "reason", "reference"] as const;
const requiredFields = ["organizationId", "contactId", "operatorId", "reason"] as const;
const reasonSet = new Set<string>(contactSuppressionReasons);

function invalid(message: string) {
  return new ContactSuppressionError("INVALID_INPUT", message);
}

function databaseError() {
  return new ContactSuppressionError("DATABASE_ERROR", "Евиденцијата „Не контактирај“ е привремено недостапна.");
}

function readUuid(value: unknown, message: string) {
  if (typeof value !== "string" || !uuidPattern.test(value)) throw invalid(message);
  return value.toLowerCase();
}

function validateInput(value: unknown): Required<PreparedContactSuppression> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalid("Податоците за ограничувањето не се валидни.");
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !allowedFields.includes(key as typeof allowedFields[number]))
      || requiredFields.some((key) => !Object.hasOwn(input, key))) {
    throw invalid("Податоците за ограничувањето содржат недозволени или недостасувачки полиња.");
  }
  const organizationId = readUuid(input.organizationId, "Организацијата мора да има валиден UUID.");
  const contactId = readUuid(input.contactId, "Контактот мора да има валиден UUID.");
  if (typeof input.operatorId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(input.operatorId)) {
    throw invalid("Идентификаторот на операторот не е валиден.");
  }
  if (typeof input.reason !== "string" || !reasonSet.has(input.reason)) {
    throw invalid("Причината за ограничувањето не е поддржана.");
  }
  let reference: string | null = null;
  if (input.reference !== undefined && input.reference !== null) {
    if (typeof input.reference !== "string" || !input.reference.isWellFormed() || input.reference.includes("\0")) {
      throw invalid("Референцата не е валиден текст.");
    }
    reference = input.reference.trim();
    if (reference === "" || Array.from(reference).length > 250) {
      throw invalid("Референцата мора да има од 1 до 250 знаци.");
    }
  }
  return {
    organizationId,
    contactId,
    operatorId: input.operatorId,
    reason: input.reason as ContactSuppressionReason,
    reference,
  };
}

function serialize(row: SuppressionRow): ContactSuppressionRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    contactId: row.contact_id,
    operatorId: row.operator_id,
    reason: row.reason,
    reference: row.reference,
    recordedAt: row.recorded_at.toISOString(),
  };
}

function sameMetadata(row: SuppressionRow, input: Required<PreparedContactSuppression>) {
  return row.operator_id === input.operatorId && row.reason === input.reason && row.reference === input.reference;
}

async function requireIdentities(client: pg.PoolClient, input: Required<PreparedContactSuppression>) {
  const { rows: [identity] } = await client.query<{ contact_exists: boolean; operator_exists: boolean }>(`
    SELECT EXISTS (
      SELECT FROM aevyra.contacts WHERE organization_id = $1 AND id = $2
    ) AS contact_exists,
    EXISTS (
      SELECT FROM aevyra_auth."user" WHERE id = $3
    ) AS operator_exists
  `, [input.organizationId, input.contactId, input.operatorId]);
  if (!identity.contact_exists) {
    throw new ContactSuppressionError("CONTACT_NOT_FOUND", "Контактот не е пронајден во избраната организација.");
  }
  if (!identity.operator_exists) {
    throw new ContactSuppressionError("OPERATOR_NOT_FOUND", "Внатрешниот оператор не е пронајден.");
  }
}

async function persist(client: pg.PoolClient, input: Required<PreparedContactSuppression>): Promise<ContactSuppressionWriteResult> {
  await requireIdentities(client, input);
  const { rows: [inserted] } = await client.query<SuppressionRow>(`
    INSERT INTO aevyra.contact_suppressions (organization_id, contact_id, operator_id, reason, reference)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (organization_id, contact_id) DO NOTHING
    RETURNING ${columns}
  `, [input.organizationId, input.contactId, input.operatorId, input.reason, input.reference]);
  if (inserted) return { outcome: "RECORDED", suppression: serialize(inserted) };

  const { rows: [existing] } = await client.query<SuppressionRow>(`
    SELECT ${columns} FROM aevyra.contact_suppressions
    WHERE organization_id = $1 AND contact_id = $2
  `, [input.organizationId, input.contactId]);
  if (!existing) throw databaseError();
  return {
    outcome: sameMetadata(existing, input) ? "ALREADY_RECORDED" : "ALREADY_RECORDED_DIFFERENT_METADATA",
    suppression: serialize(existing),
  };
}

// HTTP патеката го зема operatorId од проверената серверска сесија, никогаш од клиентското тело.
export async function recordContactSuppression(prepared: PreparedContactSuppression, pool?: pg.Pool) {
  const input = validateInput(prepared);
  const connectionPool = pool ?? getRuntimeAuth().pool;
  const client = await connectionPool.connect().catch(() => { throw databaseError(); });
  let discard = false;
  let committing = false;
  const connectionFailed = () => { discard = true; };
  client.on("error", connectionFailed);
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    const result = await persist(client, input);
    committing = true;
    const committed = await client.query("COMMIT");
    committing = false;
    if (committed.command !== "COMMIT") throw databaseError();
    return result;
  } catch (error) {
    if (committing) {
      discard = true;
      throw new ContactSuppressionError(
        "OUTCOME_UNKNOWN",
        "Исходот на евидентирањето е непознат. Прочитајте го ограничувањето и повторете за истиот контакт.",
      );
    }
    if (!discard) {
      try {
        await client.query("ROLLBACK");
      } catch {
        discard = true;
      }
    }
    if (error instanceof ContactSuppressionError) throw error;
    throw databaseError();
  } finally {
    client.removeListener("error", connectionFailed);
    client.release(discard);
  }
}

export async function readContactSuppression(organizationId: string, contactId: string, pool?: pg.Pool) {
  const organization = readUuid(organizationId, "Организацијата мора да има валиден UUID.");
  const contact = readUuid(contactId, "Контактот мора да има валиден UUID.");
  try {
    const { rows: [row] } = await (pool ?? getRuntimeAuth().pool).query<SuppressionRow & { suppression_exists: boolean }>(`
      SELECT suppression.id, suppression.organization_id, suppression.contact_id, suppression.operator_id,
        suppression.reason, suppression.reference, suppression.recorded_at,
        suppression.id IS NOT NULL AS suppression_exists
      FROM aevyra.contacts AS contact
      LEFT JOIN aevyra.contact_suppressions AS suppression
        ON suppression.organization_id = contact.organization_id AND suppression.contact_id = contact.id
      WHERE contact.organization_id = $1 AND contact.id = $2
    `, [organization, contact]);
    if (!row) throw new ContactSuppressionError("CONTACT_NOT_FOUND", "Контактот не е пронајден во избраната организација.");
    return row.suppression_exists ? serialize(row) : null;
  } catch (error) {
    if (error instanceof ContactSuppressionError) throw error;
    throw databaseError();
  }
}
