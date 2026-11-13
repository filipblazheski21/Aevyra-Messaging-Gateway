export const contactSuppressionReasons = ["CONTACT_REQUEST", "ORGANIZATION_REQUEST", "INTERNAL_BLOCK"] as const;

export type ContactSuppressionReason = typeof contactSuppressionReasons[number];

export const contactSuppressionReasonLabels = {
  CONTACT_REQUEST: "Барање од контактот",
  ORGANIZATION_REQUEST: "Барање од организацијата",
  INTERNAL_BLOCK: "Внатрешно ограничување",
} satisfies Record<ContactSuppressionReason, string>;

export type ContactSuppression = {
  id: string;
  organizationId: string;
  contactId: string;
  reason: ContactSuppressionReason;
  reference: string | null;
  recordedAt: string;
};

export type ContactSuppressionWriteResult = {
  outcome: "RECORDED" | "ALREADY_RECORDED" | "ALREADY_RECORDED_DIFFERENT_METADATA";
  suppression: ContactSuppression;
};

export type ContactSuppressionReadResponse = {
  status: "SUPPRESSED" | "NOT_SUPPRESSED";
  suppression: ContactSuppression | null;
};

export type ContactSuppressionWriteResponse = ContactSuppressionWriteResult & {
  message: string;
};
