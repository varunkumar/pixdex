import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fitWithin, heroHash, loadHero, resizeToJpeg } from '../heroImage';

const HASH = 'a'.repeat(32);
const HERO_URL = `/api/heroes/${HASH}`;
const MB = 1024 * 1024;

const fetchMock = vi.fn<typeof fetch>();
const createImageBitmapMock = vi.fn();
const drawImage = vi.fn();
const close = vi.fn();
const bitmap = { width: 6000, height: 4000, close };
const context = { drawImage, imageSmoothingQuality: 'low' };

/** Encoded size in bytes for each requested quality. */
let sizeFor: (quality: number) => number;
let encodes: { type: string | undefined; quality: number; width: number; height: number; blob: Blob }[];

beforeEach(() => {
  sizeFor = () => 1000;
  encodes = [];
  context.imageSmoothingQuality = 'low';
  fetchMock.mockReset();
  drawImage.mockReset();
  close.mockReset();
  createImageBitmapMock.mockReset().mockResolvedValue(bitmap);
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('createImageBitmap', createImageBitmapMock);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as never);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
    this: HTMLCanvasElement,
    callback,
    type,
    quality
  ) {
    const blob = new Blob([new Uint8Array(sizeFor(quality as number))], { type });
    encodes.push({ type, quality: quality as number, width: this.width, height: this.height, blob });
    callback(blob);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('heroHash', () => {
  it('returns the part after /thumbnails/', () => {
    expect(heroHash('/thumbnails/abc')).toBe('abc');
  });

  it('returns null when there is no cover thumbnail', () => {
    expect(heroHash(null)).toBeNull();
    expect(heroHash(undefined)).toBeNull();
    expect(heroHash('')).toBeNull();
    expect(heroHash('/something/else')).toBeNull();
  });
});

describe('fitWithin', () => {
  it('scales the long side down to the maximum', () => {
    expect(fitWithin(6000, 4000, 2048)).toEqual({ width: 2048, height: 1365 });
    expect(fitWithin(3000, 6000, 2048)).toEqual({ width: 1024, height: 2048 });
  });

  it('never enlarges', () => {
    expect(fitWithin(800, 600, 2048)).toEqual({ width: 800, height: 600 });
  });
});

describe('resizeToJpeg', () => {
  const original = new Blob(['original']);

  it('applies the EXIF orientation, draws at the fitted size and encodes at 0.85', async () => {
    const out = await resizeToJpeg(original);

    expect(createImageBitmapMock).toHaveBeenCalledWith(original, { imageOrientation: 'from-image' });
    expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 2048, 1365);
    expect(context.imageSmoothingQuality).toBe('high');
    expect(encodes).toHaveLength(1);
    expect(encodes[0]).toMatchObject({ type: 'image/jpeg', quality: 0.85, width: 2048, height: 1365 });
    expect(out).toBe(encodes[0].blob);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('lowers the quality until the image fits in 2 MB', async () => {
    sizeFor = (quality) => (quality > 0.7 ? 2 * MB + 1 : 2 * MB);

    const out = await resizeToJpeg(original);

    expect(encodes.map((e) => e.quality)).toEqual([0.85, 0.75, 0.65]);
    expect(out).toBe(encodes[2].blob);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('throws and closes the bitmap when no quality fits', async () => {
    sizeFor = () => 2 * MB + 1;

    await expect(resizeToJpeg(original)).rejects.toThrow();

    expect(encodes.map((e) => e.quality)).toEqual([0.85, 0.75, 0.65, 0.5]);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('throws and closes the bitmap when there is no 2d context', async () => {
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null);

    await expect(resizeToJpeg(original)).rejects.toThrow();

    expect(close).toHaveBeenCalledTimes(1);
  });

  it('throws when the canvas cannot encode', async () => {
    vi.mocked(HTMLCanvasElement.prototype.toBlob).mockImplementation((callback) => callback(null));

    await expect(resizeToJpeg(original)).rejects.toThrow();

    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe('loadHero', () => {
  const status = (code: number) => new Response('body', { status: code });
  const requests = () => fetchMock.mock.calls.map(([url, init]) => `${init?.method ?? 'GET'} ${String(url)}`);

  it('returns the URL of an existing hero after reading its body', async () => {
    const response = status(200);
    fetchMock.mockResolvedValueOnce(response);

    await expect(loadHero(HASH, 'ph1', true)).resolves.toBe(HERO_URL);

    expect(requests()).toEqual([`GET ${HERO_URL}`]);
    expect(response.bodyUsed).toBe(true);
  });

  it('does not create a missing hero for a viewer', async () => {
    fetchMock.mockResolvedValueOnce(status(404));

    await expect(loadHero(HASH, 'ph1', false)).resolves.toBeNull();

    expect(requests()).toEqual([`GET ${HERO_URL}`]);
  });

  it.each([201, 200])('creates a missing hero for the owner (PUT %i)', async (putStatus) => {
    fetchMock
      .mockResolvedValueOnce(status(404))
      .mockResolvedValueOnce(status(200))
      .mockResolvedValueOnce(status(putStatus));

    await expect(loadHero(HASH, 'ph1', true)).resolves.toBe(HERO_URL);

    expect(requests()).toEqual([`GET ${HERO_URL}`, 'GET /api/originals/ph1', `PUT ${HERO_URL}`]);
    const init = fetchMock.mock.calls[2][1];
    expect(init?.headers).toEqual({ 'Content-Type': 'image/jpeg' });
    expect(init?.body).toBe(encodes[0].blob);
  });

  it('encodes the photo id in the original URL', async () => {
    fetchMock.mockResolvedValueOnce(status(404)).mockResolvedValueOnce(status(502));

    await loadHero(HASH, 'a b', true);

    expect(requests()[1]).toBe('GET /api/originals/a%20b');
  });

  it.each([
    ['the hero GET fails with 500', () => fetchMock.mockResolvedValueOnce(status(500))],
    ['the hero GET rejects', () => fetchMock.mockRejectedValueOnce(new TypeError('offline'))],
    ['the original is unavailable', () => fetchMock.mockResolvedValueOnce(status(404)).mockResolvedValueOnce(status(502))],
    [
      'the original request rejects',
      () => fetchMock.mockResolvedValueOnce(status(404)).mockRejectedValueOnce(new TypeError('offline')),
    ],
    [
      'the browser cannot decode the original',
      () => {
        fetchMock.mockResolvedValueOnce(status(404)).mockResolvedValueOnce(status(200));
        createImageBitmapMock.mockRejectedValueOnce(new Error('unsupported format'));
      },
    ],
    [
      'no size fits',
      () => {
        fetchMock.mockResolvedValueOnce(status(404)).mockResolvedValueOnce(status(200));
        sizeFor = () => 2 * MB + 1;
      },
    ],
  ])('returns null and uploads nothing when %s', async (_name, arrange) => {
    arrange();

    await expect(loadHero(HASH, 'ph1', true)).resolves.toBeNull();

    expect(requests().filter((r) => r.startsWith('PUT'))).toEqual([]);
  });

  it.each([
    ['is refused', () => Promise.resolve(status(403))],
    ['rejects', () => Promise.reject(new TypeError('offline'))],
  ])('returns null when the upload %s', async (_name, upload) => {
    fetchMock.mockResolvedValueOnce(status(404)).mockResolvedValueOnce(status(200)).mockImplementationOnce(upload);

    await expect(loadHero(HASH, 'ph1', true)).resolves.toBeNull();

    expect(requests()).toHaveLength(3);
  });
});
