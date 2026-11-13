export type ContactListItem = {
  id: string;
  normalizedPhone: string;
  createdAt: string;
  hasSuppression: boolean;
};

export type ContactListPage = {
  items: ContactListItem[];
  totalContacts: number;
  matchedContacts: number;
  nextCursor: string | null;
};
