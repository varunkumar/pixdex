/** Lowercase, accent-free, `.-_'` as spaces, single-spaced: the form names and queries are compared in. */
export function normalizeName(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[.\-_']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Words a query word may be a prefix of. Besides the plain words, each run of consecutive single-letter words
 * (initials) is also offered joined, so "A. R. Rahman" ("a r rahman") offers "ar" and the query "ar rahman" matches.
 */
function nameWords(name: string): string[] {
  const words = normalizeName(name).split(' ').filter(Boolean);
  const out = [...words];
  let run = '';
  for (const w of [...words, '']) {
    if (w.length === 1) run += w;
    else {
      if (run.length > 1) out.push(run);
      run = '';
    }
  }
  return out;
}

/**
 * Typeahead match: case and accent insensitive, no fuzziness. Every word of the query must be a prefix of some word
 * of some name or alias. An empty or blank raw query matches everything (list all); any other query that normalises
 * to fewer than `min` characters (including punctuation only, such as "." or "-") matches nothing.
 * Cost: a few string ops per name per keystroke, no allocation beyond the word lists; fine for hundreds of names.
 */
export function matchesQuery(query: string, names: string[], min = 3): boolean {
  if (query.trim() === '') return true;
  const q = normalizeName(query);
  if (q.length < min) return false;
  const qWords = q.split(' ');
  const pool = names.flatMap(nameWords);
  return qWords.every((qw) => pool.some((w) => w.startsWith(qw)));
}
