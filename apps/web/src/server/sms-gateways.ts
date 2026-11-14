import { readServerConfig } from "@aevyra/config";
import { GATEWAY_NAME_PATTERN, nextGatewayName, rotationOrder } from "@aevyra/db";
import pg from "pg";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SmsGatewaySummary {
  id: string;
  name: string;
  baseUrl: string;
  username: string;
  deviceId: string | null;
  enabled: boolean;
  lastUsedAt: string | null;
  lastCheckedAt: string | null;
  lastCheckStatus: "OK" | "FAILED" | null;
  lastCheckDetail: string | null;
}

export interface SmsGatewayList {
  gateways: SmsGatewaySummary[];
  suggestedName: string;
  nextGateway: string | null;
}

interface GatewayRow {
  id: string;
  name: string;
  base_url: string;
  username: string;
  device_id: string | null;
  enabled: boolean;
  last_used_at: Date | null;
  last_checked_at: Date | null;
  last_check_status: "OK" | "FAILED" | null;
  last_check_detail: string | null;
}

const gatewaySelection = `
  SELECT id::text, name, base_url, username, device_id, enabled,
    last_used_at, last_checked_at, last_check_status, last_check_detail
  FROM aevyra.sms_gateways
  ORDER BY name ASC
`;

function toSummary(row: GatewayRow): SmsGatewaySummary {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    username: row.username,
    deviceId: row.device_id,
    enabled: row.enabled,
    lastUsedAt: row.last_used_at?.toISOString() ?? null,
    lastCheckedAt: row.last_checked_at?.toISOString() ?? null,
    lastCheckStatus: row.last_check_status,
    lastCheckDetail: row.last_check_detail,
  };
}

export async function listSmsGateways(): Promise<SmsGatewayList> {
  const client = new pg.Client({ connectionString: readServerConfig().databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query<GatewayRow>(gatewaySelection);
    const gateways = rows.map(toSummary);
    const next = rotationOrder(gateways.filter((gateway) => gateway.enabled))[0];
    return {
      gateways,
      suggestedName: nextGatewayName(gateways.map((gateway) => gateway.name)),
      nextGateway: next?.name ?? null,
    };
  } finally {
    await client.end().catch(() => {});
  }
}

export function normalizeGatewayName(value: string): string {
  return value.trim().toUpperCase();
}

export function normalizeBaseUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    if (!url.hostname || !["http:", "https:"].includes(url.protocol)) return null;
    if (url.search || url.hash) return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

export interface GatewayInput {
  name: string;
  baseUrl: string;
  username: string;
  password: string;
  deviceId: string | null;
  enabled: boolean;
}

export type GatewayWriteResult =
  | { status: "SAVED"; gateway: SmsGatewaySummary }
  | { status: "INVALID"; message: string }
  | { status: "DUPLICATE" }
  | { status: "NOT_FOUND" }
  | { status: "UNAVAILABLE" };

export function validateGatewayInput(input: Partial<GatewayInput>): string | null {
  if (!input.name || !GATEWAY_NAME_PATTERN.test(normalizeGatewayName(input.name))) {
    return "Името мора да започнува со буква или број и да содржи само големи букви, бројки и цртички (на пр. AEV-SMS-Z).";
  }
  if (!input.baseUrl || !normalizeBaseUrl(input.baseUrl)) {
    return "Адресата мора да биде валиден http или https линк (на пр. http://192.168.0.57:8080).";
  }
  if (!input.username || input.username.trim().length === 0 || input.username.trim().length > 120) {
    return "Корисничкото име е задолжително (најмногу 120 знаци).";
  }
  if (!input.password || input.password.length === 0 || input.password.length > 200) {
    return "Лозинката е задолжителна (најмногу 200 знаци).";
  }
  if (input.deviceId !== null && input.deviceId !== undefined && input.deviceId.trim().length > 120) {
    return "Идентификаторот на уредот може да содржи најмногу 120 знаци.";
  }
  return null;
}

function pickRow(rows: GatewayRow[]): SmsGatewaySummary | null {
  return rows[0] ? toSummary(rows[0]) : null;
}

export async function createSmsGateway(input: GatewayInput): Promise<GatewayWriteResult> {
  const problem = validateGatewayInput(input);
  if (problem) return { status: "INVALID", message: problem };

  const client = new pg.Client({ connectionString: readServerConfig().databaseUrl });
  try {
    await client.connect();
    const { rows } = await client.query<GatewayRow>(
      `
      INSERT INTO aevyra.sms_gateways (name, base_url, username, password, device_id, enabled)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id::text, name, base_url, username, device_id, enabled,
        last_used_at, last_checked_at, last_check_status, last_check_detail
      `,
      [
        normalizeGatewayName(input.name),
        normalizeBaseUrl(input.baseUrl),
        input.username.trim(),
        input.password,
        input.deviceId?.trim() || null,
        input.enabled,
      ],
    );
    const gateway = pickRow(rows);
    return gateway ? { status: "SAVED", gateway } : { status: "UNAVAILABLE" };
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "23505") {
      return { status: "DUPLICATE" };
    }
    return { status: "UNAVAILABLE" };
  } finally {
    await client.end().catch(() => {});
  }
}

