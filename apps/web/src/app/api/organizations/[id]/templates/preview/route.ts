import { NextResponse } from "next/server";
import { getCurrentUserStrict } from "../../../../../../server/auth.ts";
import { renderTemplateBody } from "../../../../../../sms-segments.ts";

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

  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ message: "Телото на барањето мора да биде JSON објект." }, { status: 400, headers: NO_STORE });
  }

  const record = body as Record<string, unknown>;
  const templateBody = typeof record.body === "string" ? record.body : "";
  const allowedVariables = Array.isArray(record.allowedVariables)
    ? record.allowedVariables.filter((v): v is string => typeof v === "string")
    : [];
  const rawValues = typeof record.values === "object" && record.values !== null
    ? (record.values as Record<string, unknown>)
    : {};

  const values: Record<string, string | null | undefined> = {};
  for (const [k, v] of Object.entries(rawValues)) {
    values[k] = typeof v === "string" ? v : undefined;
  }

  const rendered = renderTemplateBody(templateBody, allowedVariables, values);
  if (!rendered.ok) {
    return NextResponse.json({ message: rendered.error }, { status: 400, headers: NO_STORE });
  }

  return NextResponse.json(
    { rendered: rendered.rendered, estimate: rendered.estimate },
    { status: 200, headers: NO_STORE },
  );
}
