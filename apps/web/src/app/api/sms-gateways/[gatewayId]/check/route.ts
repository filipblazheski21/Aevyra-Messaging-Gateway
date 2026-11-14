import { NextResponse } from "next/server";
import { getCurrentUserStrict } from "../../../../../server/auth.ts";
import { checkSmsGateway } from "../../../../../server/sms-gateways.ts";

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

export async function POST(request: Request, context: { params: Promise<{ gatewayId: string }> }) {
  const user = await getCurrentUserStrict(request.headers);
  if (!user) {
    return NextResponse.json({ message: "Потребна е најава." }, { status: 401, headers: NO_STORE });
  }
  if (!hasSameOrigin(request)) {
    return NextResponse.json({ message: "Недоверливо потекло на барањето." }, { status: 403, headers: NO_STORE });
  }

  const { gatewayId } = await context.params;
  const result = await checkSmsGateway(gatewayId);
  if (result.status === "NOT_FOUND") {
    return NextResponse.json({ message: "Телефонот не е пронајден." }, { status: 404, headers: NO_STORE });
  }
  if (result.status === "UNAVAILABLE") {
    return NextResponse.json({ message: "Услугата е привремено недостапна." }, { status: 503, headers: NO_STORE });
  }
  return NextResponse.json(
    { status: result.status, detail: result.detail },
    { status: result.status === "OK" ? 200 : 502, headers: NO_STORE },
  );
}
