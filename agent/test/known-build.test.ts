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

  it('a Wikimedia failure marks only that person failed and the build continues', async () => {
    const { deps } = setup({ Q1: many(4), Q2: many(4, 3) });
    const wiki = deps.wikimedia as unknown as { categoryFiles: (q: string) => Promise<string[]> };
    const orig = wiki.categoryFiles;
    wiki.categoryFiles = async (q) => {
      if (q === 'Q1') throw new Error('Wikimedia request failed: 429');
      return orig(q);
    };
    const { gallery, report } = await buildGallery({ ...deps, people: [person('Q1'), person('Q2')] });
    expect(gallery.people.map((p) => p.id)).toEqual(['Q2']);
    expect(report.failed).toEqual([{ id: 'Q1', name: 'Name Q1', error: 'Wikimedia request failed: 429' }]);
    expect(report.excluded).toEqual([]);
    // Retried on the next incremental run.
    const again = setup({ Q1: many(4), Q2: many(4, 3) });
    const res = await buildGallery({ ...again.deps, people: [person('Q1'), person('Q2')], existing: gallery });
    expect(again.fetched).toEqual(['Q1']);
    expect(res.gallery.people.map((p) => p.id)).toEqual(['Q1', 'Q2']);
  });

  it('a failed rebuild keeps the previous refs', async () => {
    const first = setup({ Q1: many(4) });
    const { gallery } = await buildGallery({ ...first.deps, people: [person('Q1')] });
    const second = setup({ Q1: many(4) });
    (second.deps.wikimedia as unknown as { portrait: () => Promise<never> }).portrait = async () => {
      throw new Error('boom');
    };
    const res = await buildGallery({ ...second.deps, people: [person('Q1')], existing: gallery, rebuild: ['Q1'] });
    expect(res.gallery.people[0].refs).toBe(gallery.people[0].refs);
    expect(res.report.failed).toHaveLength(1);
  });

  it('aborts with SidecarDownError after checkpointing when the sidecar dies', async () => {
    const first = setup({ Q1: many(4) });
    const { gallery: prior } = await buildGallery({ ...first.deps, people: [person('Q1')] });
    const { deps } = setup({ Q2: many(4, 3), Q3: many(4, 6) });
    let alive = true;
    const sidecar = deps.sidecar as unknown as { detect: () => Promise<never>; model: () => Promise<string> };
    sidecar.detect = async () => {
      alive = false;
      throw new TypeError('fetch failed');
    };
    sidecar.model = async () => {
      if (!alive) throw new Error('ECONNREFUSED');
      return 'm1';
    };
    const checkpoints: Gallery[] = [];
    await expect(
      buildGallery({
        ...deps,
        people: [person('Q1'), person('Q2'), person('Q3')],
        existing: prior,
        onCheckpoint: async (g) => {
          checkpoints.push(g);
        },
      })
    ).rejects.toThrow(/sidecar is not reachable/i);
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0].people.map((p) => p.id)).toEqual(['Q1']);
  });

  it('a sidecar error on one image with a healthy sidecar only skips that image', async () => {
    const { deps } = setup({ Q1: many(4) });
    const sidecar = deps.sidecar as unknown as { detect: (b: Buffer) => Promise<unknown> };
    const orig = sidecar.detect;
    sidecar.detect = async (b) => {
      if (b.toString().endsWith('Q1-0.jpg')) throw new Error('sidecar /faces failed: 400');
      return orig(b);
    };
    const { report } = await buildGallery({ ...deps, people: [person('Q1')] });
    expect(report.included[0].refs).toBe(3);
  });

  it('checkpoints every 25 people and at the end, and warns on unknown rebuild ids', async () => {
    const images: Record<string, FakeImage[]> = {};
    const people: KnownPerson[] = [];
    for (let i = 0; i < 30; i++) {
      images[`Q${i}`] = many(3, i);
      people.push(person(`Q${i}`));
    }
    const { deps } = setup(images);
    const sizes: number[] = [];
    const messages: string[] = [];
    await buildGallery({
      ...deps,
      people,
      rebuild: ['Q999'],
      onCheckpoint: async (g) => {
        sizes.push(g.people.length);
      },
      onProgress: (m) => messages.push(m),
    });
    expect(sizes).toEqual([25, 30]);
    expect(messages.some((m) => m.includes('Q999'))).toBe(true);
  });
});
