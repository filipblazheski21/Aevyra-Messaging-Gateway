import { readServerConfig } from "@aevyra/config";
import pg from "pg";
import { extractTemplateVariables } from "../sms-segments.ts";

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

export interface MessageTemplateSummary {
  id: string;
  organizationId: string;
  purpose: "PATIENT_INFORMATION" | "AEVYRA_MARKETING";
  name: string;
  latestVersion: {
    id: string;
    versionNumber: number;
    body: string;
    allowedVariables: string[];
    createdAt: string;
  };
  createdAt: string;
}

export interface CreateTemplateInput {
  organizationId: string;
  operatorId: string;
  name: string;
  body: string;
  allowedVariables: string[];
}

export async function listMessageTemplates(organizationId: string): Promise<
  | { status: "OK"; templates: MessageTemplateSummary[] }
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
        name: string;
        created_at: Date;
        version_id: string;
        version_number: number;
        body: string;
        allowed_variables: string[];
        version_created_at: Date;
      }>(
        `
        SELECT
          t.id::text,
          t.organization_id::text,
          t.purpose,
          t.name,
          t.created_at,
          v.id::text AS version_id,
          v.version_number,
          v.body,
          v.allowed_variables,
          v.created_at AS version_created_at
        FROM aevyra.message_templates t
        JOIN LATERAL (
          SELECT id, version_number, body, allowed_variables, created_at
          FROM aevyra.message_template_versions
          WHERE template_id = t.id
          ORDER BY version_number DESC
          LIMIT 1
        ) v ON true
        WHERE t.organization_id = $1::uuid
        ORDER BY t.created_at DESC, t.id DESC
        `,
        [organizationId],
      );

      return {
        status: "OK" as const,
        templates: rows.map((row) => ({
          id: row.id,
          organizationId: row.organization_id,
          purpose: row.purpose,
          name: row.name,
          createdAt: row.created_at.toISOString(),
          latestVersion: {
            id: row.version_id,
            versionNumber: row.version_number,
            body: row.body,
            allowedVariables: row.allowed_variables,
            createdAt: row.version_created_at.toISOString(),
          },
        })),
      };
    });
  } catch (error) {
    if (error instanceof pg.DatabaseError || error instanceof Error) {
      return { status: "UNAVAILABLE" };
    }
    return { status: "UNAVAILABLE" };
  }
}

export async function createMessageTemplate(input: CreateTemplateInput): Promise<
  | { status: "CREATED"; template: MessageTemplateSummary }
  | { status: "NOT_FOUND" }
  | { status: "INVALID"; message: string }
  | { status: "UNAVAILABLE" }
> {
  if (!isValidUuid(input.organizationId)) {
    return { status: "NOT_FOUND" };
  }

  const name = input.name.trim();
  const body = input.body.trim();
  if (name.length < 1 || name.length > 120) {
    return { status: "INVALID", message: "Името на шаблонот мора да биде меѓу 1 и 120 знаци." };
  }
  if (body.length < 1 || body.length > 2000) {
    return { status: "INVALID", message: "Содржината на шаблонот мора да биде меѓу 1 и 2000 знаци." };
  }

  const allowedSet = new Set(input.allowedVariables.map((v) => v.trim()).filter((v) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(v)));
  for (const used of extractTemplateVariables(body)) {
    if (!allowedSet.has(used)) {
      return { status: "INVALID", message: `Непозната променлива во шаблонот: {{${used}}}.` };
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

        const templateResult = await client.query<{ id: string; created_at: Date }>(
          `
          INSERT INTO aevyra.message_templates (organization_id, purpose, name, created_by_operator_id)
          VALUES ($1::uuid, $2, $3, $4)
          RETURNING id::text, created_at
          `,
          [input.organizationId, purpose, name, input.operatorId],
        );
        const templateRow = templateResult.rows[0]!;

        const allowedArray = [...allowedSet];
        const versionResult = await client.query<{ id: string; created_at: Date }>(
          `
          INSERT INTO aevyra.message_template_versions (
            template_id, organization_id, version_number, body, allowed_variables, created_by_operator_id
          )
          VALUES ($1::uuid, $2::uuid, 1, $3, $4::text[], $5)
          RETURNING id::text, created_at
          `,
          [templateRow.id, input.organizationId, body, allowedArray, input.operatorId],
        );
        const versionRow = versionResult.rows[0]!;

        await client.query("COMMIT");
        return {
          status: "CREATED" as const,
          template: {
            id: templateRow.id,
            organizationId: input.organizationId,
            purpose,
            name,
            createdAt: templateRow.created_at.toISOString(),
            latestVersion: {
              id: versionRow.id,
              versionNumber: 1,
              body,
              allowedVariables: allowedArray,
              createdAt: versionRow.created_at.toISOString(),
            },
          },
        };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    });
  } catch (error) {
    console.error("createMessageTemplate error:", error);
    return { status: "UNAVAILABLE" };
  }
}
