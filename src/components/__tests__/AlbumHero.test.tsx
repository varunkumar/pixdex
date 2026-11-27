import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState, type ComponentProps, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workerApiClient } from '../../services/api/WorkerApiClient';
import { loadHero } from '../../services/heroImage';
import { theme } from '../../theme';
import AlbumHero from '../AlbumHero';

vi.mock('../../services/heroImage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/heroImage')>()),
  loadHero: vi.fn(),
}));

const HASH = 'a'.repeat(32);
const OTHER = 'b'.repeat(32);
const IMAGE = new Blob(['first'], { type: 'image/jpeg' });
const OTHER_IMAGE = new Blob(['second'], { type: 'image/jpeg' });
const PROPS: ComponentProps<typeof AlbumHero> = {
  name: 'Kanha',
  photoCount: 128,
  coverPhotoId: 'ph1',
  coverThumbnailUrl: `/thumbnails/${HASH}`,
  framing: null,
  canEdit: false,
};

/** One query client for the whole test, so a rerender keeps the cache (like the app). */
function renderHero(props: Partial<ComponentProps<typeof AlbumHero>> = {}, client = new QueryClient()) {
  let current = props;
  let visible = true;
  const tree = () => <Providers client={client}>{visible && <AlbumHero {...PROPS} {...current} />}</Providers>;
  const utils = render(tree());
  return {
    ...utils,
    update: (next: Partial<ComponentProps<typeof AlbumHero>>) => {
      current = next;
      utils.rerender(tree());
    },
    /** Mounts or unmounts the banner alone, keeping the query client (leaving and revisiting the page). */
    show: (on: boolean) => {
      visible = on;
      utils.rerender(tree());
    },
  };
}

function Providers({ client, children }: { client: QueryClient; children: ReactNode }) {
  const [queryClient] = useState(client);
  return (
    <QueryClientProvider client={queryClient}>
      <MantineProvider theme={theme} env="test">
        {children}
      </MantineProvider>
    </QueryClientProvider>
  );
}

const blurred = (container: HTMLElement) => container.querySelector('img.pdx-hero-blur');
const sharp = () => screen.queryByRole('img', { name: 'Cover photo of Kanha' });
const findSharp = () => screen.findByRole('img', { name: 'Cover photo of Kanha' });

const createObjectURL = vi.fn<(blob: Blob) => string>();
const revokeObjectURL = vi.fn<(url: string) => void>();
const { createObjectURL: realCreate, revokeObjectURL: realRevoke } = URL;

beforeEach(() => {
  vi.mocked(loadHero).mockReset().mockReturnValue(new Promise(() => {}));
  let made = 0;
  createObjectURL.mockReset().mockImplementation(() => `blob:hero-${++made}`);
  revokeObjectURL.mockReset();
  // jsdom has no object URLs.
  Object.assign(URL, { createObjectURL, revokeObjectURL });
});

afterEach(() => {
  Object.assign(URL, { createObjectURL: realCreate, revokeObjectURL: realRevoke });
});

/** The URLs made and not yet revoked. */
const liveUrls = () => {
  const revoked = new Set(revokeObjectURL.mock.calls.map(([url]) => url));
  return createObjectURL.mock.results.map((r) => r.value as string).filter((url) => !revoked.has(url));
};

