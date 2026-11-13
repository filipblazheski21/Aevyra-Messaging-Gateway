import type { ContactSuppression } from "./contact-suppressions.ts";
import type { OrganizationKind } from "./organizations.ts";

export const contactBasisPurposes = ["PATIENT_INFORMATION", "AEVYRA_MARKETING"] as const;
export const contactBasisChannels = ["SMS", "VIBER"] as const;
export const contactBasisTypes = ["CONSENT", "DOCUMENTED_BASIS"] as const;

export type ContactBasisPurpose = typeof contactBasisPurposes[number];
export type ContactBasisChannel = typeof contactBasisChannels[number];
export type ContactBasisType = typeof contactBasisTypes[number];
export type ContactBasisEventType = "RECORD" | "WITHDRAW";
export type ContactBasisStatus = "MISSING" | "RECORDED" | "WITHDRAWN" | "EXPIRED";

export const contactBasisPurposeForOrganization = {
  CLINIC: "PATIENT_INFORMATION",
  MARKETING: "AEVYRA_MARKETING",
} as const satisfies Record<OrganizationKind, ContactBasisPurpose>;

export const contactBasisPurposeLabels = {
  PATIENT_INFORMATION: "Информативни пораки за пациенти",
  AEVYRA_MARKETING: "Маркетинг на Aevyra",
} satisfies Record<ContactBasisPurpose, string>;

export const contactBasisStatusLabels = {
  MISSING: "Нема евидентирана основа",
  RECORDED: "Евидентирана основа",
  WITHDRAWN: "Повлечена основа",
  EXPIRED: "Истечена основа",
} satisfies Record<ContactBasisStatus, string>;

export const contactBasisTypeLabels = {
  CONSENT: "Согласност",
  DOCUMENTED_BASIS: "Документирана основа",
} satisfies Record<ContactBasisType, string>;

export const contactBasisChannelLabels = {
  SMS: "SMS",
  VIBER: "Viber",
} satisfies Record<ContactBasisChannel, string>;

export type ContactBasisEvent = {
  id: string;
  organizationId: string;
  contactId: string;
  purpose: ContactBasisPurpose;
  channel: ContactBasisChannel;
  eventType: ContactBasisEventType;
  operatorId: string;
  recordedAt: string;
  revision: number;
  idempotencyKey: string;
  basisType: ContactBasisType | null;
  reference: string | null;
  expiresAt: string | null;
};

export type ContactBasisCurrentState = {
  organizationId: string;
  contactId: string;
  purpose: ContactBasisPurpose;
  channel: ContactBasisChannel;
  revision: number;
  status: ContactBasisStatus;
  latestEvent: ContactBasisEvent | null;
  suppression: ContactSuppression | null;
};

export type ContactBasisWriteResult = {
  outcome: "APPENDED" | "REPLAYED";
  event: ContactBasisEvent;
  current: ContactBasisCurrentState;
};
