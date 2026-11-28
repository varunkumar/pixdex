import type { Fact, FocalGroup, InsightTopic } from '../../types/api';

export type Chart =
  | { type: 'columns'; values: number[]; labels: string[]; highlight: number }
  /** `value` is a share of the track, 0 to 100. */
  | { type: 'bars'; rows: { label: string; value: number; text: string }[] }
  /** `start` and `width` are shares of the whole time span, 0 to 100. */
  | { type: 'spans'; rows: { label: string; start: number; width: number }[] };

export interface FactText {
  topic: InsightTopic;
  label: string;
  value: string;
  headline: string;
  note: string;
  chart: Chart | null;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const FOCAL: Record<FocalGroup, string> = {
  'under-35': 'under 35 mm',
  '35-69': '35 to 69 mm',
  '70-199': '70 to 199 mm',
  '200-399': '200 to 399 mm',
  '400-plus': '400 mm or more',
};

const num = (n: number) => n.toLocaleString('en-US');
const share = (part: number, whole: number) => (whole > 0 ? (part * 100) / whole : 0);
const pct = (part: number, whole: number) => `${Math.round(share(part, whole))}%`;
const hour = (h: number) => `${String(h % 24).padStart(2, '0')}:00`;
const date = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const peak = (values: number[]) => values.indexOf(Math.max(...values));
const columns = (values: number[], labels: string[], highlight = peak(values)): Chart => ({ type: 'columns', values, labels, highlight });
const oneDecimal = (n: number) => String(Math.round(n * 10) / 10);

/** The most used camera of each year that has one: context for a change in hit rate, never a stated cause. */
function cameraNote(years: { year: number; camera: string | null }[]): string {
  const named = years.filter((y) => y.camera).map((y) => `${y.camera} in ${y.year}`);
  return named.length ? `Main camera: ${named.join(', ')}` : '';
}

/** All the words and the chart of one fact. */
export function describeFact(fact: Fact): FactText {
  switch (fact.id) {
    case 'top-month': {
      const { counts, total } = fact.data;
      const m = peak(counts);
      return {
        topic: 'time', label: 'Top month', value: MONTHS[m], headline: `${MONTHS[m]} is your busiest month`,
        note: `${num(counts[m])} of ${num(total)} dated photos`, chart: columns(counts, MONTHS.map((n) => n[0])),
      };
    }
    case 'top-weekday': {
      const { counts, total } = fact.data;
      const d = peak(counts);
      return {
        topic: 'time', label: 'Top weekday', value: DAYS[d].slice(0, 3), headline: `${DAYS[d]} is your top day`,
        note: `${pct(counts[d], total)} of dated photos`, chart: columns(counts, DAYS.map((n) => n[0])),
      };
    }
    case 'records': {
      const { busiest, gap } = fact.data;
      return {
        topic: 'time', label: 'Records', value: num(busiest.count), headline: `${num(busiest.count)} photos in one day`,
        note: `${date(busiest.date)}. Longest break: ${num(gap.days)} days, in your indexed photos.`, chart: null,
      };
    }
    case 'shifts': {
      const { older, newer } = fact.data;
      return {
        topic: 'time', label: 'Peak month moved',
        value: `${MONTHS[older.month - 1].slice(0, 3)}→${MONTHS[newer.month - 1].slice(0, 3)}`,
        headline: `Your peak month moved from ${MONTHS[older.month - 1]} to ${MONTHS[newer.month - 1]}`,
        note: `${older.from}-${older.to} against ${newer.from}-${newer.to}`, chart: null,
      };
    }
    case 'top-lens': {
      const { lens, hits } = fact.data;
      return {
        topic: 'gear', label: 'Best-rated lens', value: lens, headline: `Most of your best photos use ${lens}`,
        note: `${num(hits)} high-scoring photos. Only photos with a known lens.`, chart: null,
      };
    }
    case 'hit-rate': {
      const { lenses } = fact.data;
      return {
        topic: 'gear', label: 'Hit rate by lens', value: pct(lenses[0].hits, lenses[0].photos),
        headline: `${lenses[0].lens} wins most often`, note: 'Share that scores 7+, for photos with a known lens',
        chart: { type: 'bars', rows: lenses.map((l) => ({ label: l.lens, value: share(l.hits, l.photos), text: pct(l.hits, l.photos) })) },
      };
    }
    case 'recipe': {
      const { weekday, slot, focal, hits, photos, allHits, allPhotos } = fact.data;
      return {
        topic: 'gear', label: 'Winning recipe', value: `${DAYS[weekday].slice(0, 3)} ${hour(slot)}`,
        headline: `${DAYS[weekday]}, ${hour(slot)} to ${hour(slot + 2)}, ${FOCAL[focal]}`,
        note: `${pct(hits, photos)} score 7+, against ${pct(allHits, allPhotos)} for all photos`,
        chart: {
          type: 'bars',
          rows: [
            { label: 'This recipe', value: share(hits, photos), text: pct(hits, photos) },
            { label: 'All photos', value: share(allHits, allPhotos), text: pct(allHits, allPhotos) },
          ],
        },
      };
    }
    case 'zoom': {
      const { lens, min, max, atMax, photos, buckets } = fact.data;
      return {
        topic: 'gear', label: 'Real zoom use', value: pct(atMax, photos), headline: `${pct(atMax, photos)} of shots at the long end`,
        note: `${lens}, ${min} to ${max} mm`, chart: columns(buckets.map((b) => b.photos), buckets.map((b) => String(b.from))),
      };
    }
    case 'burst': {
      const { years } = fact.data;
      const frames = years.map((y) => y.photos / y.moments);
      const latest = oneDecimal(frames[frames.length - 1]);
      return {
        topic: 'gear', label: 'Burst habit', value: latest, headline: `${latest} frames for each moment`,
        note: `It was ${oneDecimal(frames[0])} in ${years[0].year}`,
        chart: columns(frames, years.map((y) => `’${String(y.year).slice(2)}`), frames.length - 1),
      };
    }
    case 'progress': {
      const { years } = fact.data;
      const [first, last] = [years[0], years[years.length - 1]];
      return {
        topic: 'gear', label: 'Hit rate by year', value: `${pct(first.hits, first.photos)}→${pct(last.hits, last.photos)}`,
        headline: `Your 7+ share went from ${pct(first.hits, first.photos)} to ${pct(last.hits, last.photos)}`,
        note: cameraNote([first, last]),
        chart: columns(years.map((y) => share(y.hits, y.photos)), years.map((y) => `’${String(y.year).slice(2)}`), years.length - 1),
      };
    }
    case 'cameras': {
      const { total, cameras } = fact.data;
      const start = Math.min(...cameras.map((c) => Date.parse(c.first)));
      const span = Math.max(...cameras.map((c) => Date.parse(c.last))) - start || 1;
      return {
        topic: 'gear', label: 'Camera eras', value: num(total), headline: `${num(total)} cameras`,
        note: `First to last use, top ${cameras.length} shown`,
        chart: {
          type: 'spans',
          rows: cameras.map((c) => ({
            label: c.camera,
            start: ((Date.parse(c.first) - start) * 100) / span,
            width: ((Date.parse(c.last) - Date.parse(c.first)) * 100) / span,
          })),
        },
      };
    }
    case 'life-list': {
      const { total, year, newInYear, once, byYear } = fact.data;
      return {
        topic: 'wildlife', label: 'Life list', value: num(total), headline: `${num(total)} species, ${num(newInYear)} new in ${year}`,
        note: `${num(once)} species seen only once`,
        chart: byYear.length ? columns(byYear.map((y) => y.total), byYear.map((y) => String(y.year)), byYear.length - 1) : null,
      };
    }
    case 'best-chance': {
      const { species, photos, month, slot, slots } = fact.data;
      return {
        topic: 'wildlife', label: 'Best chance', value: MONTHS[month - 1].slice(0, 3),
        headline: `${species}: ${MONTHS[month - 1]}, ${hour(slot)} to ${hour(slot + 2)}`,
        note: `From ${num(photos)} photos of this species`,
        chart: columns(slots.map((s) => s.photos), slots.map((s) => hour(s.slot)), slots.findIndex((s) => s.slot === slot)),
      };
    }
    case 'together': {
      const { pairs } = fact.data;
      const [top] = pairs;
      return {
        topic: 'people', label: 'Together', value: num(top.photos), headline: `${top.a.name} and ${top.b.name} appear together most`,
        note: 'Photos with both people',
        chart: {
          type: 'bars',
          rows: pairs.map((p) => ({ label: `${p.a.name} + ${p.b.name}`, value: share(p.photos, top.photos), text: num(p.photos) })),
        },
      };
    }
    case 'missed': {
      const { person, lastDate } = fact.data;
      const years = Math.max(1, Math.floor((Date.now() - Date.parse(`${lastDate}T00:00:00Z`)) / (365.25 * 86_400_000)));
      const seen = new Date(`${lastDate}T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
      return {
        topic: 'people', label: 'Missed', value: `${years} yr`, headline: `No photo of ${person.name} for ${years} ${years === 1 ? 'year' : 'years'}`,
        note: `Last seen ${seen}, in your indexed photos`, chart: null,
      };
    }
    case 'travel': {
      const { km, place, date: day } = fact.data;
      const near = place ? `Near ${place}, ${date(day)}. ` : '';
      return {
        topic: 'places', label: 'Travel', value: `${num(km)} km`, headline: `Your farthest photo: ${num(km)} km`,
        note: `${near}From your usual spot. Only photos with GPS.`, chart: null,
      };
    }
    case 'places': {
      const { year, newCount, top } = fact.data;
      const most = Math.max(...top.map((p) => p.days), 1);
      return {
        topic: 'places', label: 'Places', value: `${num(newCount)} new`,
        headline: `${num(newCount)} new ${newCount === 1 ? 'place' : 'places'} in ${year}`,
        note: 'Days with photos. Only photos with GPS.',
        chart: { type: 'bars', rows: top.map((p) => ({ label: `Near ${p.place}`, value: share(p.days, most), text: `${num(p.days)} d` })) },
      };
    }
  }
}
