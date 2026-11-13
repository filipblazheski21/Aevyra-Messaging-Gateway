import { randomUUID } from "node:crypto";
import { readServerConfig } from "@aevyra/config";
import { NextResponse } from "next/server";
import pg from "pg";
import { getCurrentUserStrict } from "../../../../../../../server/auth.ts";

const NO_STORE = { "Cache-Control": "private, no-store" };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function hasSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  if (origin === "http://127.0.0.1:3000" || origin === "http://localhost:3000") return true;
  try {
    return origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; contactId: string }> },
) {
  const user = await getCurrentUserStrict(request.headers);
  if (!user) {
    return NextResponse.json({ message: "Потребна е најава." }, { status: 401, headers: NO_STORE });
  }
  if (!hasSameOrigin(request)) {
    return NextResponse.json({ message: "Недоверливо потекло на барањето." }, { status: 403, headers: NO_STORE });
  }

  const { id: organizationId, contactId } = await context.params;
  if (!UUID_RE.test(organizationId) || !UUID_RE.test(contactId)) {
    return NextResponse.json({ message: "Контактот не е пронајден." }, { status: 404, headers: NO_STORE });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ message: "Невалиден JSON формат." }, { status: 400, headers: NO_STORE });
  }
  const message = typeof body === "object" && body !== null ? (body as Record<string, unknown>).message : null;
  if (typeof message !== "string" || message.trim().length === 0 || message.trim().length > 1000) {
    return NextResponse.json({ message: "Пораката мора да содржи меѓу 1 и 1000 знаци." }, { status: 400, headers: NO_STORE });
  }

  const gateUrl = process.env.SMSGATE_URL?.trim();
  const gateUser = process.env.SMSGATE_USER?.trim();
  const gatePass = process.env.SMSGATE_PASSWORD?.trim();
  if (!gateUrl || !gateUser || !gatePass) {
    return NextResponse.json(
      { message: "SMSGate не е конфигуриран (SMSGATE_URL, SMSGATE_USER, SMSGATE_PASSWORD)." },
      { status: 503, headers: NO_STORE },
    );
  }

  const config = readServerConfig();
  const client = new pg.Client({ connectionString: config.databaseUrl });
  let phoneNumber: string;
  try {
    await client.connect();
    const res = await client.query<{ normalized_phone: string; suppressed: boolean }>(
      `
      SELECT
        c.normalized_phone,
        EXISTS (
          SELECT 1 FROM aevyra.contact_suppressions cs
          WHERE cs.organization_id = c.organization_id AND cs.contact_id = c.id
        ) AS suppressed
      FROM aevyra.contacts c
      WHERE c.id = $1::uuid AND c.organization_id = $2::uuid
      `,
      [contactId, organizationId],
    );
    if (res.rowCount === 0) {
      return NextResponse.json({ message: "Контактот не е пронајден." }, { status: 404, headers: NO_STORE });
    }
    if (res.rows[0]!.suppressed) {
      return NextResponse.json({ message: "Контактот е означен со „Не контактирај“." }, { status: 409, headers: NO_STORE });
    }
    phoneNumber = res.rows[0]!.normalized_phone;
  } catch {
    return NextResponse.json({ message: "Базата на податоци е недостапна." }, { status: 503, headers: NO_STORE });
  } finally {
    await client.end().catch(() => {});
  }

  const externalId = randomUUID();
  const auth = Buffer.from(`${gateUser}:${gatePass}`, "utf8").toString("base64");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${gateUrl.replace(/\/+$/, "")}/message`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify({
        id: externalId,
        message: message.trim(),
        phoneNumbers: [phoneNumber],
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      return NextResponse.json({ message: `SMSGate врати грешка (${response.status}).` }, { status: 502, headers: NO_STORE });
    }
    return NextResponse.json({ status: "ACCEPTED", externalId }, { status: 200, headers: NO_STORE });
  } catch {
    return NextResponse.json({ message: "Неуспешно поврзување со SMSGate." }, { status: 502, headers: NO_STORE });
  } finally {
    clearTimeout(timer);
  }
}
