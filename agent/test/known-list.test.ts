import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkList, loadList, saveList, searchWikidata } from '../src/known/list';

interface FakeEntity {
  label?: string;
  human?: boolean;
  portrait?: boolean;
  category?: boolean;
  sitelinks?: number;
  description?: string;
}

function entityJson(id: string, e: FakeEntity) {
  const claims: Record<string, unknown[]> = {};
  claims.P31 = [{ mainsnak: { datavalue: { value: { id: e.human === false ? 'Q43229' : 'Q5' } } } }];
  if (e.portrait !== false) claims.P18 = [{ mainsnak: { datavalue: { value: 'X.jpg' } } }];
  if (e.category) claims.P373 = [{ mainsnak: { datavalue: { value: 'Cat' } } }];
  const sitelinks: Record<string, unknown> = {};
  for (let i = 0; i < (e.sitelinks ?? 0); i++) sitelinks[`s${i}wiki`] = {};
  return {
    id,
    labels: e.label ? { en: { value: e.label } } : {},
    descriptions: { en: { value: e.description ?? 'desc' } },
    claims,
    sitelinks,
  };
}

function fakeFetch(entities: Record<string, FakeEntity>, searchIds: string[] = [], calls: string[] = []): typeof fetch {
  return (async (input: string) => {
    calls.push(String(input));
    const url = new URL(String(input));
    if (url.searchParams.get('action') === 'wbsearchentities') {
      return new Response(JSON.stringify({ search: searchIds.map((id) => ({ id })) }));
    }
    const ids = (url.searchParams.get('ids') ?? '').split('|');
    const out: Record<string, unknown> = {};
    for (const id of ids) out[id] = id in entities ? entityJson(id, entities[id]) : { id, missing: '' };
    return new Response(JSON.stringify({ entities: out }));
  }) as unknown as typeof fetch;
}

describe('checkList', () => {
  const clean = [
    { id: 'Q1', name: 'Ada Lovelace', aliases: ['Ada'] },
    { id: 'Q2', name: 'Alan Turing', aliases: [] },
  ];
  const entities = { Q1: { label: 'Ada Lovelace' }, Q2: { label: 'Alan Turing', portrait: false, category: true } };

  it('passes a clean list online and offline', async () => {
    expect(await checkList(clean, { online: true, fetchFn: fakeFetch(entities), delayMs: 0 })).toEqual([]);
    expect(await checkList(clean, { online: false })).toEqual([]);
  });

  it('flags duplicate ids, duplicate names, alias equal to name and schema problems offline', async () => {
    const issues = await checkList(
      [
        { id: 'Q1', name: 'Ada', aliases: ['ada'] },
        { id: 'Q1', name: 'Bob', aliases: [] },
        { id: 'Q3', name: 'bob', aliases: [] },
        { id: '', name: 'X', aliases: [] },
      ],
      { online: false }
    );
    const text = issues.map((i) => `${i.id}:${i.problem}`).join('\n');
    expect(text).toMatch(/duplicate id/);
    expect(text).toMatch(/duplicate name/);
    expect(text).toMatch(/alias equals the name/);
    expect(text).toMatch(/schema/);
  });

  it('flags entries the Worker would reject: long name, long alias, more than 20 aliases', async () => {
    const issues = await checkList(
      [
        { id: 'Q1', name: 'x'.repeat(201), aliases: [] },
        { id: 'Q2', name: 'Ok Two', aliases: ['a'.repeat(101)] },
        { id: 'Q3', name: 'Ok Three', aliases: Array.from({ length: 21 }, (_, i) => `alias ${i}`) },
        { id: 'Q4', name: 'x'.repeat(200), aliases: ['a'.repeat(100), ...Array.from({ length: 19 }, (_, i) => `alias ${i}`)] },
      ],
      { online: false }
    );
    expect(issues.map((i) => i.id).sort()).toEqual(['Q1', 'Q2', 'Q3']);
    expect(issues.every((i) => i.problem.startsWith('schema'))).toBe(true);
  });

  it('flags a non-human, a label mismatch, a missing entity and no portrait or category online', async () => {
    const people = [
      { id: 'Q10', name: 'Some Company', aliases: [] },
      { id: 'Q11', name: 'Jane Smith', aliases: [] },
      { id: 'Q12', name: 'No Media', aliases: [] },
      { id: 'Q13', name: 'Gone Person', aliases: [] },
    ];
    const issues = await checkList(people, {
      online: true,
      delayMs: 0,
      fetchFn: fakeFetch({
        Q10: { label: 'Some Company', human: false },
        Q11: { label: 'Totally Different Label' },
        Q12: { label: 'No Media', portrait: false },
      }),
    });
    const by = Object.fromEntries(issues.map((i) => [i.id, i.problem]));
    expect(by.Q10).toMatch(/not a human/);
    expect(by.Q11).toMatch(/label mismatch/);
    expect(by.Q12).toMatch(/no portrait and no category/);
    expect(by.Q13).toMatch(/not found/);
  });

  it('accepts a label that matches an alias, and batches online lookups by 50', async () => {
    const people = Array.from({ length: 120 }, (_, i) => ({ id: `Q${100 + i}`, name: `Person ${i}`, aliases: [] }));
    const ents: Record<string, FakeEntity> = {};
    for (const p of people) ents[p.id] = { label: p.name };
    const calls: string[] = [];
    expect(await checkList(people, { online: true, fetchFn: fakeFetch(ents, [], calls), delayMs: 0 })).toEqual([]);
    expect(calls).toHaveLength(3);
    const one = await checkList([{ id: 'Q1', name: 'Sachin', aliases: ['Sachin Tendulkar'] }], {
      online: true,
      delayMs: 0,
      fetchFn: fakeFetch({ Q1: { label: 'Sachin Tendulkar' } }),
    });
    expect(one).toEqual([]);
  });
});

