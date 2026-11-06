export type DateFilter = { from?: string; toExclusive?: string; onThisDay?: string };

export type DateFilterResult = { ok: true; filter: DateFilter } | { ok: false; error: string };

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_DAY = /^(\d{2})-(\d{2})$/;

// Real calendar check: build the date and confirm it round-trips unchanged.
function validDay(value: string): boolean {
  const m = DAY.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

function nextDay(value: string): string {
  const [y, mo, d] = value.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d + 1)).toISOString().slice(0, 10);
}

// Feb 29 is allowed so a leap-day photo can surface every year it is asked for.
function validMonthDay(value: string): boolean {
  const m = MONTH_DAY.exec(value);
  return !!m && validDay(`2024-${value}`);
}

export function parseDateFilter(q: (name: string) => string | undefined): DateFilterResult {
  const from = q('from') || undefined;
  const to = q('to') || undefined;
  const onThisDay = q('onThisDay') || undefined;
  const filter: DateFilter = {};

  if (onThisDay !== undefined) {
    if (from !== undefined || to !== undefined) {
      return { ok: false, error: 'onThisDay cannot be combined with from or to' };
    }
    if (!validMonthDay(onThisDay)) return { ok: false, error: 'onThisDay must be MM-DD' };
    filter.onThisDay = onThisDay;
    return { ok: true, filter };
  }
  if (from !== undefined) {
    if (!validDay(from)) return { ok: false, error: 'from must be a valid YYYY-MM-DD date' };
    filter.from = from;
  }
  if (to !== undefined) {
    if (!validDay(to)) return { ok: false, error: 'to must be a valid YYYY-MM-DD date' };
    if (from !== undefined && to < from) return { ok: false, error: 'to must not be before from' };
    filter.toExclusive = nextDay(to);
  }
  return { ok: true, filter };
}

export function dateFilterSql(
  f: DateFilter,
  column = 'photos.date_time'
): { sql: string; params: unknown[] } {
  let sql = '';
  const params: unknown[] = [];
  if (f.onThisDay !== undefined) {
    sql += ` AND substr(${column}, 6, 5) = ?`;
    params.push(f.onThisDay);
  }
  if (f.from !== undefined) {
    sql += ` AND ${column} >= ?`;
    params.push(f.from);
  }
  if (f.toExclusive !== undefined) {
    sql += ` AND ${column} < ?`;
    params.push(f.toExclusive);
  }
  return { sql, params };
}
