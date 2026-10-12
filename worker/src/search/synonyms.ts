import wildlifeSynonyms from './wildlife-synonyms.json';

export { wildlifeSynonyms };

function quoteFts5Term(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

// Words that describe the kind of field being searched or are pure filler.
// "red pattern" and "red colors" both mean "red"; they must not be required to match.
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'of', 'in', 'on', 'with', 'and', 'or', 'for', 'to',
  'photo', 'photos', 'picture', 'pictures', 'image', 'images',
  'color', 'colors', 'colour', 'colours', 'pattern', 'patterns',
]);

function words(text: string): string[] {
  return text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/**
 * Builds an FTS5 MATCH expression. Each meaningful word (or known multi-word
 * synonym key such as "big cat") becomes a group, an OR of the term and its
 * synonyms. Groups are joined with AND by default so "red leopard" needs both,
 * or with OR (mode "any") for a looser fallback when AND finds nothing.
 */
export function expandQuery(
  rawQuery: string,
  synonyms: Record<string, string[]>,
  mode: 'all' | 'any' = 'all'
): string {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return '';

  const groups: string[] = [];
  const consumed = new Set<string>();

  for (const key of Object.keys(synonyms).filter((k) => query.includes(k))) {
    const terms = [key, ...synonyms[key]].map(quoteFts5Term);
    groups.push(terms.length > 1 ? `(${terms.join(' OR ')})` : terms[0]);
    words(key).forEach((w) => consumed.add(w));
  }

  for (const word of words(query)) {
    if (consumed.has(word) || STOP_WORDS.has(word)) continue;
    groups.push(quoteFts5Term(word));
  }

  // Nothing meaningful left (e.g. the query was only "colors"): match it as typed.
  if (groups.length === 0) return quoteFts5Term(query);

  return groups.join(mode === 'all' ? ' AND ' : ' OR ');
}