export async function updateSmsGateway(
  gatewayId: string,
  patch: Partial<GatewayInput>,
): Promise<GatewayWriteResult> {
  if (!UUID_RE.test(gatewayId)) return { status: "NOT_FOUND" };

  const client = new pg.Client({ connectionString: readServerConfig().databaseUrl });
  try {
    await client.connect();
    await client.query("BEGIN");
    const current = await client.query<GatewayRow & { password: string }>(
      `
      SELECT id::text, name, base_url, username, password, device_id, enabled,
        last_used_at, last_checked_at, last_check_status, last_check_detail
      FROM aevyra.sms_gateways
      WHERE id = $1::uuid
      FOR UPDATE
      `,
      [gatewayId],
    );
    const existing = current.rows[0];
    if (!existing) {
      await client.query("ROLLBACK");
      return { status: "NOT_FOUND" };
    }

    const merged: GatewayInput = {
      name: patch.name !== undefined ? patch.name : existing.name,
      baseUrl: patch.baseUrl !== undefined ? patch.baseUrl : existing.base_url,
      username: patch.username !== undefined ? patch.username : existing.username,
      password: patch.password !== undefined && patch.password.length > 0 ? patch.password : existing.password,
      deviceId: patch.deviceId !== undefined ? patch.deviceId : existing.device_id,
      enabled: patch.enabled !== undefined ? patch.enabled : existing.enabled,
    };
    const problem = validateGatewayInput(merged);
    if (problem) {
      await client.query("ROLLBACK");
      return { status: "INVALID", message: problem };
    }

    const { rows } = await client.query<GatewayRow>(
      `
      UPDATE aevyra.sms_gateways
      SET name = $2, base_url = $3, username = $4, password = $5, device_id = $6, enabled = $7, updated_at = now()
      WHERE id = $1::uuid
      RETURNING id::text, name, base_url, username, device_id, enabled,
        last_used_at, last_checked_at, last_check_status, last_check_detail
      `,
      [
        gatewayId,
        normalizeGatewayName(merged.name),
        normalizeBaseUrl(merged.baseUrl),
        merged.username.trim(),
        merged.password,
        merged.deviceId?.trim() || null,
        merged.enabled,
      ],
    );
    await client.query("COMMIT");
    const gateway = pickRow(rows);
    return gateway ? { status: "SAVED", gateway } : { status: "UNAVAILABLE" };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "23505") {
      return { status: "DUPLICATE" };
    }
    return { status: "UNAVAILABLE" };
  } finally {
    await client.end().catch(() => {});
  }
}

export type GatewayCheckResult =
  | { status: "OK"; detail: string }
  | { status: "FAILED"; detail: string }
  | { status: "NOT_FOUND" }
  | { status: "UNAVAILABLE" };

export async function checkSmsGateway(gatewayId: string): Promise<GatewayCheckResult> {
  if (!UUID_RE.test(gatewayId)) return { status: "NOT_FOUND" };

  const client = new pg.Client({ connectionString: readServerConfig().databaseUrl });
  let target: { baseUrl: string; username: string; password: string };
  try {
    await client.connect();
    const { rows } = await client.query<{ base_url: string; username: string; password: string }>(
      `SELECT base_url, username, password FROM aevyra.sms_gateways WHERE id = $1::uuid`,
      [gatewayId],
    );
    if (!rows[0]) return { status: "NOT_FOUND" };
    target = { baseUrl: rows[0].base_url, username: rows[0].username, password: rows[0].password };
  } catch {
    return { status: "UNAVAILABLE" };
  } finally {
    await client.end().catch(() => {});
  }

  let status: "OK" | "FAILED" = "FAILED";
  let detail: string;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const auth = Buffer.from(`${target.username}:${target.password}`, "utf8").toString("base64");
    const response = await fetch(`${target.baseUrl.replace(/\/+$/, "")}/message?limit=1`, {
      headers: { Authorization: `Basic ${auth}` },
      signal: controller.signal,
      cache: "no-store",
    });
    if (response.ok) {
      status = "OK";
      detail = "Успешна врска со телефонот.";
    } else if (response.status === 401 || response.status === 403) {
      detail = "Телефонот е достапен, но корисничкото име или лозинката не се точни.";
    } else {
      detail = `Телефонот одговори со грешка (${response.status}).`;
    }
  } catch {
    detail = "Не може да се воспостави врска со телефонот. Проверете ја адресата и дали SMSGate работи.";
  } finally {
    clearTimeout(timer);
  }

  const writer = new pg.Client({ connectionString: readServerConfig().databaseUrl });
  try {
    await writer.connect();
    await writer.query(
      `
      UPDATE aevyra.sms_gateways
      SET last_checked_at = now(), last_check_status = $2, last_check_detail = $3, updated_at = now()
      WHERE id = $1::uuid
      `,
      [gatewayId, status, detail],
    );
  } catch {
    // Проверката останува важечка и кога статусот не може да се запише.
  } finally {
    await writer.end().catch(() => {});
  }

  return { status, detail };
}
