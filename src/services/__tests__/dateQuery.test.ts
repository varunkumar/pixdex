import { describe, expect, it } from 'vitest';
import { onThisDayToday, parseDateQuery, quickRange } from '../dateQuery';

const now = new Date(2026, 10, 6); // 2026-11-06, a Friday (local)

describe('parseDateQuery', () => {
  it('extracts a bare year and keeps the remaining text', () => {
    expect(parseDateQuery('beach 2025')).toEqual({
      text: 'beach',
      from: '2025-01-01',
      to: '2025-12-31',
    });
  });

  it('parses month and year in either position, with names or abbreviations', () => {
    expect(parseDateQuery('june 2025')).toEqual({ text: '', from: '2025-06-01', to: '2025-06-30' });
    expect(parseDateQuery('Jun 2025 beach')).toEqual({
      text: 'beach',
      from: '2025-06-01',
      to: '2025-06-30',
    });
  });

  it('handles leap years', () => {
    expect(parseDateQuery('feb 2024').to).toBe('2024-02-29');
    expect(parseDateQuery('feb 2025').to).toBe('2025-02-28');
  });

  it('parses a single ISO day', () => {
    expect(parseDateQuery('2025-06-14')).toEqual({
      text: '',
      from: '2025-06-14',
      to: '2025-06-14',
    });
  });

  it('returns text only when there is no date', () => {
    expect(parseDateQuery('sunset')).toEqual({ text: 'sunset' });
  });

  it('uses the first match and leaves the rest as text', () => {
    expect(parseDateQuery('2025 2024')).toEqual({
      text: '2024',
      from: '2025-01-01',
      to: '2025-12-31',
    });
  });

  it('does not treat partial numbers as years', () => {
    expect(parseDateQuery('room 1999x')).toEqual({ text: 'room 1999x' });
    expect(parseDateQuery('12345')).toEqual({ text: '12345' });
    expect(parseDateQuery('1850')).toEqual({ text: '1850' });
    expect(parseDateQuery('2101')).toEqual({ text: '2101' });
  });

  it('ignores impossible ISO dates', () => {
    expect(parseDateQuery('2025-13-45')).toEqual({ text: '2025-13-45' });
    expect(parseDateQuery('2025-02-30')).toEqual({ text: '2025-02-30' });
  });

  it('accepts a real leap day as a single day range', () => {
    expect(parseDateQuery('2024-02-29')).toEqual({ text: '', from: '2024-02-29', to: '2024-02-29' });
  });
});

describe('quickRange', () => {
  it('returns today', () => {
    expect(quickRange('today', now)).toEqual({ from: '2026-11-06', to: '2026-11-06' });
  });

  it('returns the Monday to Sunday week', () => {
    expect(quickRange('week', now)).toEqual({ from: '2026-11-02', to: '2026-11-08' });
    expect(quickRange('week', new Date(2026, 10, 8))).toEqual({
      from: '2026-11-02',
      to: '2026-11-08',
    });
  });

  it('returns the month and the year', () => {
    expect(quickRange('month', now)).toEqual({ from: '2026-11-01', to: '2026-11-30' });
    expect(quickRange('year', now)).toEqual({ from: '2026-01-01', to: '2026-12-31' });
  });
});

describe('onThisDayToday', () => {
  it('returns MM-DD', () => {
    expect(onThisDayToday(now)).toBe('11-06');
    expect(onThisDayToday(new Date(2026, 0, 3))).toBe('01-03');
  });
});
