import fs from 'node:fs/promises';
import { z } from 'zod';
import type { KnownPerson } from './gallery';

const USER_AGENT = 'face-gallery-builder/0.1';
const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';
const BATCH = 50;
const HUMAN = 'Q5';

/** Same limits as the Worker's POST /ingest/known-people (name 1..200, up to 20 aliases of 1..100 characters). */
export const PersonSchema = z.object({
  id: z.string().regex(/^Q\d+$/),
  name: z.string().min(1).max(200),
  aliases: z.array(z.string().min(1).max(100)).max(20),
});

export interface Candidate {
  id: string;
  label: string;
  description: string;
  sitelinks: number;
  hasPortrait: boolean;
  hasCategory: boolean;
  isHuman: boolean;
}

export interface CheckIssue {
  id: string;
  name: string;
  problem: string;
}

interface Deps {
  fetchFn?: typeof fetch;
  /** Minimum delay between Wikidata requests; tests pass 0. */
  delayMs?: number;
}

interface Entity {
  id?: string;
  missing?: string;
  labels?: { en?: { value?: string }; mul?: { value?: string } };
  descriptions?: { en?: { value?: string }; mul?: { value?: string } };
  claims?: Record<string, { mainsnak?: { datavalue?: { value?: unknown } } }[]>;
  sitelinks?: Record<string, unknown>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function loadList(path: string): Promise<KnownPerson[]> {
  const raw = JSON.parse(await fs.readFile(path, 'utf8')) as unknown;
  return z.array(z.object({ id: z.string(), name: z.string(), aliases: z.array(z.string()) })).parse(raw);
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
// Plain code point order on the lowercased name, so the order never depends on the machine locale.
const byName = (a: KnownPerson, b: KnownPerson) => cmp(a.name.toLowerCase(), b.name.toLowerCase()) || cmp(a.id, b.id);

/** Sorted by name (code point order, case-insensitive), one JSON object per line. */
export async function saveList(path: string, people: KnownPerson[]): Promise<void> {
  const lines = [...people].sort(byName).map(
    (p) => `  {"id": ${JSON.stringify(p.id)}, "name": ${JSON.stringify(p.name)}, "aliases": [${p.aliases.map((a) => JSON.stringify(a)).join(', ')}]}`
  );
  await fs.writeFile(path, `[\n${lines.join(',\n')}\n]\n`);
}

class WikidataApi {
  private last = 0;
  constructor(
    private readonly fetchFn: typeof fetch,
    private readonly delayMs: number
  ) {}

  async get<T>(params: Record<string, string>): Promise<T> {
    const url = `${WIKIDATA_API}?${new URLSearchParams({ format: 'json', ...params }).toString()}`;
    for (let attempt = 0; ; attempt++) {
      const wait = this.last + this.delayMs - Date.now();
      if (wait > 0) await sleep(wait);
      this.last = Date.now();
      const response = await this.fetchFn(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 429 && attempt < 3) {
        await sleep(Math.max(5_000, this.delayMs) * (attempt + 1));
        continue;
      }
      if (!response.ok) throw new Error(`Wikidata request failed: ${response.status}`);
      return (await response.json()) as T;
    }
  }

  async entities(ids: string[]): Promise<Record<string, Entity>> {
    const data = await this.get<{ entities?: Record<string, Entity> }>({
      action: 'wbgetentities',
      ids: ids.join('|'),
      props: 'labels|descriptions|claims|sitelinks',
      languages: 'en|mul',
    });
    return data.entities ?? {};
  }
}

function hasClaim(entity: Entity, property: string): boolean {
  return (entity.claims?.[property]?.length ?? 0) > 0;
}

function isHuman(entity: Entity): boolean {
  return (entity.claims?.P31 ?? []).some((c) => {
    const value = c.mainsnak?.datavalue?.value as { id?: string } | undefined;
    return value?.id === HUMAN;
  });
}

function toCandidate(id: string, entity: Entity): Candidate {
  return {
    id,
    label: entity.labels?.en?.value ?? entity.labels?.mul?.value ?? '',
    description: entity.descriptions?.en?.value ?? '',
    sitelinks: Object.keys(entity.sitelinks ?? {}).length,
    hasPortrait: hasClaim(entity, 'P18'),
    hasCategory: hasClaim(entity, 'P373'),
    isHuman: isHuman(entity),
  };
}

/** Humans first, then by number of Wikipedia sitelinks (a rough popularity signal). */
export async function searchWikidata(query: string, deps: Deps = {}): Promise<Candidate[]> {
  const api = new WikidataApi(deps.fetchFn ?? fetch, deps.delayMs ?? 1000);
  const found = await api.get<{ search?: { id: string }[] }>({
    action: 'wbsearchentities',
    search: query,
    language: 'en',
    type: 'item',
    limit: '10',
  });
  const ids = (found.search ?? []).map((s) => s.id);
  if (ids.length === 0) return [];
  const entities = await api.entities(ids);
  return ids
    .filter((id) => entities[id] && !('missing' in entities[id]))
    .map((id) => toCandidate(id, entities[id]))
    .sort((a, b) => Number(b.isHuman) - Number(a.isHuman) || b.sitelinks - a.sitelinks);
}

/** Fetches the entity details for ids, in batches of 50. Used by known-add and known-check. */
export async function fetchCandidates(ids: string[], deps: Deps = {}): Promise<Map<string, Candidate | undefined>> {
  const api = new WikidataApi(deps.fetchFn ?? fetch, deps.delayMs ?? 1000);
  const result = new Map<string, Candidate | undefined>();
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    const entities = await api.entities(batch);
    for (const id of batch) {
      const e = entities[id];
      result.set(id, e && !('missing' in e) ? toCandidate(id, e) : undefined);
    }
  }
  return result;
}

const normalize = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** True when the English label is close to the name or one of its aliases. */
export function labelMatches(label: string, name: string, aliases: string[]): boolean {
  const l = normalize(label);
  if (!l) return false;
  return [name, ...aliases].some((candidate) => {
    const n = normalize(candidate);
    if (!n) return false;
    if (n === l || l.includes(n) || n.includes(l)) return true;
    const a = new Set(l.split(' '));
    const b = new Set(n.split(' '));
    const shared = [...a].filter((t) => b.has(t)).length;
    return shared / Math.min(a.size, b.size) >= 0.6;
  });
}

export function offlineIssues(people: KnownPerson[]): CheckIssue[] {
  const issues: CheckIssue[] = [];
  const ids = new Map<string, number>();
  const names = new Map<string, number>();
  for (const p of people) {
    const idLabel = typeof p?.id === 'string' ? p.id : '';
    const nameLabel = typeof p?.name === 'string' ? p.name : '';
    const parsed = PersonSchema.safeParse(p);
    if (!parsed.success) {
      issues.push({ id: idLabel, name: nameLabel, problem: `schema: ${parsed.error.issues[0]?.message ?? 'invalid'}` });
      continue;
    }
    ids.set(p.id, (ids.get(p.id) ?? 0) + 1);
    const key = p.name.trim().toLowerCase();
    names.set(key, (names.get(key) ?? 0) + 1);
    if (p.aliases.some((a) => a.trim().toLowerCase() === key)) {
      issues.push({ id: p.id, name: p.name, problem: 'alias equals the name' });
    }
  }
  for (const p of people) {
    if (typeof p?.id === 'string' && (ids.get(p.id) ?? 0) > 1) {
      issues.push({ id: p.id, name: p.name, problem: 'duplicate id' });
    }
    if (typeof p?.name === 'string' && (names.get(p.name.trim().toLowerCase()) ?? 0) > 1) {
      issues.push({ id: p.id, name: p.name, problem: 'duplicate name' });
    }
  }
  return issues;
}

/** Problems with one entry that the live Wikidata record shows; empty when the entry is fine. */
export function entityProblems(person: KnownPerson, candidate: Candidate | undefined): string[] {
  if (!candidate) return ['not found on Wikidata'];
  const problems: string[] = [];
  if (!candidate.isHuman) problems.push('not a human (P31 is not Q5)');
  if (!labelMatches(candidate.label, person.name, person.aliases)) {
    problems.push(`label mismatch: Wikidata label is "${candidate.label}"`);
  }
  if (!candidate.hasPortrait && !candidate.hasCategory) problems.push('no portrait and no category');
  return problems;
}

export async function checkList(
  people: KnownPerson[],
  opts: { online: boolean; fetchFn?: typeof fetch; delayMs?: number }
): Promise<CheckIssue[]> {
  const issues = offlineIssues(people);
  if (!opts.online) return issues;
  const valid = people.filter((p) => PersonSchema.safeParse(p).success);
  const details = await fetchCandidates(
    [...new Set(valid.map((p) => p.id))],
    { fetchFn: opts.fetchFn, delayMs: opts.delayMs }
  );
  for (const p of valid) {
    for (const problem of entityProblems(p, details.get(p.id))) {
      issues.push({ id: p.id, name: p.name, problem });
    }
  }
  return issues;
}
