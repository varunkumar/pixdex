import { describe, expect, it } from 'vitest';
import { buildGallery, MAX_REFS } from '../src/known/buildGallery';
import type { Gallery, KnownPerson } from '../src/known/gallery';

const DIM = 512;

function emb(axis: number, tilt = 0, amount = 0): string {
  const v = new Float32Array(DIM);
  v[axis] = 1;
  if (amount) v[tilt] = amount;
  return Buffer.from(v.buffer).toString('base64');
}

interface FakeImage {
  faces: { detScore: number; embedding: string }[];
  license?: string;
}

function person(id: string): KnownPerson {
  return { id, name: `Name ${id}`, aliases: [] };
}

function setup(images: Record<string, FakeImage[]>, model = 'm1') {
  const fetched: string[] = [];
  const wikimedia = {
    portrait: async (qid: string) => {
      fetched.push(qid);
      return undefined;
    },
    categoryFiles: async (qid: string) => (images[qid] ?? []).map((_, i) => `File:${qid}-${i}.jpg`),
    fileInfo: async (title: string) => {
      const [qid, i] = title.replace('File:', '').replace('.jpg', '').split('-');
      const img = images[qid]?.[Number(i)];
      return img ? { thumbUrl: `https://x/${title}`, license: img.license ?? 'CC BY-SA 4.0' } : undefined;
    },
    isOpenLicense: (l: string) => l.startsWith('CC'),
  };
  const sidecar = {
    model: async () => model,
    detect: async (buf: Buffer) => {
      const [qid, i] = buf.toString().replace('https://x/File:', '').replace('.jpg', '').split('-');
      return {
        model,
        width: 1,
        height: 1,
        faces: images[qid][Number(i)].faces.map((f) => ({ bbox: [0, 0, 1, 1], ...f })),
      };
    },
  };
  const download = async (url: string) => Buffer.from(url);
  return { fetched, deps: { wikimedia: wikimedia as never, sidecar: sidecar as never, download } };
}

const good = (axis = 0, tilt = 1, amount = 0.05): FakeImage => ({
  faces: [{ detScore: 0.9, embedding: emb(axis, tilt, amount) }],
});
const many = (n: number, axis = 0): FakeImage[] =>
  Array.from({ length: n }, (_, i) => good(axis, 1 + (i % 5), 0.05 * (i % 3)));

describe('buildGallery', () => {
  it('includes a person with enough refs and reports it', async () => {
    const { deps } = setup({ Q1: many(4) });
    const { gallery, report } = await buildGallery({ ...deps, people: [person('Q1')] });
    expect(gallery.model).toBe('m1');
    expect(gallery.people[0].refs).toHaveLength(4);
    expect(report.included).toEqual([{ id: 'Q1', name: 'Name Q1', refs: 4 }]);
    expect(report.averageRefs).toBe(4);
  });

  it('excludes a person with 2 usable images and lists them', async () => {
    const { deps } = setup({ Q1: many(2), Q2: many(5, 3) });
    const { gallery, report } = await buildGallery({ ...deps, people: [person('Q1'), person('Q2')] });
    expect(gallery.people.map((p) => p.id)).toEqual(['Q2']);
    expect(report.excluded).toEqual([{ id: 'Q1', name: 'Name Q1', refs: 2 }]);
    expect(report.averageRefs).toBe(5);
  });

  it('skips two-face, low-score, no-face, non-open and non-finite images', async () => {
    const nan = new Float32Array(DIM);
    nan[0] = NaN;
    const images: FakeImage[] = [
      ...many(3),
      { faces: [good().faces[0], good().faces[0]] },
      { faces: [{ detScore: 0.3, embedding: emb(0) }] },
      { faces: [] },
      { ...good(), license: 'All rights reserved' },
      { faces: [{ detScore: 0.9, embedding: Buffer.from(nan.buffer).toString('base64') }] },
    ];
    const { deps } = setup({ Q1: images });
    const { report } = await buildGallery({ ...deps, people: [person('Q1')] });
    expect(report.included[0].refs).toBe(3);
  });

  it('drops an outlier ref', async () => {
    const images = [...many(4), { faces: [{ detScore: 0.9, embedding: emb(100) }] }];
    const { deps } = setup({ Q1: images });
    const { gallery } = await buildGallery({ ...deps, people: [person('Q1')] });
    expect(gallery.people[0].refs).toHaveLength(4);
  });

  it('caps refs at MAX_REFS', async () => {
    const { deps } = setup({ Q1: many(25) });
    const { gallery } = await buildGallery({ ...deps, people: [person('Q1')] });
    expect(gallery.people[0].refs).toHaveLength(MAX_REFS);
  });

  it('incremental: only the new person is fetched, others untouched', async () => {
    const first = setup({ Q1: many(4) });
    const { gallery } = await buildGallery({ ...first.deps, people: [person('Q1')] });
    const second = setup({ Q1: many(4), Q2: many(4, 3) });
    const res = await buildGallery({ ...second.deps, people: [person('Q1'), person('Q2')], existing: gallery });
    expect(second.fetched).toEqual(['Q2']);
    expect(res.gallery.people.map((p) => p.id)).toEqual(['Q1', 'Q2']);
    expect(res.gallery.people[0].refs).toBe(gallery.people[0].refs);
    expect(res.report.included.map((i) => i.id)).toEqual(['Q1', 'Q2']);
  });

  it('rebuild refetches just the named id', async () => {
    const first = setup({ Q1: many(4), Q2: many(4, 3) });
    const { gallery } = await buildGallery({ ...first.deps, people: [person('Q1'), person('Q2')] });
    const second = setup({ Q1: many(5), Q2: many(4, 3) });
    const res = await buildGallery({
      ...second.deps,
      people: [person('Q1'), person('Q2')],
      existing: gallery,
      rebuild: ['Q1'],
    });
    expect(second.fetched).toEqual(['Q1']);
    expect(res.gallery.people[0].refs).toHaveLength(5);
    expect(res.gallery.people[1].refs).toBe(gallery.people[1].refs);
  });

  it('drops a person removed from the list', async () => {
    const first = setup({ Q1: many(4), Q2: many(4, 3) });
    const { gallery } = await buildGallery({ ...first.deps, people: [person('Q1'), person('Q2')] });
    const second = setup({ Q1: many(4) });
    const res = await buildGallery({ ...second.deps, people: [person('Q1')], existing: gallery });
    expect(res.gallery.people.map((p) => p.id)).toEqual(['Q1']);
    expect(second.fetched).toEqual([]);
  });

  it('ignores an existing gallery of another model', async () => {
    const first = setup({ Q1: many(4) }, 'old');
    const { gallery } = await buildGallery({ ...first.deps, people: [person('Q1')] });
    const second = setup({ Q1: many(4) }, 'new');
    const res = await buildGallery({ ...second.deps, people: [person('Q1')], existing: gallery as Gallery });
    expect(second.fetched).toEqual(['Q1']);
    expect(res.gallery.model).toBe('new');
  });
});
