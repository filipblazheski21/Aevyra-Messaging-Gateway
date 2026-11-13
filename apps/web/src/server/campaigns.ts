import { readServerConfig } from "@aevyra/config";
import pg from "pg";
import { renderTemplateBody } from "../sms-segments.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUuid(value: string): boolean {
  return UUID_RE.test(value);
}

function purposeForOrganizationType(type: "CLINIC" | "MARKETING"): "PATIENT_INFORMATION" | "AEVYRA_MARKETING" {
  return type === "CLINIC" ? "PATIENT_INFORMATION" : "AEVYRA_MARKETING";
}

async function withPostgresClient<T>(databaseUrl: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export interface CampaignSummary {
  id: string;
  organizationId: string;
  purpose: "PATIENT_INFORMATION" | "AEVYRA_MARKETING";
  channel: "SMS" | "VIBER";
  name: string;
  templateVersionId: string;
  recipientCount: number;
  approvalStatus: "DRAFT" | "APPROVED" | "REVOKED";
  approvedAt: string | null;
  createdAt: string;
}

export interface CreateCampaignRecipientInput {
  contactId: string;
  values?: Record<string, string | null | undefined>;
}

export interface CreateCampaignInput {
  organizationId: string;
  operatorId: string;
  name: string;
  channel: "SMS" | "VIBER";
  templateVersionId: string;
  recipients: CreateCampaignRecipientInput[];
}

export async function listCampaigns(organizationId: string): Promise<
  | { status: "OK"; campaigns: CampaignSummary[] }
  | { status: "NOT_FOUND" }
  | { status: "UNAVAILABLE" }
> {
  if (!isValidUuid(organizationId)) {
    return { status: "NOT_FOUND" };
  }
  const config = readServerConfig();
  try {
    return await withPostgresClient(config.databaseUrl, async (client) => {
      const org = await client.query<{ id: string }>(
        `SELECT id::text FROM aevyra.organizations WHERE id = $1::uuid`,
        [organizationId],
      );
      if (org.rowCount === 0) {
        return { status: "NOT_FOUND" as const };
      }

      const { rows } = await client.query<{
        id: string;
        organization_id: string;
        purpose: "PATIENT_INFORMATION" | "AEVYRA_MARKETING";
        channel: "SMS" | "VIBER";
        name: string;
        template_version_id: string;
        recipient_count: string;
        decision: "APPROVED" | "REVOKED" | null;
        approved_at: Date | null;
        created_at: Date;
      }>(
        `
        SELECT
          c.id::text,
          c.organization_id::text,
          c.purpose,
          c.channel,
          c.name,
          c.template_version_id::text,
          (SELECT count(*)::text FROM aevyra.campaign_recipients cr WHERE cr.campaign_id = c.id) AS recipient_count,
          a.decision,
          a.created_at AS approved_at,
          c.created_at
        FROM aevyra.campaigns c
        LEFT JOIN LATERAL (
          SELECT decision, created_at
          FROM aevyra.campaign_approvals
          WHERE campaign_id = c.id
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        ) a ON true
        WHERE c.organization_id = $1::uuid
        ORDER BY c.created_at DESC, c.id DESC
        `,
        [organizationId],
      );

      return {
        status: "OK" as const,
        campaigns: rows.map((row) => ({
          id: row.id,
          organizationId: row.organization_id,
          purpose: row.purpose,
          channel: row.channel,
          name: row.name,
          templateVersionId: row.template_version_id,
          recipientCount: Number.parseInt(row.recipient_count, 10),
          approvalStatus: row.decision ?? "DRAFT",
          approvedAt: row.approved_at ? row.approved_at.toISOString() : null,
          createdAt: row.created_at.toISOString(),
        })),
      };
    });
  } catch {
    return { status: "UNAVAILABLE" };
  }
}

export async function createCampaign(input: CreateCampaignInput): Promise<
  | { status: "CREATED"; campaign: CampaignSummary }
  | { status: "NOT_FOUND" }
  | { status: "INVALID"; message: string }
  | { status: "UNAVAILABLE" }
> {
  if (!isValidUuid(input.organizationId) || !isValidUuid(input.templateVersionId)) {
    return { status: "INVALID", message: "Невалиден идентификатор на организација или верзија на шаблон." };
  }
  const name = input.name.trim();
  if (name.length < 1 || name.length > 120) {
    return { status: "INVALID", message: "Името на кампањата мора да биде меѓу 1 и 120 знаци." };
  }
  if (input.channel !== "SMS" && input.channel !== "VIBER") {
    return { status: "INVALID", message: "Невалиден канал." };
  }
  if (input.recipients.length === 0) {
    return { status: "INVALID", message: "Кампањата мора да содржи барем еден примач." };
  }
  for (const r of input.recipients) {
    if (!isValidUuid(r.contactId)) {
      return { status: "INVALID", message: "Невалиден идентификатор на контакт." };
    }
  }

  const config = readServerConfig();
  try {
    return await withPostgresClient(config.databaseUrl, async (client) => {
      await client.query("BEGIN");
      try {
        const org = await client.query<{ kind: "CLINIC" | "MARKETING" }>(
          `SELECT kind FROM aevyra.organizations WHERE id = $1::uuid`,
          [input.organizationId],
        );
        if (org.rowCount === 0) {
          await client.query("ROLLBACK");
          return { status: "NOT_FOUND" as const };
        }
        const purpose = purposeForOrganizationType(org.rows[0]!.kind);

        const version = await client.query<{ body: string; allowed_variables: string[] }>(
          `
          SELECT body, allowed_variables
          FROM aevyra.message_template_versions
          WHERE id = $1::uuid AND organization_id = $2::uuid
          `,
          [input.templateVersionId, input.organizationId],
        );
        if (version.rowCount === 0) {
          await client.query("ROLLBACK");
          return { status: "INVALID" as const, message: "Верзијата на шаблонот не е пронајдена за оваа организација." };
        }
        const templateRow = version.rows[0]!;

        const frozenRecipients: Array<{ contactId: string; frozenBody: string }> = [];
        for (const r of input.recipients) {
          const rendered = renderTemplateBody(templateRow.body, templateRow.allowed_variables, r.values ?? {});
          if (!rendered.ok) {
            await client.query("ROLLBACK");
            return { status: "INVALID" as const, message: rendered.error };
          }
          frozenRecipients.push({ contactId: r.contactId, frozenBody: rendered.rendered });
        }

        const campaignRes = await client.query<{ id: string; created_at: Date }>(
          `
          INSERT INTO aevyra.campaigns (
            organization_id, purpose, channel, name, template_version_id, created_by_operator_id
          )
          VALUES ($1::uuid, $2, $3, $4, $5::uuid, $6)
          RETURNING id::text, created_at
          `,
          [input.organizationId, purpose, input.channel, name, input.templateVersionId, input.operatorId],
        );
        const campaignRow = campaignRes.rows[0]!;

        for (const fr of frozenRecipients) {
          await client.query(
            `
            INSERT INTO aevyra.campaign_recipients (campaign_id, organization_id, contact_id, frozen_body)
            VALUES ($1::uuid, $2::uuid, $3::uuid, $4)
            `,
            [campaignRow.id, input.organizationId, fr.contactId, fr.frozenBody],
          );
        }

        await client.query("COMMIT");
        return {
          status: "CREATED" as const,
          campaign: {
            id: campaignRow.id,
            organizationId: input.organizationId,
            purpose,
            channel: input.channel,
            name,
            templateVersionId: input.templateVersionId,
            recipientCount: frozenRecipients.length,
            approvalStatus: "DRAFT",
            approvedAt: null,
            createdAt: campaignRow.created_at.toISOString(),
          },
        };
      } catch (error) {
        await client.query("ROLLBACK");
        if (error instanceof pg.DatabaseError && error.code === "23503") {
          return { status: "INVALID" as const, message: "Еден или повеќе контакти не припаѓаат на оваа организација." };
        }
        throw error;
      }
    });
  } catch {
    return { status: "UNAVAILABLE" };
  }
}

export async function decideCampaignApproval(
  organizationId: string,
  campaignId: string,
  operatorId: string,
  decision: "APPROVED" | "REVOKED",
): Promise<
  | { status: "OK"; decision: "APPROVED" | "REVOKED"; createdAt: string }
  | { status: "NOT_FOUND" }
  | { status: "UNAVAILABLE" }
> {
  if (!isValidUuid(organizationId) || !isValidUuid(campaignId)) {
    return { status: "NOT_FOUND" };
  }
  const config = readServerConfig();
  try {
    return await withPostgresClient(config.databaseUrl, async (client) => {
      const existing = await client.query<{ id: string }>(
        `SELECT id::text FROM aevyra.campaigns WHERE id = $1::uuid AND organization_id = $2::uuid`,
        [campaignId, organizationId],
      );
      if (existing.rowCount === 0) {
        return { status: "NOT_FOUND" as const };
      }
      const res = await client.query<{ created_at: Date }>(
        `
        INSERT INTO aevyra.campaign_approvals (campaign_id, organization_id, decision, operator_id)
        VALUES ($1::uuid, $2::uuid, $3, $4)
        RETURNING created_at
        `,
        [campaignId, organizationId, decision, operatorId],
      );
      return {
        status: "OK" as const,
        decision,
        createdAt: res.rows[0]!.created_at.toISOString(),
      };
    });
  } catch {
    return { status: "UNAVAILABLE" };
  }
}
