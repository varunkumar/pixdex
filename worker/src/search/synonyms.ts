import wildlifeSynonyms from './wildlife-synonyms.json';
import wordFamilies from './word-families.json';

export { wildlifeSynonyms, wordFamilies };

/**
 * terms: category word -> members ("big cat" -> leopard, tiger...). One-way: the
 *   category expands to its members, not the reverse.
 * hard / soft: families of interchangeable words. Any member of a family matches
 *   all the others. Soft families (actions such as "sleeping") are dropped by the
 *   second search tier so a photo of a resting tiger still answers "sleeping tiger".
 */
export interface SynonymSets {
  terms: Record<string, string[]>;
  hard: string[][];
  soft: string[][];
}

export const defaultSynonymSets: SynonymSets = {
  terms: wildlifeSynonyms,
  hard: wordFamilies.hard,
  soft: wordFamilies.soft,
};

function quoteFts5Term(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

// Words that describe the kind of field being searched or are pure filler.
// "red pattern" and "red colors" both mean "red"; they must not be required to match.
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'of', 'in', 'on', 'with', 'and', 'or', 'for', 'to',
  'at', 'by', 'from', 'near', 'is', 'are', 'some', 'my',
  'photo', 'photos', 'picture', 'pictures', 'image', 'images',
  'color', 'colors', 'colour', 'colours', 'pattern', 'patterns',
  'shade', 'shades', 'tone', 'tones', 'prominent', 'dominant', 'mostly', 'background', 'backdrop',
]);

function words(text: string): string[] {
  return text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** Crude plural folding, used only to look words up in the dictionaries. */
function singular(word: string): string {
  if (word.length <= 3) return word;
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (/(?:sses|ches|shes|xes)$/.test(word)) return word.slice(0, -2);
  if (/(?:ss|us|is)$/.test(word)) return word;
  if (word.endsWith('s')) return word.slice(0, -1);
  return word;
}

interface Group {
  terms: string[];
  soft: boolean;
  at: number;
}

function parseGroups(rawQuery: string, sets: SynonymSets): Group[] {
  const tokens = words(rawQuery.trim().toLowerCase());
  const norm = tokens.map(singular);
  const used = tokens.map(() => false);
  const groups: Group[] = [];

  // Longest category keys first so "snow leopard" wins over "leopard".
  const keys = Object.keys(sets.terms)
    .map((key) => ({ key, parts: words(key.toLowerCase()).map(singular) }))
    .filter((k) => k.parts.length > 0)
    .sort((a, b) => b.parts.length - a.parts.length);
  for (const { key, parts } of keys) {
    for (let i = 0; i + parts.length <= norm.length; i++) {
      const hit = parts.every((p, j) => norm[i + j] === p && !used[i + j]);
      if (!hit) continue;
      for (let j = 0; j < parts.length; j++) used[i + j] = true;
      groups.push({ terms: [key, ...sets.terms[key]], soft: false, at: i });
    }
  }

  const families = [
    ...sets.hard.map((terms) => ({ terms, soft: false })),
    ...sets.soft.map((terms) => ({ terms, soft: true })),
  ];
  tokens.forEach((token, i) => {
    if (used[i] || STOP_WORDS.has(token)) return;
    const family = families.find((f) => f.terms.some((t) => singular(t) === norm[i] || t === token));
    used[i] = true;
    groups.push(
      family
        ? { terms: [...new Set([token, ...family.terms])], soft: family.soft, at: i }
        : { terms: [token], soft: false, at: i }
    );
  });

  return groups.sort((a, b) => a.at - b.at);
}

function render(groups: Group[], joiner: ' AND ' | ' OR '): string {
  return groups
    .map((g) => {
      const quoted = g.terms.map(quoteFts5Term);
      return quoted.length > 1 ? `(${quoted.join(' OR ')})` : quoted[0];
    })
    .join(joiner);
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
  const groups = parseGroups(query, { terms: synonyms, hard: [], soft: [] });
  // Nothing meaningful left (e.g. the query was only "colors"): match it as typed.
  if (groups.length === 0) return quoteFts5Term(query);
  return render(groups, mode === 'all' ? ' AND ' : ' OR ');
}

/**
 * MATCH expressions to try in order, stopping at the first that finds photos:
 * 1. every group (AND)
 * 2. every group except soft ones such as actions (AND)
 * 3. any group (OR), ranked by bm25 so more matches sort first
 * Identical tiers are collapsed.
 */
export function expandQueryTiers(rawQuery: string, sets: SynonymSets = defaultSynonymSets): string[] {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return [];
  const groups = parseGroups(query, sets);
  if (groups.length === 0) return [quoteFts5Term(query)];
  const hardOnly = groups.filter((g) => !g.soft);
  const tiers = [
    render(groups, ' AND '),
    hardOnly.length > 0 ? render(hardOnly, ' AND ') : '',
    render(groups, ' OR '),
  ];
  return tiers.filter((t, i) => t !== '' && tiers.indexOf(t) === i);
}
