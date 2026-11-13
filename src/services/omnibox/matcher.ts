import { matchesQuery, normalizeName } from '../personMatch';

export type CandidateKind = 'own' | 'known' | 'album';

export interface Candidate {
  kind: CandidateKind;
  id: string;
  label: string;
  aliases: string[];
  photoCount: number;
}

/** start/end are word indexes (end exclusive); `matches` is ranked, best first. */
export interface Span {
  start: number;
  end: number;
  words: string;
  matches: Candidate[];
}

export const MAX_WORDS = 12;
const MIN_CHARS = 3;
const KIND_ORDER: Record<CandidateKind, number> = { own: 0, known: 1, album: 2 };

export const candidateKey = (c: Candidate): string => `${c.kind}:${c.id}`;

function tier(q: string, c: Candidate): number {
  const names = [c.label, ...c.aliases].map(normalizeName);
  if (names.some((n) => n === q)) return 0;
  if (names.some((n) => n.startsWith(q))) return 1;
  return 2;
}

/**
 * Candidates matching `query` (every query word inside some name or alias word, min 3 characters), ranked by exact
 * match, name prefix, photoCount descending, then own before known before album. Stable.
 * Cost: a few string ops per candidate.
 */
export function rankMatches(query: string, candidates: Candidate[]): Candidate[] {
  const q = normalizeName(query);
  return candidates
    .filter((c) => matchesQuery(query, [c.label, ...c.aliases], MIN_CHARS))
    .map((c, i) => ({ c, i, t: tier(q, c) }))
    .sort(
      (a, b) =>
        a.t - b.t ||
        b.c.photoCount - a.c.photoCount ||
        KIND_ORDER[a.c.kind] - KIND_ORDER[b.c.kind] ||
        a.i - b.i,
    )
    .map((x) => x.c);
}

/**
 * Splits the first 12 words of `text` into spans, left to right, longest span first. Only the top match of a span is
 * consumed (never reused by a later span); the other matches stay on the span as alternatives.
 * Cost: O(words^2 x candidates), words at most 12.
 */
export function splitSpans(
  text: string,
  candidates: Candidate[],
  excludeIds: Set<string> = new Set(),
): { spans: Span[]; maxWords: 12 } {
  const words = text.split(/\s+/).filter(Boolean).slice(0, MAX_WORDS);
  const used = new Set(excludeIds);
  const spans: Span[] = [];
  let start = 0;
  while (start < words.length) {
    const pool = candidates.filter((c) => !used.has(candidateKey(c)));
    let found: Span | null = null;
    if (pool.length > 0) {
      for (let end = words.length; end > start; end--) {
        const joined = words.slice(start, end).join(' ');
        const matches = rankMatches(joined, pool);
        if (matches.length > 0) {
          found = { start, end, words: joined, matches };
          break;
        }
      }
    }
    if (found) {
      spans.push(found);
      used.add(candidateKey(found.matches[0]));
      start = found.end;
    } else {
      start++;
    }
  }
  return { spans, maxWords: MAX_WORDS };
}

/** `text` with the words of the given spans removed, single spaced. */
export function removeWords(text: string, spans: Span[]): string {
  const drop = new Set<number>();
  for (const s of spans) for (let i = s.start; i < s.end; i++) drop.add(i);
  return text
    .split(/\s+/)
    .filter(Boolean)
    .filter((_, i) => !drop.has(i))
    .join(' ');
}
