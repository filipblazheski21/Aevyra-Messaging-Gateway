import { listContacts } from "../../../../../server/contacts.ts";
import { organizationResponse } from "../../../../../server/organizations-http.ts";
import { getOrganization } from "../../../../../server/organizations.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export function GET(request: Request, { params }: Context) {
  return organizationResponse(request, async () => {
    const { id } = await getOrganization((await params).id);
    return listContacts(id, new URL(request.url).searchParams);
  }, 200, { strictSession: true, unavailableMessage: "Контактите моментално се недостапни. Обидете се повторно." });
}
