export type OrganizationKind = "CLINIC" | "MARKETING";

export type Organization = {
  id: string;
  kind: OrganizationKind;
  name: string;
  created_at: string;
};

export type OrganizationPage = {
  items: Organization[];
  nextCursor: string | null;
};
