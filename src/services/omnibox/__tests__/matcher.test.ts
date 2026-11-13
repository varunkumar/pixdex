import { describe, expect, it } from 'vitest';
import { rankMatches, removeWords, splitSpans, type Candidate } from '../matcher';

const c = (
  kind: Candidate['kind'],
  id: string,
  label: string,
  aliases: string[] = [],
  photoCount = 0,
): Candidate => ({ kind, id, label, aliases, photoCount });

const dhoni = c('known', 'Q1', 'MS Dhoni', ['MSD', 'Mahi'], 5);
const virat = c('known', 'Q2', 'Virat Kohli', [], 8);
const ganesh = c('own', '3', 'Ganesh', [], 2);
const srk = c('known', 'Q4', 'Shah Rukh Khan', ['SRK'], 1);
const all = [dhoni, virat, ganesh, srk];

describe('rankMatches', () => {
  it('matches inside words, by alias, and rejects short queries', () => {
    expect(rankMatches('dho', all)).toEqual([dhoni]);
    expect(rankMatches('esh', all)).toEqual([ganesh]);
    expect(rankMatches('msd', all)).toEqual([dhoni]);
    expect(rankMatches('srk', all)).toEqual([srk]);
    expect(rankMatches('ra', all)).toEqual([]);
  });

  it('ignores case and accents', () => {
    expect(rankMatches('ÉSH', all)).toEqual([ganesh]);
  });

  it('ranks exact, then prefix, then photoCount, then own before known', () => {
    const exact = c('known', 'E', 'Sam', [], 0);
    const prefix = c('known', 'P', 'Samuel', [], 1);
    const inner = c('known', 'I', 'Rosamund', [], 99);
    expect(rankMatches('sam', [inner, prefix, exact]).map((x) => x.id)).toEqual(['E', 'P', 'I']);
    const a = c('known', 'A', 'Samir', [], 1);
    const b = c('known', 'B', 'Samar', [], 4);
    expect(rankMatches('sam', [a, b]).map((x) => x.id)).toEqual(['B', 'A']);
    const own = c('own', '1', 'Samir', [], 3);
    const known = c('known', 'K', 'Samir', [], 3);
    expect(rankMatches('sam', [known, own]).map((x) => x.id)).toEqual(['1', 'K']);
  });
});

describe('splitSpans', () => {
  it('builds one span for a partial full name', () => {
    const { spans, maxWords } = splitSpans('virat k', all);
    expect(maxWords).toBe(12);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ start: 0, end: 2, words: 'virat k' });
    expect(spans[0].matches).toEqual([virat]);
  });

  it('matches words in any order and prefers the longest span', () => {
    expect(splitSpans('kohli virat', all).spans).toHaveLength(1);
    const { spans } = splitSpans('virat kohli', all);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ start: 0, end: 2 });
  });

  it('splits different people into separate spans', () => {
    const { spans } = splitSpans('virat dhoni', all);
    expect(spans.map((s) => s.matches)).toEqual([[virat], [dhoni]]);
    expect(spans.map((s) => [s.start, s.end])).toEqual([[0, 1], [1, 2]]);
  });

  it('never uses a candidate twice and skips unmatched words', () => {
    const { spans } = splitSpans('virat dhoni virat', all);
    expect(spans.map((s) => s.words)).toEqual(['virat', 'dhoni']);
    const r = splitSpans('beach virat sunset', all);
    expect(r.spans).toHaveLength(1);
    expect(r.spans[0]).toMatchObject({ start: 1, end: 2, words: 'virat' });
  });

  it('honours excludeIds', () => {
    expect(splitSpans('virat', all, new Set(['known:Q2'])).spans).toEqual([]);
  });

  it('only evaluates the first 12 words', () => {
    const text = `${Array(12).fill('xx').join(' ')} virat`;
    expect(splitSpans(text, all).spans).toEqual([]);
    const text2 = `${Array(11).fill('xx').join(' ')} virat zzz`;
    expect(splitSpans(text2, all).spans[0]).toMatchObject({ start: 11, end: 12 });
  });

  it('keeps own and known candidates for the same name in matches', () => {
    const own = c('own', '9', 'Virat Kohli', [], 1);
    const { spans } = splitSpans('virat', [virat, own]);
    expect(spans[0].matches.map((m) => m.kind).sort()).toEqual(['known', 'own']);
  });
});

describe('removeWords', () => {
  it('removes span words and single-spaces the rest', () => {
    const { spans } = splitSpans('virat dhoni caption', all);
    expect(removeWords('virat dhoni caption', [spans[0]])).toBe('dhoni caption');
    expect(removeWords('virat dhoni caption', spans)).toBe('caption');
  });
});
