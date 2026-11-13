import { previewContactImport } from "../../../../../../../server/contact-import-http.ts";
import { organizationResponse } from "../../../../../../../server/organizations-http.ts";
import { getOrganization } from "../../../../../../../server/organizations.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return organizationResponse(request, async (operator) => {
    const organization = await getOrganization((await params).id);
    return previewContactImport(request, organization, operator.id, "xlsx");
  });
}
