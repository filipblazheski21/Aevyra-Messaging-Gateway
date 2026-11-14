import { NextResponse } from "next/server";
import { getCurrentUserStrict } from "../../../../server/auth.ts";
import { updateSmsGateway, type GatewayInput } from "../../../../server/sms-gateways.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store" };

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

export async function PATCH(request: Request, context: { params: Promise<{ gatewayId: string }> }) {
  const user = await getCurrentUserStrict(request.headers);
  if (!user) {
    return NextResponse.json({ message: "Потребна е најава." }, { status: 401, headers: NO_STORE });
  }
  if (!hasSameOrigin(request)) {
    return NextResponse.json({ message: "Недоверливо потекло на барањето." }, { status: 403, headers: NO_STORE });
  }

  const { gatewayId } = await context.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ message: "Невалиден JSON формат." }, { status: 400, headers: NO_STORE });
  }
  const data = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const patch: Partial<GatewayInput> = {};
  if (typeof data.name === "string") patch.name = data.name;
  if (typeof data.baseUrl === "string") patch.baseUrl = data.baseUrl;
  if (typeof data.username === "string") patch.username = data.username;
  if (typeof data.password === "string" && data.password.length > 0) patch.password = data.password;
  if (data.deviceId === null || typeof data.deviceId === "string") {
    patch.deviceId = data.deviceId === null ? null : data.deviceId;
  }
  if (typeof data.enabled === "boolean") patch.enabled = data.enabled;

  const result = await updateSmsGateway(gatewayId, patch);
  if (result.status === "SAVED") {
    return NextResponse.json({ gateway: result.gateway }, { status: 200, headers: NO_STORE });
  }
  if (result.status === "INVALID") {
    return NextResponse.json({ message: result.message }, { status: 400, headers: NO_STORE });
  }
  if (result.status === "DUPLICATE") {
    return NextResponse.json({ message: "Веќе постои телефон со тоа име." }, { status: 409, headers: NO_STORE });
  }
  if (result.status === "NOT_FOUND") {
    return NextResponse.json({ message: "Телефонот не е пронајден." }, { status: 404, headers: NO_STORE });
  }
  return NextResponse.json({ message: "Телефонот не може да се зачува." }, { status: 503, headers: NO_STORE });
}
