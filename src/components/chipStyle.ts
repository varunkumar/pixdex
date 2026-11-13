// Own entries are blue, known ones violet, albums teal. Known ones also carry a "known" marker and the group heading,
// so colour is never the only signal (light and dark themes, colour-blind users).
export const OWN_COLOR = 'blue';
export const KNOWN_COLOR = 'violet';
export const ALBUM_COLOR = 'teal';

/** Chip colour for a suggestion or selected filter kind; anything else (dates, "Add both") is gray. */
export const kindColor = (kind: string): string =>
  kind === 'own' ? OWN_COLOR : kind === 'known' ? KNOWN_COLOR : kind === 'album' ? ALBUM_COLOR : 'gray';

/** Readable text colour for a kind colour on an untinted background, in light and dark (defined in index.css). */
export const inkColor = (color: string): string => `var(--pixdex-ink-${color})`;
