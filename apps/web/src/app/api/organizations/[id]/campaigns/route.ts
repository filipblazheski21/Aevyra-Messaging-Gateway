import { NextResponse } from "next/server";
import { getCurrentUserStrict } from "../../../../../server/auth.ts";
import { createCampaign, listCampaigns } from "../../../../../server/campaigns.ts";

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

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUserStrict(request.headers);
  if (!user) {
    return NextResponse.json({ message: "Потребна е најава." }, { status: 401, headers: NO_STORE });
  }

  const { id } = await context.params;
  const result = await listCampaigns(id);
  if (result.status === "NOT_FOUND") {
    return NextResponse.json({ message: "Организацијата не е пронајдена." }, { status: 404, headers: NO_STORE });
  }
  if (result.status === "UNAVAILABLE") {
    return NextResponse.json({ message: "Услугата е привремено недостапна." }, { status: 503, headers: NO_STORE });
  }
  return NextResponse.json({ campaigns: result.campaigns }, { status: 200, headers: NO_STORE });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
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
  const name = typeof record.name === "string" ? record.name : "";
  const channel = record.channel === "VIBER" ? "VIBER" : "SMS";
  const templateVersionId = typeof record.templateVersionId === "string" ? record.templateVersionId : "";
  const rawRecipients = Array.isArray(record.recipients) ? record.recipients : [];
  const recipients = rawRecipients
    .filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null)
    .map((r) => ({
      contactId: typeof r.contactId === "string" ? r.contactId : "",
      values: typeof r.values === "object" && r.values !== null
        ? (r.values as Record<string, string | null | undefined>)
        : undefined,
    }));

  const { id } = await context.params;
  const result = await createCampaign({
    organizationId: id,
    operatorId: user.id,
    name,
    channel,
    templateVersionId,
    recipients,
  });

  if (result.status === "NOT_FOUND") {
    return NextResponse.json({ message: "Организацијата не е пронајдена." }, { status: 404, headers: NO_STORE });
  }
  if (result.status === "INVALID") {
    return NextResponse.json({ message: result.message }, { status: 400, headers: NO_STORE });
  }
  if (result.status === "UNAVAILABLE") {
    return NextResponse.json({ message: "Услугата е привремено недостапна." }, { status: 503, headers: NO_STORE });
  }

  return NextResponse.json({ campaign: result.campaign }, { status: 201, headers: NO_STORE });
}
