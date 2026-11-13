import { organizationResponse, readOrganizationBody } from "../../../../server/organizations-http.ts";
import { getOrganization, renameOrganization } from "../../../../server/organizations.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Context) {
  return organizationResponse(request, async () => getOrganization((await params).id));
}

export async function PATCH(request: Request, { params }: Context) {
  return organizationResponse(request, async () => renameOrganization((await params).id, await readOrganizationBody(request)));
}
