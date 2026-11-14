import { NextResponse } from "next/server";
import { getCurrentUserStrict } from "../../../server/auth.ts";
import {
  createSmsGateway,
  listSmsGateways,
  type GatewayInput,
} from "../../../server/sms-gateways.ts";

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

export async function GET(request: Request) {
  const user = await getCurrentUserStrict(request.headers);
  if (!user) {
    return NextResponse.json({ message: "Потребна е најава." }, { status: 401, headers: NO_STORE });
  }
  try {
    return NextResponse.json(await listSmsGateways(), { status: 200, headers: NO_STORE });
  } catch {
    return NextResponse.json({ message: "Услугата е привремено недостапна." }, { status: 503, headers: NO_STORE });
  }
}

export async function POST(request: Request) {
  const user = await getCurrentUserStrict(request.headers);
  if (!user) {
    return NextResponse.json({ message: "Потребна е најава." }, { status: 401, headers: NO_STORE });
  }
  if (!hasSameOrigin(request)) {
    return NextResponse.json({ message: "Недоверливо потекло на барањето." }, { status: 403, headers: NO_STORE });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ message: "Невалиден JSON формат." }, { status: 400, headers: NO_STORE });
  }
  const data = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const input: GatewayInput = {
    name: typeof data.name === "string" ? data.name : "",
    baseUrl: typeof data.baseUrl === "string" ? data.baseUrl : "",
    username: typeof data.username === "string" ? data.username : "",
    password: typeof data.password === "string" ? data.password : "",
    deviceId: typeof data.deviceId === "string" && data.deviceId.trim().length > 0 ? data.deviceId : null,
    enabled: data.enabled !== false,
  };

  const result = await createSmsGateway(input);
  if (result.status === "SAVED") {
    return NextResponse.json({ gateway: result.gateway }, { status: 201, headers: NO_STORE });
  }
  if (result.status === "INVALID") {
    return NextResponse.json({ message: result.message }, { status: 400, headers: NO_STORE });
  }
  if (result.status === "DUPLICATE") {
    return NextResponse.json({ message: "Веќе постои телефон со тоа име." }, { status: 409, headers: NO_STORE });
  }
  return NextResponse.json({ message: "Телефонот не може да се зачува." }, { status: 503, headers: NO_STORE });
}
