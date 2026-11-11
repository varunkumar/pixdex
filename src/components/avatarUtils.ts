const PALETTE = ['blue', 'cyan', 'grape', 'green', 'indigo', 'orange', 'pink', 'red', 'teal', 'violet'];

/** Stable colour for an email (FNV-1a hash), so a person looks the same everywhere. */
export const avatarColor = (email: string): string => {
  let h = 2166136261;
  for (const ch of email.toLowerCase()) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return PALETTE[(h >>> 0) % PALETTE.length];
};

/** One or two letters: first letters of the name parts before the @, else the first character. */
export const avatarInitials = (email: string): string => {
  const parts = email.split('@')[0].split(/[._+-]+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0][0] + parts[1][0] : (parts[0] ?? '?').slice(0, 1);
  return letters.toUpperCase();
};

