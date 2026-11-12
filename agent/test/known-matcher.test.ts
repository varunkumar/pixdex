import { describe, expect, it } from 'vitest';
import type { Gallery } from '../src/known/gallery';
import { KNOWN_MARGIN, KNOWN_THRESHOLD, matchKnown } from '../src/known/matcher';

function unit(...v: number[]): Float32Array {
  const a = new Float32Array(512);
  v.forEach((x, i) => (a[i] = x));
  const n = Math.hypot(...v);
  return a.map((x) => x / n);
}

function person(id: string, ...refs: Float32Array[]) {
  return { id, name: id, aliases: [], refs };
}

describe('matchKnown', () => {
  it('exposes the initial thresholds', () => {
    expect(KNOWN_THRESHOLD).toBe(0.5);
    expect(KNOWN_MARGIN).toBe(0.05);
  });

  it('returns null below the threshold', () => {
    const g: Gallery = { model: 'm', people: [person('a', unit(1, 0, 0))] };
    expect(matchKnown(unit(0.3, 1, 0), g)).toBeNull();
  });

  it('returns null when two people are within the margin', () => {
    const g: Gallery = { model: 'm', people: [person('a', unit(1, 0.1)), person('b', unit(1, 0.12))] };
    expect(matchKnown(unit(1, 0.11), g)).toBeNull();
  });

  it('returns the clear winner with its best score', () => {
    const g: Gallery = { model: 'm', people: [person('a', unit(1, 0)), person('b', unit(0, 1))] };
    const m = matchKnown(unit(1, 0.1), g);
    expect(m?.id).toBe('a');
    expect(m?.score).toBeGreaterThan(0.9);
  });

  it('does not treat refs of the same person as a second best person', () => {
    const g: Gallery = {
      model: 'm',
      people: [person('a', unit(1, 0), unit(1, 0.01), unit(1, 0.02)), person('b', unit(0, 1))],
    };
    expect(matchKnown(unit(1, 0.01), g)?.id).toBe('a');
  });

  it('handles a single person and an empty gallery', () => {
    expect(matchKnown(unit(1), { model: 'm', people: [person('a', unit(1))] })?.id).toBe('a');
    expect(matchKnown(unit(1), { model: 'm', people: [] })).toBeNull();
  });
});
