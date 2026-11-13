import type { Organization, OrganizationKind, OrganizationPage } from "../organizations.ts";
import { getRuntimeAuth } from "./auth.ts";

export class OrganizationError extends Error {
  readonly status: 400 | 404;

  constructor(message: string, status: 400 | 404 = 400) {
    super(message);
    this.status = status;
  }
}

type OrganizationRow = Omit<Organization, "created_at"> & { created_at: Date };

function serialize(row: OrganizationRow): Organization {
  return { ...row, created_at: row.created_at.toISOString() };
}

function validateId(id: string) {
  if (id.length !== 36 || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) {
    throw new OrganizationError("Идентификаторот мора да биде валиден UUID.");
  }
  return id;
}

function validateKind(kind: unknown): OrganizationKind {
  if (kind !== "CLINIC" && kind !== "MARKETING") {
    throw new OrganizationError("Видот мора да биде CLINIC или MARKETING.");
  }
  return kind;
}

function readFields(input: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new OrganizationError("Внесените податоци не се валидни.");
  }
  if (Object.keys(input).some((key) => !allowed.includes(key))) {
    throw new OrganizationError("Барањето содржи недозволени полиња.");
  }
  return input as Record<string, unknown>;
}

function validateName(input: unknown) {
  if (typeof input !== "string") throw new OrganizationError("Внесете име.");
  const name = input.trim();
  if (!name || Array.from(name).length > 200 || name.includes("\0") || !name.isWellFormed()) {
    throw new OrganizationError("Името мора да има од 1 до 200 валидни знаци.");
  }
  return name;
}

export async function listOrganizations(params: URLSearchParams): Promise<OrganizationPage> {
  for (const key of params.keys()) {
    if (!["kind", "limit", "cursor"].includes(key) || params.getAll(key).length !== 1) {
      throw new OrganizationError("Параметрите за листата не се валидни.");
    }
  }
  const kindParam = params.get("kind");
  const kind = kindParam === null ? null : validateKind(kindParam);
  const limitParam = params.get("limit") ?? "25";
  const limit = Number(limitParam);
  if (String(limit) !== limitParam || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new OrganizationError("Бројот на записи мора да биде од 1 до 100.");
  }

  const cursor = params.get("cursor");
  const { pool } = getRuntimeAuth();
  let anchorTime: string | null = null;
  if (cursor !== null) {
    const anchor = await pool.query<{ created_at: string }>(`
      SELECT created_at::text FROM aevyra.organizations
      WHERE id = $1 AND ($2::text IS NULL OR kind = $2)
    `, [validateId(cursor), kind]);
    if (!anchor.rows[0]) throw new OrganizationError("Почетната точка за следната страница не е валидна.");
    anchorTime = anchor.rows[0].created_at;
  }

  const { rows } = await pool.query<OrganizationRow>(`
    SELECT id, kind, name, created_at FROM aevyra.organizations
    WHERE ($1::text IS NULL OR kind = $1)
      AND ($2::timestamptz IS NULL OR (created_at, id) < ($2, $3::uuid))
    ORDER BY created_at DESC, id DESC
    LIMIT $4
  `, [kind, anchorTime, cursor, limit + 1]);
  const items = rows.slice(0, limit).map(serialize);
  return { items, nextCursor: rows.length > limit ? items[limit - 1].id : null };
}

export async function createOrganization(input: unknown) {
  const fields = readFields(input, ["name", "kind"]);
  const name = validateName(fields.name);
  const kind = validateKind(fields.kind);
  const { rows } = await getRuntimeAuth().pool.query<OrganizationRow>(`
    INSERT INTO aevyra.organizations (name, kind) VALUES ($1, $2)
    RETURNING id, kind, name, created_at
  `, [name, kind]);
  return serialize(rows[0]);
}

function requireOrganization(row: OrganizationRow | undefined) {
  if (!row) throw new OrganizationError("Записот не е пронајден.", 404);
  return serialize(row);
}

export async function getOrganization(id: string) {
  const { rows } = await getRuntimeAuth().pool.query<OrganizationRow>(`
    SELECT id, kind, name, created_at FROM aevyra.organizations WHERE id = $1
  `, [validateId(id)]);
  return requireOrganization(rows[0]);
}

export async function renameOrganization(id: string, input: unknown) {
  const fields = readFields(input, ["name"]);
  const name = validateName(fields.name);
  const { rows } = await getRuntimeAuth().pool.query<OrganizationRow>(`
    UPDATE aevyra.organizations SET name = $1 WHERE id = $2
    RETURNING id, kind, name, created_at
  `, [name, validateId(id)]);
  return requireOrganization(rows[0]);
}