describe('AlbumHero', () => {
  it('shows the blurred thumbnail, the name and the count while the hero loads', () => {
    const { container } = renderHero();
    expect(blurred(container)).toHaveAttribute('src', `/api/thumbnails/${HASH}`);
    expect(screen.getByRole('heading', { name: 'Kanha' })).toBeInTheDocument();
    expect(screen.getByText('128 photos')).toBeInTheDocument();
    expect(sharp()).not.toBeInTheDocument();
  });

  it('says 1 photo for one', () => {
    renderHero({ photoCount: 1 });
    expect(screen.getByText('1 photo')).toBeInTheDocument();
  });

  it('shows the image through an object URL once it resolves', async () => {
    vi.mocked(loadHero).mockResolvedValue(IMAGE);
    renderHero();
    expect(await findSharp()).toHaveAttribute('src', 'blob:hero-1');
    expect(createObjectURL).toHaveBeenCalledWith(IMAGE);
    expect(liveUrls()).toEqual(['blob:hero-1']);
  });

  it('revokes the object URL when it unmounts', async () => {
    vi.mocked(loadHero).mockResolvedValue(IMAGE);
    const { unmount } = renderHero();
    await findSharp();
    unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:hero-1');
    expect(liveUrls()).toEqual([]);
  });

  it('keeps the blurred thumbnail, with no error text, when there is no hero', async () => {
    vi.mocked(loadHero).mockResolvedValue(null);
    const { container } = renderHero();
    await waitFor(() => expect(loadHero).toHaveBeenCalled());
    await expect(vi.mocked(loadHero).mock.results[0].value).resolves.toBeNull();
    expect(sharp()).not.toBeInTheDocument();
    expect(blurred(container)).toBeInTheDocument();
    expect(screen.queryByText(/error|could not|failed/i)).not.toBeInTheDocument();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('asks for the hero once while it stays on screen', async () => {
    vi.mocked(loadHero).mockResolvedValue(null);
    const { update } = renderHero();
    await waitFor(() => expect(loadHero).toHaveBeenCalledWith('Kanha', HASH, 'ph1'));
    update({ photoCount: 129 });
    expect(await screen.findByText('129 photos')).toBeInTheDocument();
    expect(loadHero).toHaveBeenCalledTimes(1);
  });

  it('asks again on the next visit, with the same query client', async () => {
    vi.mocked(loadHero).mockResolvedValueOnce(null).mockResolvedValue(IMAGE);
    const { show } = renderHero();
    await waitFor(() => expect(loadHero).toHaveBeenCalledTimes(1));
    await expect(vi.mocked(loadHero).mock.results[0].value).resolves.toBeNull();
    show(false);
    // Leaving the page and coming back are separate tasks; the unused query is dropped in between.
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 10)));
    show(true);
    expect(await findSharp()).toBeInTheDocument();
    expect(loadHero).toHaveBeenCalledTimes(2);
  });

  it('never shows the old hero after the cover changes, revokes it and loads the new one', async () => {
    vi.mocked(loadHero).mockImplementation((_album, hash) =>
      hash === HASH ? Promise.resolve(IMAGE) : new Promise(() => {})
    );
    const { container, update } = renderHero();
    await findSharp();
    update({ coverPhotoId: 'ph2', coverThumbnailUrl: `/thumbnails/${OTHER}` });
    expect(sharp()).not.toBeInTheDocument();
    expect(liveUrls()).toEqual([]);
    expect(blurred(container)).toHaveAttribute('src', `/api/thumbnails/${OTHER}`);
    await waitFor(() => expect(loadHero).toHaveBeenLastCalledWith('Kanha', OTHER, 'ph2'));
  });

  it('hides a hero that fails to load, leaving the blurred thumbnail', async () => {
    vi.mocked(loadHero).mockResolvedValue(IMAGE);
    const { container, update } = renderHero();
    fireEvent.error(await findSharp());
    expect(container.querySelector('img.pdx-hero-img')).not.toBeInTheDocument();
    expect(blurred(container)).toBeInTheDocument();
    expect(liveUrls()).toEqual([]);
    update({ photoCount: 129 });
    expect(await screen.findByText('129 photos')).toBeInTheDocument();
    expect(sharp()).not.toBeInTheDocument();
  });

  it("shows a new cover's hero after an earlier one failed to load", async () => {
    vi.mocked(loadHero).mockImplementation((_album, hash) => Promise.resolve(hash === HASH ? IMAGE : OTHER_IMAGE));
    const { update } = renderHero();
    fireEvent.error(await findSharp());
    update({ coverPhotoId: 'ph2', coverThumbnailUrl: `/thumbnails/${OTHER}` });
    expect(await findSharp()).toHaveAttribute('src', 'blob:hero-2');
    expect(createObjectURL).toHaveBeenLastCalledWith(OTHER_IMAGE);
  });
});

