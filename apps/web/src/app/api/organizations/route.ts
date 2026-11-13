import { organizationResponse, readOrganizationBody } from "../../../server/organizations-http.ts";
import { createOrganization, listOrganizations } from "../../../server/organizations.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return organizationResponse(request, () => listOrganizations(new URL(request.url).searchParams));
}

export async function POST(request: Request) {
  return organizationResponse(request, async () => createOrganization(await readOrganizationBody(request)), 201);
}
