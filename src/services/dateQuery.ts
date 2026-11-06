export interface ParsedDateQuery {
  text: string;
  from?: string;
  to?: string;
}

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

const pad = (n: number): string => String(n).padStart(2, '0');

function ymd(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}`;
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

function monthRange(year: number, month: number): { from: string; to: string } {
  return { from: ymd(year, month, 1), to: ymd(year, month, daysInMonth(year, month)) };
}

function localYmd(date: Date): string {
  return ymd(date.getFullYear(), date.getMonth() + 1, date.getDate());
}

const monthNames = MONTHS.map((m) => `${m}|${m.slice(0, 3)}`).join('|');

interface Candidate {
  index: number;
  length: number;
  range: { from: string; to: string };
}

const ISO_RE = /(?<![\w-])(\d{4})-(\d{2})-(\d{2})(?![\w-])/g;
const MONTH_YEAR_RE = new RegExp(`(?<![\\w-])(${monthNames})\\.?\\s+(\\d{4})(?![\\w-])`, 'gi');
const YEAR_RE = /(?<![\w-])(19\d{2}|20\d{2}|2100)(?![\w-])/g;

function candidates(input: string): Candidate[] {
  const found: Candidate[] = [];
  for (const m of input.matchAll(ISO_RE)) {
    const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) continue;
    const date = ymd(year, month, day);
    found.push({ index: m.index, length: m[0].length, range: { from: date, to: date } });
  }
  for (const m of input.matchAll(MONTH_YEAR_RE)) {
    const month = MONTHS.findIndex((name) => name.startsWith(m[1].toLowerCase().slice(0, 3))) + 1;
    found.push({ index: m.index, length: m[0].length, range: monthRange(Number(m[2]), month) });
  }
  for (const m of input.matchAll(YEAR_RE)) {
    const year = Number(m[1]);
    found.push({
      index: m.index,
      length: m[0].length,
      range: { from: ymd(year, 1, 1), to: ymd(year, 12, 31) },
    });
  }
  return found;
}

/** Extract the first date expression (year, month and year, or ISO day) from free text. */
export function parseDateQuery(input: string): ParsedDateQuery {
  const first = candidates(input).sort((a, b) => a.index - b.index)[0];
  if (!first) return { text: input.trim() };
  const rest = input.slice(0, first.index) + ' ' + input.slice(first.index + first.length);
  return { text: rest.replace(/\s+/g, ' ').trim(), ...first.range };
}

/** Local-calendar range for today, this week (Monday to Sunday), this month or this year. */
export function quickRange(
  kind: 'today' | 'week' | 'month' | 'year',
  now: Date = new Date()
): { from: string; to: string } {
  const y = now.getFullYear();
  switch (kind) {
    case 'today': {
      const day = localYmd(now);
      return { from: day, to: day };
    }
    case 'week': {
      const sinceMonday = (now.getDay() + 6) % 7;
      const monday = new Date(y, now.getMonth(), now.getDate() - sinceMonday);
      const sunday = new Date(y, now.getMonth(), now.getDate() - sinceMonday + 6);
      return { from: localYmd(monday), to: localYmd(sunday) };
    }
    case 'month':
      return monthRange(y, now.getMonth() + 1);
    case 'year':
      return { from: ymd(y, 1, 1), to: ymd(y, 12, 31) };
  }
}

/** Today's month and day as `MM-DD`, for the "on this day" filter. */
export function onThisDayToday(now: Date = new Date()): string {
  return `${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
