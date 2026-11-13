import { readServerConfig } from "@aevyra/config";
import { NextResponse } from "next/server";
import pg from "pg";
import { getCurrentUserStrict } from "../../../../../../../server/auth.ts";

const NO_STORE = { "Cache-Control": "private, no-store" };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_ACTIONS = new Set(["START", "STOP", "RESUME", "CANCEL"]);

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
  const action = typeof body === "object" && body !== null ? (body as Record<string, unknown>).action : null;
  if (typeof action !== "string" || !VALID_ACTIONS.has(action)) {
    return NextResponse.json({ message: "Невалидна контролна акција." }, { status: 400, headers: NO_STORE });
  }

  const { id: organizationId, campaignId } = await context.params;
  if (!UUID_RE.test(organizationId) || !UUID_RE.test(campaignId)) {
    return NextResponse.json({ message: "Кампањата не е пронајдена." }, { status: 404, headers: NO_STORE });
  }

  const config = readServerConfig();
  const client = new pg.Client({ connectionString: config.databaseUrl });
  try {
    await client.connect();
    await client.query("BEGIN");
    const campaignRes = await client.query<{ decision: string | null }>(
      `
      SELECT (
        SELECT decision
        FROM aevyra.campaign_approvals ca
        WHERE ca.campaign_id = c.id
        ORDER BY ca.created_at DESC, ca.id DESC
        LIMIT 1
      ) AS decision
      FROM aevyra.campaigns c
      WHERE c.id = $1::uuid AND c.organization_id = $2::uuid
      `,
      [campaignId, organizationId],
    );
    if (campaignRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return NextResponse.json({ message: "Кампањата не е пронајдена." }, { status: 404, headers: NO_STORE });
    }
    if ((action === "START" || action === "RESUME") && campaignRes.rows[0]!.decision !== "APPROVED") {
      await client.query("ROLLBACK");
      return NextResponse.json({ message: "Кампањата мора да биде одобрена пред старт." }, { status: 409, headers: NO_STORE });
    }

    const inserted = await client.query<{ created_at: Date }>(
      `
      INSERT INTO aevyra.campaign_control_events (campaign_id, organization_id, action, operator_id)
      VALUES ($1::uuid, $2::uuid, $3, $4)
      RETURNING created_at
      `,
      [campaignId, organizationId, action, user.id],
    );

    if (action === "CANCEL") {
      await client.query(
        `
        INSERT INTO aevyra.message_job_events (job_id, organization_id, status, detail)
        SELECT j.id, j.organization_id, 'CANCELLED', 'Кампањата е откажана.'
        FROM aevyra.message_jobs j
        WHERE j.campaign_id = $1::uuid AND j.organization_id = $2::uuid
          AND NOT EXISTS (
            SELECT 1 FROM aevyra.message_job_events e
            WHERE e.job_id = j.id AND e.status IN ('SIMULATED_SENT', 'FAILED', 'CANCELLED')
          )
        `,
        [campaignId, organizationId],
      );
    }

    await client.query("COMMIT");
    return NextResponse.json(
      { action, createdAt: inserted.rows[0]!.created_at.toISOString() },
      { status: 200, headers: NO_STORE },
    );
  } catch {
    await client.query("ROLLBACK").catch(() => {});
    return NextResponse.json({ message: "Услугата е привремено недостапна." }, { status: 503, headers: NO_STORE });
  } finally {
    await client.end().catch(() => {});
  }
}
