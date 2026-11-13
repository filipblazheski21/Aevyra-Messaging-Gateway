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
  context: { params: Promise<{ id: string; campaignId: string }> },
) {
  const user = await getCurrentUserStrict(request.headers);
  if (!user) {
    return NextResponse.json({ message: "Потребна е најава." }, { status: 401, headers: NO_STORE });
  }
  if (!hasSameOrigin(request)) {
    return NextResponse.json({ message: "Недоверливо потекло на барањето." }, { status: 403, headers: NO_STORE });
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
    const campaignRes = await client.query<{ channel: "SMS" | "VIBER"; decision: string | null }>(
      `
      SELECT
        c.channel,
        (
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
    const campaign = campaignRes.rows[0]!;
    if (campaign.decision !== "APPROVED") {
      await client.query("ROLLBACK");
      return NextResponse.json({ message: "Кампањата мора да биде одобрена пред ставање во редица." }, { status: 409, headers: NO_STORE });
    }

    const recipientsRes = await client.query<{ id: string; contact_id: string; frozen_body: string }>(
      `
      SELECT id::text, contact_id::text, frozen_body
      FROM aevyra.campaign_recipients
      WHERE campaign_id = $1::uuid AND organization_id = $2::uuid
      `,
      [campaignId, organizationId],
    );

    let enqueuedCount = 0;
    for (const recipient of recipientsRes.rows) {
      const idempotencyKey = `${campaignId}:${recipient.contact_id}`;
      const inserted = await client.query<{ id: string }>(
        `
        INSERT INTO aevyra.message_jobs (
          organization_id, campaign_id, recipient_id, contact_id, channel, frozen_body, idempotency_key
        )
        VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7)
        ON CONFLICT (campaign_id, contact_id) DO NOTHING
        RETURNING id::text
        `,
        [organizationId, campaignId, recipient.id, recipient.contact_id, campaign.channel, recipient.frozen_body, idempotencyKey],
      );
      if (inserted.rowCount && inserted.rowCount > 0) {
        enqueuedCount += 1;
        await client.query(
          `
          INSERT INTO aevyra.message_job_events (job_id, organization_id, status, detail)
          VALUES ($1::uuid, $2::uuid, 'QUEUED', 'Ставено во трајна редица.')
          `,
          [inserted.rows[0]!.id, organizationId],
        );
      }
    }

    await client.query("COMMIT");
    return NextResponse.json({ enqueuedCount }, { status: 200, headers: NO_STORE });
  } catch {
    await client.query("ROLLBACK").catch(() => {});
    return NextResponse.json({ message: "Услугата е привремено недостапна." }, { status: 503, headers: NO_STORE });
  } finally {
    await client.end().catch(() => {});
  }
}
