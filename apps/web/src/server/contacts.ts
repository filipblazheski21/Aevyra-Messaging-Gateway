import { createHmac, timingSafeEqual } from "node:crypto";
import type { ContactListItem, ContactListPage } from "../contacts.ts";
import { readAuthSettings } from "./auth-settings.ts";
import { getRuntimeAuth } from "./auth.ts";
import { uuidPattern } from "./contact-imports.ts";

export class ContactListError extends Error {}

type ContactRow = {
  id: string;
  normalized_phone: string;
  created_at: Date;
  has_suppression: boolean;
};

type ContactCursor = {
  purpose: typeof cursorPurpose;
  version: 1;
  organizationId: string;
  search: string;
  normalizedPhone: string;
  id: string;
};

const cursorPurpose = "aevyra.contacts.page";
const cursorKeys = ["purpose", "version", "organizationId", "search", "normalizedPhone", "id"] as const;
const phonePattern = /^\+[1-9][0-9]{1,14}$/;
const searchPattern = /^\+?[1-9][0-9]{2,14}$/;

function invalid(message: string) {
  return new ContactListError(message);
}

function cursorSignature(body: string) {
  const key = createHmac("sha256", readAuthSettings().secret).update(`${cursorPurpose}.signing-key.v1`).digest();
  return createHmac("sha256", key).update(body, "ascii").digest();
}

function issueCursor(organizationId: string, search: string, row: ContactRow) {
  const payload: ContactCursor = {
    purpose: cursorPurpose,
    version: 1,
    organizationId,
    search,
    normalizedPhone: row.normalized_phone,
    id: row.id,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${cursorSignature(body).toString("base64url")}`;
}

function readCursor(token: string, organizationId: string, search: string): ContactCursor {
  const message = "Почетната точка за страницата не е валидна за оваа организација и пребарување.";
  if (token.length > 1024 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) throw invalid(message);
  const [body, encodedSignature] = token.split(".");
  const bytes = Buffer.from(body, "base64url");
  const provided = Buffer.from(encodedSignature, "base64url");
  if (bytes.toString("base64url") !== body || provided.toString("base64url") !== encodedSignature
      || provided.length !== 32 || !timingSafeEqual(provided, cursorSignature(body))) throw invalid(message);
  try {
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Object.keys(value).length !== cursorKeys.length
        || cursorKeys.some((key) => !Object.hasOwn(value, key))) throw invalid(message);
    const cursor = value as ContactCursor;
    if (cursor.purpose !== cursorPurpose || cursor.version !== 1 || cursor.organizationId !== organizationId
        || cursor.search !== search || !uuidPattern.test(cursor.organizationId) || !uuidPattern.test(cursor.id)
        || cursor.organizationId !== cursor.organizationId.toLowerCase() || cursor.id !== cursor.id.toLowerCase()
        || !phonePattern.test(cursor.normalizedPhone)
        || (cursor.search !== "" && !/^\+[1-9][0-9]{2,14}$/.test(cursor.search))) throw invalid(message);
    return cursor;
  } catch (error) {
    if (error instanceof ContactListError) throw error;
    throw invalid(message);
  }
}

function readSearch(raw: string | null) {
  if (raw === null) return "";
  const value = raw.trim();
  if (value === "") return "";
  if (!searchPattern.test(value)) {
    throw invalid("Пребарувањето мора да содржи почеток на меѓународен број со опционално + и од 3 до 15 цифри.");
  }
  return `+${value.replace(/^\+/, "")}`;
}

function readLimit(raw: string | null) {
  const value = raw ?? "25";
  if (!/^[1-9][0-9]*$/.test(value)) throw invalid("Бројот на записи мора да биде од 1 до 100.");
  const limit = Number(value);
  if (limit > 100) throw invalid("Бројот на записи мора да биде од 1 до 100.");
  return limit;
}

function readParameters(params: URLSearchParams) {
  for (const key of params.keys()) {
    if (!["search", "limit", "cursor"].includes(key) || params.getAll(key).length !== 1) {
      throw invalid("Параметрите за контактите не се валидни.");
    }
  }
  return {
    search: readSearch(params.get("search")),
    limit: readLimit(params.get("limit")),
    cursorToken: params.get("cursor"),
  };
}

function serialize(row: ContactRow): ContactListItem {
  return {
    id: row.id,
    normalizedPhone: row.normalized_phone,
    createdAt: row.created_at.toISOString(),
    hasSuppression: row.has_suppression,
  };
}

export async function listContacts(organizationId: string, params: URLSearchParams): Promise<ContactListPage> {
  const { search, limit, cursorToken } = readParameters(params);
  const cursor = cursorToken === null ? null : readCursor(cursorToken, organizationId, search);
  const { pool } = getRuntimeAuth();

  if (cursor) {
    const anchor = await pool.query(`
      SELECT 1 FROM aevyra.contacts
      WHERE organization_id = $1 AND normalized_phone = $2 AND id = $3
        AND ($4::text = '' OR normalized_phone LIKE $4 || '%')
    `, [organizationId, cursor.normalizedPhone, cursor.id, search]);
    if (anchor.rowCount !== 1) {
      throw invalid("Почетната точка за страницата не е валидна за оваа организација и пребарување.");
    }
  }

  const { rows: [counts] } = await pool.query<{ total: number; matched: number }>(`
    SELECT count(*)::int AS total,
      count(*) FILTER (WHERE $2::text = '' OR normalized_phone LIKE $2 || '%')::int AS matched
    FROM aevyra.contacts
    WHERE organization_id = $1
  `, [organizationId, search]);

  const { rows } = await pool.query<ContactRow>(`
    SELECT contact.id, contact.normalized_phone, contact.created_at,
      suppression.contact_id IS NOT NULL AS has_suppression
    FROM aevyra.contacts AS contact
    LEFT JOIN aevyra.contact_suppressions AS suppression
      ON suppression.organization_id = contact.organization_id AND suppression.contact_id = contact.id
    WHERE contact.organization_id = $1
      AND ($2::text = '' OR contact.normalized_phone LIKE $2 || '%')
      AND ($3::text IS NULL OR (contact.normalized_phone, contact.id) > ($3, $4::uuid))
    ORDER BY contact.normalized_phone ASC, contact.id ASC
    LIMIT $5
  `, [organizationId, search, cursor?.normalizedPhone ?? null, cursor?.id ?? null, limit + 1]);

  const pageRows = rows.slice(0, limit);
  return {
    items: pageRows.map(serialize),
    totalContacts: counts.total,
    matchedContacts: counts.matched,
    nextCursor: rows.length > limit ? issueCursor(organizationId, search, pageRows[pageRows.length - 1]) : null,
  };
}
