import type pg from "pg";

export const GATEWAY_NAME_PATTERN = /^[A-Z0-9][A-Z0-9-]{1,39}$/;
export const SUGGESTED_GATEWAY_SUFFIXES = ["Z", "L", "F", "T", "P", "M", "R", "V", "N", "D", "K"] as const;

export interface SmsGatewayIdentity {
  id: string;
  name: string;
  lastUsedAt: Date | string | null;
}

export interface SmsGatewayCredentials extends SmsGatewayIdentity {
  baseUrl: string;
  username: string;
  password: string;
  deviceId: string | null;
}

function usedAt(value: Date | string | null): number | null {
  if (value === null) return null;
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

/**
 * Редослед на испраќање: прво телефоните што никогаш не испраќале,
 * потоа најодамна користените, а при изедначено време по азбучен ред.
 */
export function rotationOrder<T extends SmsGatewayIdentity>(gateways: readonly T[]): T[] {
  return [...gateways].sort((left, right) => {
    const leftTime = usedAt(left.lastUsedAt);
    const rightTime = usedAt(right.lastUsedAt);
    if (leftTime === null && rightTime !== null) return -1;
    if (leftTime !== null && rightTime === null) return 1;
    if (leftTime !== null && rightTime !== null && leftTime !== rightTime) return leftTime - rightTime;
    return left.name.localeCompare(right.name);
  });
}

/** Го предлага следното име по редоследот AEV-SMS-Z, AEV-SMS-L, AEV-SMS-F, AEV-SMS-T... */
export function nextGatewayName(names: readonly string[]): string {
  const used = new Set(names.map((name) => name.trim().toUpperCase()));
  for (const suffix of SUGGESTED_GATEWAY_SUFFIXES) {
    const candidate = `AEV-SMS-${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  for (const code of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
    const candidate = `AEV-SMS-${code}`;
    if (!used.has(candidate)) return candidate;
  }
  return "";
}

/**
 * Ги заклучува и враќа податоците за телефонот што е следен за испраќање,
 * па го означува како користен. Мора да се повика во отворена трансакција.
 */
export async function claimSmsGateway(client: pg.Client): Promise<SmsGatewayCredentials | null> {
  const { rows } = await client.query<{
    id: string;
    name: string;
    base_url: string;
    username: string;
    password: string;
    device_id: string | null;
    last_used_at: Date | null;
  }>(`
    SELECT id::text, name, base_url, username, password, device_id, last_used_at
    FROM aevyra.sms_gateways
    WHERE enabled
    ORDER BY last_used_at ASC NULLS FIRST, name ASC
    FOR UPDATE
    LIMIT 1
  `);
  const row = rows[0];
  if (!row) return null;

  await client.query(
    `UPDATE aevyra.sms_gateways SET last_used_at = now(), updated_at = now() WHERE id = $1::uuid`,
    [row.id],
  );

  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    username: row.username,
    password: row.password,
    deviceId: row.device_id,
    lastUsedAt: row.last_used_at,
  };
}
