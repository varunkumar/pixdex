import wildlifeSynonyms from './wildlife-synonyms.json';

export { wildlifeSynonyms };

function quoteFts5Term(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

export function expandQuery(rawQuery: string, synonyms: Record<string, string[]>): string {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return '';

  const matchedKeys = Object.keys(synonyms).filter((key) => query.includes(key));

  const terms = new Set<string>();
  terms.add(quoteFts5Term(query));

  for (const key of matchedKeys) {
    terms.add(quoteFts5Term(key));
    for (const synonym of synonyms[key]) {
      terms.add(quoteFts5Term(synonym));
    }
  }

  return Array.from(terms).join(' OR ');
}
