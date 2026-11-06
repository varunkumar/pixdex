import { describe, expect, it } from 'vitest';
import { dateFilterSql, parseDateFilter } from '../src/db/dateFilter';

const parse = (params: Record<string, string>) => parseDateFilter((n) => params[n]);

describe('parseDateFilter', () => {
  it('accepts a range and makes the end exclusive', () => {
    expect(parse({ from: '2025-06-01', to: '2025-06-30' })).toEqual({
      ok: true,
      filter: { from: '2025-06-01', toExclusive: '2025-07-01' },
    });
  });

  it('accepts a leap day', () => {
    expect(parse({ to: '2024-02-29' })).toEqual({
      ok: true,
      filter: { toExclusive: '2024-03-01' },
    });
    expect(parse({ onThisDay: '02-29' })).toEqual({ ok: true, filter: { onThisDay: '02-29' } });
  });

  it('rejects impossible dates, inverted ranges and bad onThisDay', () => {
    expect(parse({ from: '2025-02-30' }).ok).toBe(false);
    expect(parse({ from: '2025-07-01', to: '2025-06-01' }).ok).toBe(false);
    expect(parse({ onThisDay: '13-01' }).ok).toBe(false);
  });

  it('rejects onThisDay combined with from or to', () => {
    expect(parse({ onThisDay: '06-14', from: '2025-01-01' }).ok).toBe(false);
    expect(parse({ onThisDay: '06-14', to: '2025-01-01' }).ok).toBe(false);
  });

  it('returns an empty filter when nothing is given', () => {
    expect(parse({})).toEqual({ ok: true, filter: {} });
  });
});

describe('dateFilterSql', () => {
  it('is empty for an empty filter', () => {
    expect(dateFilterSql({})).toEqual({ sql: '', params: [] });
  });

  it('builds bound range and on-this-day clauses', () => {
    expect(dateFilterSql({ from: '2025-06-01', toExclusive: '2025-07-01' })).toEqual({
      sql: ' AND photos.date_time >= ? AND photos.date_time < ?',
      params: ['2025-06-01', '2025-07-01'],
    });
    expect(dateFilterSql({ onThisDay: '06-14' }, 'p.date_time')).toEqual({
      sql: ' AND substr(p.date_time, 6, 5) = ?',
      params: ['06-14'],
    });
  });
});
