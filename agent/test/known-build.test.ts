import { describe, expect, it } from 'vitest';
import {
  buildGallery,
  GROUP_MARGIN,
  GROUP_MIN_COSINE,
  GROUP_PHOTO_LIMIT,
  MAX_GROUP_FACES,
  MAX_REFS,
  RATE_LIMIT_STOP_AFTER,
} from '../src/known/buildGallery';
import { RateLimitedError } from '../src/known/wikimedia';
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

  describe('excluded people', () => {
    const two = [person('Q1'), person('Q2')];
    const firstBuild = async () => {
      const first = setup({ Q1: many(2), Q2: many(4, 3) });
      return (await buildGallery({ ...first.deps, people: two })).gallery;
    };

    it('records excluded people with their ref count', async () => {
      const gallery = await firstBuild();
      expect(gallery.people.map((p) => p.id)).toEqual(['Q2']);
      expect(gallery.excluded).toEqual([{ id: 'Q1', refs: 2 }]);
    });

    it('a second run does not refetch an excluded person but still reports them', async () => {
      const gallery = await firstBuild();
      const second = setup({ Q1: many(2), Q2: many(4, 3) });
      const res = await buildGallery({ ...second.deps, people: two, existing: gallery });
      expect(second.fetched).toEqual([]);
      expect(res.gallery.excluded).toEqual([{ id: 'Q1', refs: 2 }]);
      expect(res.report.excluded).toEqual([{ id: 'Q1', name: 'Name Q1', refs: 2 }]);
    });

    it('--rebuild and retryExcluded refetch them, and a person who now qualifies leaves the record', async () => {
      const gallery = await firstBuild();
      const a = setup({ Q1: many(4), Q2: many(4, 3) });
      const viaRebuild = await buildGallery({ ...a.deps, people: two, existing: gallery, rebuild: ['Q1'] });
      expect(a.fetched).toEqual(['Q1']);
      expect(viaRebuild.gallery.people.map((p) => p.id)).toEqual(['Q1', 'Q2']);
      expect(viaRebuild.gallery.excluded).toBeUndefined();
      const b = setup({ Q1: many(2), Q2: many(4, 3) });
      const viaRetry = await buildGallery({ ...b.deps, people: two, existing: gallery, retryExcluded: true });
      expect(b.fetched).toEqual(['Q1']);
      expect(viaRetry.gallery.excluded).toEqual([{ id: 'Q1', refs: 2 }]);
    });

    it('drops the record when the person leaves the list', async () => {
      const gallery = await firstBuild();
      const next = setup({ Q2: many(4, 3) });
      const res = await buildGallery({ ...next.deps, people: [person('Q2')], existing: gallery });
      expect(res.gallery.excluded).toBeUndefined();
    });

    it('a failed person is retried and a failed retry keeps the excluded record', async () => {
      const gallery = await firstBuild();
      const failing = setup({ Q1: many(4), Q2: many(4, 3) });
      const boom = { ...(failing.deps.wikimedia as object), portrait: async () => { throw new Error('429'); } };
      const res = await buildGallery({ ...failing.deps, wikimedia: boom as never, people: two, existing: gallery, rebuild: ['Q1'] });
      expect(res.report.failed.map((f) => f.id)).toEqual(['Q1']);
      expect(res.gallery.excluded).toEqual([{ id: 'Q1', refs: 2 }]);
      const fresh = setup({ Q1: many(4) });
      const failNew = { ...(fresh.deps.wikimedia as object), portrait: async () => { throw new Error('429'); } };
      const r2 = await buildGallery({ ...fresh.deps, wikimedia: failNew as never, people: [person('Q1')] });
      expect(r2.gallery.excluded).toBeUndefined();
      expect(r2.gallery.people).toEqual([]);
    });
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

  it('a rate limited download fails the person instead of excluding them', async () => {
    const { deps } = setup({ Q1: many(4) });
    const res = await buildGallery({
      ...deps,
      download: async () => {
        throw new RateLimitedError(429);
      },
      people: [person('Q1')],
    });
    expect(res.report.failed.map((f) => f.id)).toEqual(['Q1']);
    expect(res.report.excluded).toEqual([]);
    expect(res.gallery.excluded).toBeUndefined();
  });

  it('skips non-raster candidates without asking for their info', async () => {
    const { deps } = setup({ Q1: many(4) });
    const asked: string[] = [];
    const wikimedia = deps.wikimedia as unknown as { categoryFiles: () => Promise<string[]>; fileInfo: (t: string) => Promise<unknown> };
    const orig = wikimedia.fileInfo;
    wikimedia.categoryFiles = async () => ['File:Voice.ogg', 'File:Q1-0.jpg', 'File:x.svg'];
    wikimedia.fileInfo = async (t) => {
      asked.push(t);
      return orig(t);
    };
    await buildGallery({ ...deps, people: [person('Q1')] });
    expect(asked).toEqual(['File:Q1-0.jpg']);
  });

  it('stops after 5 rate limited people in a row, checkpointing finished people first', async () => {
    const people = [person('Q0'), ...[1, 2, 3, 4, 5, 6, 7].map((n) => person(`Q${n}`))];
    const { deps } = setup({ Q0: many(4) });
    const wikimedia = deps.wikimedia as unknown as { portrait: (q: string) => Promise<unknown> };
    const calls: string[] = [];
    wikimedia.portrait = async (q) => {
      calls.push(q);
      if (q !== 'Q0') throw new RateLimitedError(429);
      return undefined;
    };
    const checkpoints: Gallery[] = [];
    await expect(
      buildGallery({
        ...deps,
        people,
        onCheckpoint: async (g) => {
          checkpoints.push(g);
        },
      })
    ).rejects.toThrow(/rate limiting this machine; wait a few minutes and rerun, finished people are kept/);
    expect(RATE_LIMIT_STOP_AFTER).toBe(5);
    expect(calls).toEqual(['Q0', 'Q1', 'Q2', 'Q3', 'Q4', 'Q5']);
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0].people.map((p) => p.id)).toEqual(['Q0']);
  });

  it('prefetches only the people to crawl, uses batched fileInfos, and prints a request estimate', async () => {
    const { deps } = setup({ Q1: many(4), Q2: many(4, 3) });
    const wm = deps.wikimedia as unknown as Record<string, unknown>;
    const orig = wm.fileInfo as (t: string) => Promise<unknown>;
    const prefetched: string[][] = [];
    const batches: string[][] = [];
    wm.prefetch = async (ids: string[]) => {
      prefetched.push(ids);
    };
    wm.fileInfos = async (titles: string[]) => {
      batches.push(titles);
      return new Map(await Promise.all(titles.map(async (t) => [t, await orig(t)] as const)));
    };
    wm.paceMs = 6500;
    const { gallery: prior } = await buildGallery({ ...setup({ Q1: many(4) }).deps, people: [person('Q1')] });
    const messages: string[] = [];
    await buildGallery({ ...deps, people: [person('Q1'), person('Q2')], existing: prior, onProgress: (m) => messages.push(m) });
    expect(prefetched).toEqual([['Q2']]);
    expect(batches).toHaveLength(1);
    expect(messages.some((m) => /Crawling 1 people: about 5 Wikimedia API requests, at least 1 min/.test(m))).toBe(true);
  });

  it('a person whose Wikidata batch failed is failed, not excluded', async () => {
    const { deps } = setup({ Q1: many(4) });
    const wm = deps.wikimedia as unknown as Record<string, unknown>;
    wm.prefetch = async () => {};
    wm.portrait = async () => {
      throw new RateLimitedError(429);
    };
    const res = await buildGallery({ ...deps, people: [person('Q1')] });
    expect(res.report.failed.map((f) => f.id)).toEqual(['Q1']);
    expect(res.report.excluded).toEqual([]);
  });

  it('a success in between resets the rate limit streak', async () => {
    const { deps } = setup({ Q3: many(4) });
    const wikimedia = deps.wikimedia as unknown as { portrait: (q: string) => Promise<unknown> };
    wikimedia.portrait = async (q) => {
      if (q !== 'Q3') throw new RateLimitedError(429);
      return undefined;
    };
    const people = ['Q1', 'Q2', 'Q4', 'Q5'].map(person);
    people.splice(2, 0, person('Q3'));
    const res = await buildGallery({ ...deps, people: [...people, ...['Q6', 'Q7'].map(person)] });
    expect(res.report.failed).toHaveLength(6);
  });

  describe('group photos', () => {
    /** Unit vector with cosine `c` to axis `axis`, the rest on `other`. */
    const mix = (axis: number, c: number, other = 200): string => {
      const v = new Float32Array(DIM);
      v[axis] = c;
      v[other] = Math.sqrt(1 - c * c);
      return Buffer.from(v.buffer).toString('base64');
    };
    const face = (embedding: string, detScore = 0.9) => ({ detScore, embedding });
    const group = (...faces: ReturnType<typeof face>[]): FakeImage => ({ faces });
    const run = async (images: FakeImage[]) => {
      const { deps } = setup({ Q1: images });
      const lines: string[] = [];
      const res = await buildGallery({ ...deps, people: [person('Q1')], onProgress: (m) => lines.push(m) });
      return { ...res, lines };
    };
    const ref = (r: { gallery: { people: { refs: Float32Array[] }[] } }, i: number) => r.gallery.people[0].refs[i];

    it('accepts the one face that matches the anchors and keeps that face embedding, not the first', async () => {
      const r = await run([...many(3), group(face(emb(7)), face(mix(0, 0.8)))]);
      expect(r.gallery.people[0].refs).toHaveLength(4);
      const picked = ref(r, 3);
      expect(picked[200]).toBeCloseTo(0.6, 3);
      expect(picked[7]).toBe(0);
      expect(r.report.groupRefs).toBe(1);
      expect(r.lines.some((l) => /group .*: picked face \(cos 0\.8\d\)/.test(l))).toBe(true);
    });

    it('rejects a photo whose two faces both look like the anchors (margin too small)', async () => {
      const r = await run([...many(3), group(face(mix(0, 0.8, 200)), face(mix(0, 0.78, 201)))]);
      expect(r.gallery.people[0].refs).toHaveLength(3);
      expect(r.report.groupRefs).toBe(0);
      expect(r.lines.some((l) => l.includes('no confident face among 2'))).toBe(true);
      expect(GROUP_MARGIN).toBeGreaterThan(0.02);
    });

    it('rejects a best face below the cosine threshold', async () => {
      const r = await run([...many(3), group(face(emb(7)), face(mix(0, GROUP_MIN_COSINE - 0.1)))]);
      expect(r.gallery.people[0].refs).toHaveLength(3);
      expect(r.report.groupRefs).toBe(0);
    });

    it('needs at least one anchor: group photos alone never create refs', async () => {
      const r = await run(Array.from({ length: 6 }, () => group(face(emb(0)), face(emb(7)))));
      expect(r.report.excluded).toEqual([{ id: 'Q1', name: 'Name Q1', refs: 0 }]);
      expect(r.report.groupRefs).toBe(0);
    });

    it('ignores low detection score faces and photos with no faces or too many faces', async () => {
      const crowd = group(...Array.from({ length: MAX_GROUP_FACES + 1 }, (_, i) => face(i === 0 ? mix(0, 0.9) : emb(10 + i))));
      const r = await run([...many(3), crowd, { faces: [] }, group(face(mix(0, 0.9), 0.3), face(emb(7)))]);
      expect(r.gallery.people[0].refs).toHaveLength(3);
      expect(r.report.groupRefs).toBe(0);
    });

    it('tries at most GROUP_PHOTO_LIMIT group photos per person', async () => {
      const rejected = Array.from({ length: GROUP_PHOTO_LIMIT + 10 }, () => group(face(emb(7)), face(emb(8))));
      const r = await run([...many(3), ...rejected]);
      const tried = r.lines.filter((l) => /^ {2}(group|skip) .*(picked|no confident)/.test(l));
      expect(tried).toHaveLength(GROUP_PHOTO_LIMIT);
    });

    it('stops at MAX_REFS', async () => {
      const accepted = Array.from({ length: 20 }, (_, i) => group(face(emb(300 + i)), face(mix(0, 0.8, 201 + (i % 5)))));
      const r = await run([...many(4), ...accepted]);
      expect(r.gallery.people[0].refs).toHaveLength(MAX_REFS);
      expect(r.report.groupRefs).toBe(MAX_REFS - 4);
      expect(r.lines.filter((l) => l.includes('picked face'))).toHaveLength(MAX_REFS - 4);
    });
  });
});