describe('multilingual labels', () => {
  it('falls back to the "mul" label when there is no English one', async () => {
    const fetchFn = (async () =>
      new Response(
        JSON.stringify({
          entities: {
            Q1: {
              id: 'Q1',
              labels: { mul: { value: 'Beyonce Knowles' } },
              claims: {
                P31: [{ mainsnak: { datavalue: { value: { id: 'Q5' } } } }],
                P18: [{ mainsnak: { datavalue: { value: 'X.jpg' } } }],
              },
            },
          },
        })
      )) as unknown as typeof fetch;
    expect(await checkList([{ id: 'Q1', name: 'Beyonce Knowles', aliases: [] }], { online: true, fetchFn, delayMs: 0 })).toEqual([]);
  });
});

describe('searchWikidata', () => {
  it('orders humans first, then by sitelinks', async () => {
    const fetchFn = fakeFetch(
      {
        Q1: { label: 'Org', human: false, sitelinks: 99 },
        Q2: { label: 'Few', sitelinks: 3 },
        Q3: { label: 'Many', sitelinks: 50, category: true },
      },
      ['Q1', 'Q2', 'Q3']
    );
    const result = await searchWikidata('x', { fetchFn });
    expect(result.map((c) => c.id)).toEqual(['Q3', 'Q2', 'Q1']);
    expect(result[0]).toMatchObject({ label: 'Many', isHuman: true, hasPortrait: true, hasCategory: true, sitelinks: 50 });
    expect(result[2].isHuman).toBe(false);
  });
});

describe('saveList and loadList', () => {
  it('sorts by name, one object per line, and is stable', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'known-list-'));
    const file = path.join(dir, 'people.json');
    await saveList(file, [
      { id: 'Q2', name: 'Zed', aliases: [] },
      { id: 'Q1', name: 'Amy', aliases: ['A'] },
    ]);
    const text = await fs.readFile(file, 'utf8');
    expect(text.split('\n').filter((l) => l.includes('"id"'))).toHaveLength(2);
    expect(text.indexOf('Amy')).toBeLessThan(text.indexOf('Zed'));
    const loaded = await loadList(file);
    await saveList(file, loaded);
    expect(await fs.readFile(file, 'utf8')).toBe(text);
  });
});

describe('committed people.json', () => {
  const file = new URL('../known/people.json', import.meta.url).pathname;

  it('has at least 200 entries and passes the offline checks', async () => {
    const people = await loadList(file);
    expect(people.length).toBeGreaterThanOrEqual(200);
    expect(people.every((p) => p.name.length >= 2)).toBe(true);
    expect(await checkList(people, { online: false })).toEqual([]);
  });

  it('is already in saveList format', async () => {
    const raw = await fs.readFile(file, 'utf8');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'known-list-'));
    const copy = path.join(dir, 'p.json');
    await saveList(copy, await loadList(file));
    expect(await fs.readFile(copy, 'utf8')).toBe(raw);
  });
});
