export const BASE_USER_AGENT = 'face-gallery-builder/0.1';

/** The validated WIKIMEDIA_CONTACT, or a warning that never contains the value. */
export function wikimediaContact(env: Record<string, string | undefined> = process.env): {
  contact?: string;
  warning?: string;
} {
  const raw = env.WIKIMEDIA_CONTACT;
  if (raw === undefined || raw.trim() === '') return {};
  const value = raw.trim();
  // eslint-disable-next-line no-control-regex
  if (value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) {
    return { warning: 'WIKIMEDIA_CONTACT is invalid (over 200 characters or has control characters) and is ignored.' };
  }
  return { contact: value };
}

/** `face-gallery-builder/0.1 (<contact>)` when a contact is set, else the generic agent. */
export function userAgentFor(contact?: string): string {
  return contact ? `${BASE_USER_AGENT} (${contact})` : BASE_USER_AGENT;
}
