import type { ContactSuppression, ContactSuppressionWriteResponse } from "../../../../../../../contact-suppressions.ts";
import type { ContactSuppressionRecord } from "../../../../../../../server/contact-suppressions.ts";
import {
  contactSuppressionResponse,
  readContactSuppressionBody,
  rejectSuppressionQuery,
  suppressionReply,
} from "../../../../../../../server/contact-suppression-http.ts";
import { readContactSuppression, recordContactSuppression } from "../../../../../../../server/contact-suppressions.ts";
import { getOrganization } from "../../../../../../../server/organizations.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string; contactId: string }> };

function publicSuppression(value: ContactSuppressionRecord): ContactSuppression {
  return {
    id: value.id,
    organizationId: value.organizationId,
    contactId: value.contactId,
    reason: value.reason,
    reference: value.reference,
    recordedAt: value.recordedAt,
  };
}

export function GET(request: Request, { params }: Context) {
  return contactSuppressionResponse(request, async () => {
    rejectSuppressionQuery(request);
    const { id, contactId } = await params;
    const organization = await getOrganization(id);
    const suppression = await readContactSuppression(organization.id, contactId);
    return suppressionReply({
      status: suppression ? "SUPPRESSED" : "NOT_SUPPRESSED",
      suppression: suppression ? publicSuppression(suppression) : null,
    });
  });
}

export function POST(request: Request, { params }: Context) {
  return contactSuppressionResponse(request, async (operator) => {
    rejectSuppressionQuery(request);
    const { id, contactId } = await params;
    const organization = await getOrganization(id);
    const body = await readContactSuppressionBody(request);
    const result = await recordContactSuppression({
      organizationId: organization.id,
      contactId,
      operatorId: operator.id,
      reason: body.reason,
      reference: body.reference,
    });
    const messages = {
      RECORDED: "Ограничувањето е евидентирано.",
      ALREADY_RECORDED: "Ограничувањето веќе беше евидентирано со истите податоци.",
      ALREADY_RECORDED_DIFFERENT_METADATA: "Ограничувањето веќе постои. Новите податоци не се запишани.",
    } satisfies Record<typeof result.outcome, string>;
    const response: ContactSuppressionWriteResponse = {
      outcome: result.outcome,
      suppression: publicSuppression(result.suppression),
      message: messages[result.outcome],
    };
    return suppressionReply(response, result.outcome === "RECORDED" ? 201 : 200);
  });
}
