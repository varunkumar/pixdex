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
