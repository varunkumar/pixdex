import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  expandRequest,
  getPromptApiStatus,
  parseExpansion,
} from '../promptApi';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubModel(promptImpl: ReturnType<typeof vi.fn>, availability = 'available') {
  const destroy = vi.fn();
  const create = vi.fn(async () => ({ prompt: promptImpl, destroy }));
  vi.stubGlobal('LanguageModel', {
    availability: vi.fn(async () => availability),
    create,
  });
  return { destroy, create };
}

describe('getPromptApiStatus', () => {
  it('is unsupported when LanguageModel is undefined', async () => {
    expect(await getPromptApiStatus()).toBe('unsupported');
  });

  it('is unsupported when availability is unavailable', async () => {
    stubModel(vi.fn(), 'unavailable');
    expect(await getPromptApiStatus()).toBe('unsupported');
  });

  it('is unsupported when availability throws', async () => {
    vi.stubGlobal('LanguageModel', {
      availability: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    expect(await getPromptApiStatus()).toBe('unsupported');
  });

  it('passes through downloadable', async () => {
    stubModel(vi.fn(), 'downloadable');
    expect(await getPromptApiStatus()).toBe('downloadable');
  });
});

describe('parseExpansion', () => {
  it('parses prose-wrapped JSON, splitting commas, occasion first, deduped', () => {
    const r = parseExpansion(
      'Sure! {"occasion":"Diwali","keywords":["diya","Diwali","golden, glow"]}',
    );
    expect(r.occasion).toBe('diwali');
    expect(r.keywords).toEqual(['diwali', 'diya', 'golden', 'glow']);
  });

  it('falls back to a bare array', () => {
    const r = parseExpansion('["a","b"]');
    expect(r.keywords).toEqual(['a', 'b']);
  });

  it('parses an array wrapped in prose', () => {
    expect(parseExpansion('Here: ["A", "b", "a"] done').keywords).toEqual(['a', 'b']);
  });

  it('throws when nothing usable', () => {
    expect(() => parseExpansion('nonsense')).toThrow('The model did not return keywords');
    expect(() => parseExpansion('{"occasion":"","keywords":[]}')).toThrow(
      'The model did not return keywords',
    );
  });
});

describe('expandRequest', () => {
  const reply = '{"occasion":"Diwali","keywords":["diya","lamp"]}';

  it('uses responseConstraint, returns keywords and destroys the session', async () => {
    const prompt = vi.fn<(input: string, opts?: object) => Promise<string>>(async () => reply);
    const { destroy } = stubModel(prompt);
    const r = await expandRequest('Diwali wishes');
    expect(r.keywords).toEqual(['diwali', 'diya', 'lamp']);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt.mock.calls[0][1]).toHaveProperty('responseConstraint');
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('retries once without responseConstraint when the first call rejects', async () => {
    const prompt = vi
      .fn()
      .mockRejectedValueOnce(new Error('constraint unsupported'))
      .mockResolvedValueOnce(reply);
    const { destroy } = stubModel(prompt);
    const r = await expandRequest('Diwali wishes');
    expect(r.occasion).toBe('diwali');
    expect(prompt).toHaveBeenCalledTimes(2);
    expect(prompt.mock.calls[1][1]).toBeUndefined();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('destroys the session on failure', async () => {
    const prompt = vi.fn().mockRejectedValue(new Error('nope'));
    const { destroy } = stubModel(prompt);
    await expect(expandRequest('x')).rejects.toThrow('nope');
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('destroys the session when the reply is unusable', async () => {
    const prompt = vi.fn(async () => 'nonsense');
    const { destroy } = stubModel(prompt);
    await expect(expandRequest('x')).rejects.toThrow('The model did not return keywords');
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('forwards download progress through onStatus', async () => {
    const prompt = vi.fn(async () => reply);
    const destroy = vi.fn();
    vi.stubGlobal('LanguageModel', {
      availability: vi.fn(async () => 'downloadable'),
      create: vi.fn(async (opts: { monitor?: (m: EventTarget) => void }) => {
        const m = new EventTarget();
        opts.monitor?.(m);
        const e = new Event('downloadprogress') as Event & { loaded: number };
        e.loaded = 0.5;
        m.dispatchEvent(e);
        return { prompt, destroy };
      }),
    });
    const onStatus = vi.fn();
    await expandRequest('x', onStatus);
    expect(onStatus).toHaveBeenCalledWith(expect.stringContaining('50%'));
  });
});
