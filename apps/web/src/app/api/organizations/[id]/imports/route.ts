import { confirmContactImport, getContactImports } from "../../../../../server/contact-import-http.ts";
import { organizationResponse } from "../../../../../server/organizations-http.ts";
import { getOrganization } from "../../../../../server/organizations.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export function POST(request: Request, { params }: Context) {
  return organizationResponse(request, async (operator) => {
    const { id } = await getOrganization((await params).id);
    return confirmContactImport(request, id, operator.id);
  });
}

export function GET(request: Request, { params }: Context) {
  return organizationResponse(request, async (operator) => {
    const { id } = await getOrganization((await params).id);
    return getContactImports(request, id, operator.id);
  });
}
