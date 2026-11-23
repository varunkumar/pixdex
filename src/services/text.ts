/**
 * Short form of a description for listings: the first sentence when it fits,
 * otherwise cut at a word boundary with an ellipsis.
 */
export function shortDescription(text: string | null | undefined, maxLength = 140): string {
  const clean = (text ?? '').replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLength) return clean;

  const firstSentence = clean.match(/^.*?[.!?](?=\s|$)/)?.[0];
  if (firstSentence && firstSentence.length <= maxLength) return firstSentence;

  const cut = clean.slice(0, maxLength - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > maxLength / 2 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:.-]+$/, '')}…`;
}

/** The one-line name of a photo in listings: its short caption, else a short description, else the file name. */
export function photoCaption(photo: {
  shortCaption?: string | null;
  description?: string | null;
  filename?: string | null;
  id: string;
}): string {
  return photo.shortCaption || shortDescription(photo.description, 60) || photo.filename || photo.id;
}
