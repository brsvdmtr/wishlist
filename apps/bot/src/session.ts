/**
 * In-memory session for wizard state (create-list, add-item).
 * Key: chatId (number), Value: SessionData.
 */
export type SessionData = {
  listId?: string;
  listSlug?: string;
  listTitle?: string;
  wizard?: 'create_list' | 'add_item';
  addItemTitle?: string;
  createListTitle?: string;
};

const store = new Map<number, SessionData>();

export function getSession(chatId: number): SessionData {
  let s = store.get(chatId);
  if (!s) {
    s = {};
    store.set(chatId, s);
  }
  return s;
}

export function setSession(chatId: number, data: Partial<SessionData>) {
  const s = getSession(chatId);
  Object.assign(s, data);
}

export function clearWizard(chatId: number) {
  const s = getSession(chatId);
  delete s.wizard;
  delete s.addItemTitle;
}
