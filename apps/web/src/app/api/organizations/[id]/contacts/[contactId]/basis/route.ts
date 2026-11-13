import type {
  PreparedContactBasisRecord,
  PreparedContactBasisWithdrawal,
} from "../../../../../../../server/contact-bases.ts";
import {
  readContactBasisState,
  recordContactBasis,
  withdrawContactBasis,
} from "../../../../../../../server/contact-bases.ts";
import {
  basisReply,
  contactBasisResponse,
  readContactBasisBody,
  readContactBasisQuery,
  rejectContactBasisPostQuery,
} from "../../../../../../../server/contact-basis-http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string; contactId: string }> };

export function GET(request: Request, { params }: Context) {
  return contactBasisResponse(request, async () => {
    const query = readContactBasisQuery(request);
    const { id, contactId } = await params;
    const current = await readContactBasisState(id, contactId, query.purpose, query.channel);
    return basisReply(current);
  });
}

export function POST(request: Request, { params }: Context) {
  return contactBasisResponse(request, async (operator) => {
    rejectContactBasisPostQuery(request);
    const { id, contactId } = await params;
    const body = await readContactBasisBody(request);
    const trusted = {
      ...body.fields,
      organizationId: id,
      contactId,
      operatorId: operator.id,
    };
    const result = body.eventType === "RECORD"
      ? await recordContactBasis(trusted as PreparedContactBasisRecord)
      : await withdrawContactBasis(trusted as PreparedContactBasisWithdrawal);
    return basisReply(result, result.outcome === "APPENDED" ? 201 : 200);
  });
}