describe('AlbumHero reposition', () => {
  const SAVED = { x: 20, y: 70, zoom: 1.5 };
  // A 3000x2000 cover in a 1200x300 banner: 500px of vertical overflow at 1x, 1200px sideways at 2x.
  const NATURAL = { w: 3000, h: 2000 };
  const save = vi.spyOn(workerApiClient, 'setAlbumFraming');

  beforeEach(() => {
    save.mockReset().mockResolvedValue();
    vi.mocked(loadHero).mockResolvedValue(IMAGE);
  });

  const button = (name: string) => screen.queryByRole('button', { name });
  const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
  const surface = () => screen.getByRole('application', { name: /reposition cover photo/i });
  const editing = () => screen.queryByRole('application') !== null;
  const slider = () => screen.getByRole('slider', { name: 'Zoom' });

  /** The image reports its size and loads (jsdom does neither). */
  function load(img: HTMLElement) {
    Object.defineProperties(img, {
      naturalWidth: { configurable: true, value: NATURAL.w },
      naturalHeight: { configurable: true, value: NATURAL.h },
    });
    fireEvent.load(img);
  }

  /** What the sharp image shows, as framing numbers. */
  function shown() {
    const { objectPosition, transform } = sharp()!.style;
    const [x, y] = objectPosition.split(' ').map((v) => parseFloat(v));
    return { x, y, zoom: Number(/scale\((.+)\)/.exec(transform)![1]) };
  }

  async function startEditing(props: Partial<ComponentProps<typeof AlbumHero>> = {}, client?: QueryClient) {
    const utils = renderHero({ canEdit: true, ...props }, client);
    load(await findSharp());
    click('Reposition');
    vi.spyOn(surface(), 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1200, 300));
    return utils;
  }

  const pointer = (type: 'pointerDown' | 'pointerMove' | 'pointerUp' | 'pointerCancel', pointerId: number, x = 0, y = 0) =>
    fireEvent[type](surface(), { pointerId, pointerType: 'touch', button: 0, clientX: x, clientY: y });

  it('styles the sharp image with the saved framing and positions the blurred one', async () => {
    const { container } = renderHero({ framing: SAVED });
    const img = await findSharp();
    expect(img.style.objectPosition).toBe('20% 70%');
    expect(img.style.transformOrigin).toBe('20% 70%');
    expect(img.style.transform).toBe('scale(1.5)');
    const blur = blurred(container) as HTMLElement;
    expect(blur.style.objectPosition).toBe('20% 70%');
    expect(blur.style.transformOrigin).toBe('20% 70%');
    expect(Number(/scale\((.+)\)/.exec(blur.style.transform)![1])).toBeCloseTo(1.65);
  });

  it('shows the centre at 1x without a saved framing', async () => {
    renderHero();
    await findSharp();
    expect(shown()).toEqual({ x: 50, y: 50, zoom: 1 });
  });

  it('offers Reposition only to the owner, once the sharp image shows', async () => {
    const { update } = renderHero({ canEdit: true });
    const img = await findSharp();
    expect(button('Reposition')).not.toBeInTheDocument();
    load(img);
    expect(button('Reposition')).toBeInTheDocument();
    update({ canEdit: false });
    expect(button('Reposition')).not.toBeInTheDocument();
  });

  it('offers no Reposition over the blurred thumbnail alone', async () => {
    vi.mocked(loadHero).mockResolvedValue(null);
    renderHero({ canEdit: true });
    await waitFor(() => expect(loadHero).toHaveBeenCalled());
    await expect(vi.mocked(loadHero).mock.results[0].value).resolves.toBeNull();
    expect(button('Reposition')).not.toBeInTheDocument();
  });

  it('hides the title and shows the controls in edit mode', async () => {
    await startEditing();
    expect(screen.queryByRole('heading', { name: 'Kanha' })).not.toBeInTheDocument();
    expect(screen.queryByText('128 photos')).not.toBeInTheDocument();
    expect(button('Reposition')).not.toBeInTheDocument();
    for (const name of ['Save', 'Cancel', 'Reset']) expect(button(name)).toBeInTheDocument();
    expect(slider()).toHaveAttribute('aria-valuemin', '1');
    expect(slider()).toHaveAttribute('aria-valuemax', '3');
    expect(surface()).toHaveFocus();
  });

  it('moves with the arrow keys, 1% or 10% with Shift, within 0 to 100', async () => {
    await startEditing();
    expect(fireEvent.keyDown(surface(), { key: 'ArrowRight' })).toBe(false);
    expect(shown()).toEqual({ x: 51, y: 50, zoom: 1 });
    fireEvent.keyDown(surface(), { key: 'ArrowDown', shiftKey: true });
    expect(shown()).toEqual({ x: 51, y: 60, zoom: 1 });
    fireEvent.keyDown(surface(), { key: 'ArrowLeft' });
    fireEvent.keyDown(surface(), { key: 'ArrowUp' });
    expect(shown()).toEqual({ x: 50, y: 59, zoom: 1 });
    for (let i = 0; i < 12; i++) fireEvent.keyDown(surface(), { key: 'ArrowUp', shiftKey: true });
    expect(shown().y).toBe(0);
  });

  it('zooms with + and -, never past 1 to 3', async () => {
    await startEditing();
    fireEvent.keyDown(surface(), { key: '-' });
    expect(shown().zoom).toBe(1);
    fireEvent.keyDown(surface(), { key: '+' });
    expect(shown().zoom).toBe(1.1);
    fireEvent.keyDown(surface(), { key: '+' });
    expect(shown().zoom).toBe(1.2);
    expect(slider()).toHaveAttribute('aria-valuenow', '1.2');
    expect(slider()).toHaveAttribute('aria-valuetext', '1.20x');
    for (let i = 0; i < 30; i++) fireEvent.keyDown(surface(), { key: '+' });
    expect(shown().zoom).toBe(3);
    fireEvent.keyDown(surface(), { key: '-' });
    expect(shown().zoom).toBe(2.9);
  });

  it('leaves browser shortcuts alone', async () => {
    await startEditing();
    expect(fireEvent.keyDown(surface(), { key: '+', metaKey: true })).toBe(true);
    expect(fireEvent.keyDown(surface(), { key: '-', ctrlKey: true })).toBe(true);
    expect(fireEvent.keyDown(surface(), { key: 'ArrowLeft', altKey: true })).toBe(true);
    expect(shown()).toEqual({ x: 50, y: 50, zoom: 1 });
  });

  it('zooms with the slider in steps of 0.05', async () => {
    await startEditing();
    fireEvent.keyDown(slider(), { key: 'ArrowRight' });
    expect(shown()).toEqual({ x: 50, y: 50, zoom: 1.05 });
  });

  it('resets to the centre at 1x', async () => {
    await startEditing({ framing: SAVED });
    expect(shown()).toEqual(SAVED);
    click('Reset');
    expect(shown()).toEqual({ x: 50, y: 50, zoom: 1 });
    expect(editing()).toBe(true);
    expect(save).not.toHaveBeenCalled();
  });

  it('restores the saved framing on Cancel', async () => {
    await startEditing({ framing: SAVED });
    fireEvent.keyDown(surface(), { key: 'ArrowRight' });
    click('Cancel');
    expect(editing()).toBe(false);
    expect(shown()).toEqual(SAVED);
    expect(screen.getByRole('heading', { name: 'Kanha' })).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
    click('Reposition');
    expect(shown()).toEqual(SAVED);
  });

  it('saves the framing and leaves edit mode after the summary refreshes', async () => {
    const client = new QueryClient();
    let refreshed = () => {};
    const invalidate = vi
      .spyOn(client, 'invalidateQueries')
      .mockReturnValue(new Promise<void>((resolve) => (refreshed = resolve)));
    const { update } = await startEditing({ framing: SAVED }, client);
    fireEvent.keyDown(surface(), { key: 'ArrowRight' });
    click('Save');
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['album-summary', 'Kanha'] }));
    expect(save).toHaveBeenCalledWith('Kanha', HASH, { x: 21, y: 70, zoom: 1.5 });
    expect(editing()).toBe(true);
    update({ canEdit: true, framing: { x: 21, y: 70, zoom: 1.5 } });
    await act(async () => refreshed());
    await waitFor(() => expect(editing()).toBe(false));
    expect(shown()).toEqual({ x: 21, y: 70, zoom: 1.5 });
  });

  it('puts the saved framing in the cached summary, in case the refresh fails', async () => {
    const client = new QueryClient();
    client.setQueryData(['album-summary', 'Kanha'], { name: 'Kanha', coverFraming: null });
    await startEditing({}, client);
    fireEvent.keyDown(surface(), { key: 'ArrowRight' });
    click('Save');
    await waitFor(() => expect(editing()).toBe(false));
    expect(client.getQueryData(['album-summary', 'Kanha'])).toEqual({
      name: 'Kanha',
      coverFraming: { x: 51, y: 50, zoom: 1 },
    });
  });

  it('ignores changes while saving', async () => {
    save.mockReturnValue(new Promise(() => {}));
    await startEditing();
    click('Save');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled());
    expect(screen.getByRole('button', { name: 'Reset' })).toBeDisabled();
    fireEvent.keyDown(surface(), { key: 'ArrowRight' });
    pointer('pointerDown', 1, 500, 100);
    pointer('pointerMove', 1, 500, 150);
    expect(shown()).toEqual({ x: 50, y: 50, zoom: 1 });
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('stays in edit mode with the error text when saving fails, and forgets it afterwards', async () => {
    save.mockRejectedValue(new Error('Could not save: 409'));
    await startEditing();
    fireEvent.keyDown(surface(), { key: 'ArrowRight' });
    click('Save');
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save: 409');
    expect(editing()).toBe(true);
    expect(shown().x).toBe(51);
    click('Cancel');
    click('Reposition');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('closes edit mode without saving when the cover changes, also if it changes back', async () => {
    const { update } = await startEditing();
    fireEvent.keyDown(surface(), { key: 'ArrowRight' });
    update({ canEdit: true, coverPhotoId: 'ph2', coverThumbnailUrl: `/thumbnails/${OTHER}` });
    expect(editing()).toBe(false);
    load(await findSharp());
    expect(editing()).toBe(false);
    expect(shown()).toEqual({ x: 50, y: 50, zoom: 1 });
    update({ canEdit: true });
    load(await findSharp());
    expect(editing()).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });

  it('moves by dragging with one pointer', async () => {
    await startEditing();
    pointer('pointerDown', 1, 500, 100);
    pointer('pointerMove', 1, 500, 125);
    pointer('pointerMove', 1, 500, 150);
    expect(shown()).toEqual({ x: 50, y: 40, zoom: 1 });
    pointer('pointerUp', 1, 500, 150);
    pointer('pointerMove', 1, 500, 250);
    expect(shown()).toEqual({ x: 50, y: 40, zoom: 1 });
    pointer('pointerDown', 1, 100, 100);
    pointer('pointerMove', 1, 100, 50);
    expect(shown()).toEqual({ x: 50, y: 50, zoom: 1 });
  });

  it('ignores other mouse buttons', async () => {
    await startEditing();
    fireEvent.pointerDown(surface(), { pointerId: 1, pointerType: 'mouse', button: 2, clientX: 500, clientY: 100 });
    pointer('pointerMove', 1, 500, 150);
    expect(shown()).toEqual({ x: 50, y: 50, zoom: 1 });
  });

  it('pinches to zoom with two pointers, and lifting one does not jump', async () => {
    await startEditing();
    pointer('pointerDown', 1, 500, 150);
    pointer('pointerDown', 2, 700, 150);
    // The fingers move apart evenly: twice the distance, the same midpoint.
    pointer('pointerMove', 1, 400, 150);
    pointer('pointerMove', 2, 800, 150);
    expect(shown().zoom).toBe(2);
    const pinched = shown();
    pointer('pointerUp', 2, 800, 150);
    expect(shown()).toEqual(pinched);
    pointer('pointerMove', 1, 400, 150);
    expect(shown()).toEqual(pinched);
    // The finger left behind drags from where it is: 120px of 1200px overflow.
    pointer('pointerMove', 1, 280, 150);
    expect(shown().zoom).toBe(2);
    expect(shown().x).toBeCloseTo(pinched.x + 10);
    expect(shown().y).toBe(pinched.y);
  });

  it('keeps pinch zoom within 1 to 3 and forgets a cancelled pointer', async () => {
    await startEditing();
    pointer('pointerDown', 1, 500, 150);
    pointer('pointerDown', 2, 510, 150);
    pointer('pointerMove', 2, 900, 150);
    expect(shown().zoom).toBe(3);
    pointer('pointerMove', 2, 501, 150);
    expect(shown().zoom).toBe(1);
    pointer('pointerCancel', 2);
    pointer('pointerCancel', 1);
    pointer('pointerMove', 1, 100, 10);
    expect(shown().zoom).toBe(1);
  });
});
