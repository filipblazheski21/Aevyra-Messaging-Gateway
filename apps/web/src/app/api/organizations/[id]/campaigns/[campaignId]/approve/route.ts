import { NextResponse } from "next/server";
import { getCurrentUserStrict } from "../../../../../../../server/auth.ts";
import { decideCampaignApproval } from "../../../../../../../server/campaigns.ts";

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

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; campaignId: string }> },
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

  const decision = (body as Record<string, unknown>).decision;
  if (decision !== "APPROVED" && decision !== "REVOKED") {
    return NextResponse.json({ message: "Невалидна одлука за одобрување." }, { status: 400, headers: NO_STORE });
  }

  const { id, campaignId } = await context.params;
  const result = await decideCampaignApproval(id, campaignId, user.id, decision);
  if (result.status === "NOT_FOUND") {
    return NextResponse.json({ message: "Кампањата не е пронајдена." }, { status: 404, headers: NO_STORE });
  }
  if (result.status === "UNAVAILABLE") {
    return NextResponse.json({ message: "Услугата е привремено недостапна." }, { status: 503, headers: NO_STORE });
  }

  return NextResponse.json(
    { decision: result.decision, createdAt: result.createdAt },
    { status: 200, headers: NO_STORE },
  );
}
