import { describe, expect, it } from 'vitest';
import { mapLegacyAiParams, readOmniboxState, stripAiParams } from '../urlState';

const entries = (s: string) => [...new URLSearchParams(s).entries()];

describe('mapLegacyAiParams', () => {
  it('maps all legacy params', () => {
    expect(entries(mapLegacyAiParams('q=x&kw=a,b&people=0&room=0'))).toEqual(
      entries('mode=ai&q=x&kw=a%2Cb&hidePeople=0&room=0'),
    );
  });
  it('drops people values other than 0', () => {
    expect(entries(mapLegacyAiParams('q=x&people=5'))).toEqual(entries('mode=ai&q=x'));
  });
  it('empty input gives mode=ai', () => {
    expect(mapLegacyAiParams('')).toBe('mode=ai');
  });
});

describe('readOmniboxState', () => {
  it('defaults', () => {
    expect(readOmniboxState(new URLSearchParams(''))).toEqual({
      mode: 'plain', q: '', kw: '', hidePeople: true, leaveRoom: true,
    });
  });
  it('reads values, false only for exact 0', () => {
    const s = readOmniboxState(new URLSearchParams('mode=ai&q=a&kw=b&hidePeople=0&room=0'));
    expect(s).toEqual({ mode: 'ai', q: 'a', kw: 'b', hidePeople: false, leaveRoom: false });
    expect(readOmniboxState(new URLSearchParams('hidePeople=1&room=00')).hidePeople).toBe(true);
    expect(readOmniboxState(new URLSearchParams('mode=AI')).mode).toBe('plain');
  });
});

describe('stripAiParams', () => {
  it('removes AI params only', () => {
    const p = new URLSearchParams('mode=ai&kw=a&hidePeople=0&room=0&q=x&people=1&known=Q1&album=a&from=2020');
    expect(entries(stripAiParams(p).toString())).toEqual(entries('q=x&people=1&known=Q1&album=a&from=2020'));
    expect(p.get('mode')).toBe('ai');
  });
});
