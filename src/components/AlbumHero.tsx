import { Button, Text, Title } from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { SaveError, workerApiClient } from '../services/api/WorkerApiClient';
import { DEFAULT_FRAMING, frameStyle, type Framing, type Size } from '../services/framing';
import { heroHash, loadHero } from '../services/heroImage';
import { markHeroUnavailable } from '../services/heroStore';
import type { AlbumSummary } from '../types/api';
import { FramingSurface, FramingToolbar } from './HeroFraming';

interface Props {
  name: string;
  photoCount: number;
  coverPhotoId: string;
  coverThumbnailUrl: string;
  /** The saved framing of this cover; null or absent is the centre at 1x. */
  framing?: Framing | null;
  /** The caller owns the album and may reposition the cover. */
  canEdit: boolean;
}

// The blurred stand-in is zoomed a little further than the picture.
const BLUR_SCALE = 1.1;

/** The album cover as a banner with the album name; the blurred thumbnail stands in until (or unless) the hero loads. */
const AlbumHero = ({ name, photoCount, coverPhotoId, coverThumbnailUrl, framing, canEdit }: Props) => {
  const hash = heroHash(coverThumbnailUrl);
  // Once per visit: never refetched or retried while on screen, and dropped on leaving, so the next visit asks
  // again (an unavailable original is retried then) and the image is not held in memory meanwhile.
  const { data: image } = useQuery({
    queryKey: ['album-hero', name, hash],
    queryFn: () => loadHero(name, hash ?? '', coverPhotoId),
    enabled: hash !== null,
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  });
  // An image that will not show is hidden; remembered by blob, so another cover's hero still shows.
  const [failedImage, setFailedImage] = useState<Blob | null>(null);
  // The picture on screen and its own size, once it has loaded.
  const [loaded, setLoaded] = useState<{ image: Blob; natural: Size } | null>(null);
  // The object URL lives exactly as long as the <img> showing this blob.
  const showImage = useCallback(
    (element: HTMLImageElement | null) => {
      if (!element || !image) return;
      const url = URL.createObjectURL(image);
      element.src = url;
      return () => URL.revokeObjectURL(url);
    },
    [image]
  );
  const thumbnail = workerApiClient.thumbnailUrl({ thumbnailUrl: coverThumbnailUrl });
  const visible = image && image !== failedImage ? image : null;
  const natural = visible && loaded?.image === visible ? loaded.natural : null;

  // The framing being edited, for one cover of one album; null outside edit mode.
  const editKey = JSON.stringify([name, hash]);
  const [draft, setDraft] = useState<{ key: string; framing: Framing } | null>(null);
  // Another cover ends the edit without saving, also if the old one comes back.
  if (draft && draft.key !== editKey) setDraft(null);
  const editing = canEdit && natural && draft?.key === editKey ? { natural, framing: draft.framing } : null;
  const current = editing?.framing ?? framing ?? DEFAULT_FRAMING;
  const change = (next: Framing) => setDraft({ key: editKey, framing: next });

  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: (v: { key: string; album: string; hash: string; framing: Framing }) =>
      workerApiClient.setAlbumFraming(v.album, v.hash, v.framing),
    onSuccess: async (_, v) => {
      const queryKey = ['album-summary', v.album];
      // Shown even if the refresh below fails, but only on the cover it was saved for.
      queryClient.setQueryData<AlbumSummary | null>(queryKey, (old) =>
        old && heroHash(old.coverThumbnailUrl) === v.hash ? { ...old, coverFraming: v.framing } : old
      );
      await queryClient.invalidateQueries({ queryKey });
      setDraft((d) => (d?.key === v.key ? null : d));
    },
    onError: (error, v) => {
      // The cover changed elsewhere: the new summary shows it, which ends the edit.
      if (error instanceof SaveError && error.status === 409) {
        void queryClient.invalidateQueries({ queryKey: ['album-summary', v.album] });
      }
    },
  });

  return (
    <div>
      <div className="pdx-hero">
        {/* Keyed by source, so a new cover never shows the old picture while it loads. */}
        <img
          key={thumbnail}
          className="pdx-hero-blur"
          src={thumbnail}
          alt=""
          style={frameStyle({ ...current, zoom: current.zoom * BLUR_SCALE })}
        />
        {visible && (
          <img
            key={hash}
            ref={showImage}
            className="pdx-hero-img"
            alt={`Cover photo of ${name}`}
            style={frameStyle(current)}
            onLoad={(e) => {
              const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
              setLoaded({ image: visible, natural: { w, h } });
            }}
            onError={() => {
              setFailedImage(visible);
              // A stored copy can become unreadable; this visit does without, the next one fetches again.
              if (hash) void markHeroUnavailable(name, hash);
            }}
          />
        )}
        {editing ? (
          <FramingSurface
            framing={editing.framing}
            natural={editing.natural}
            disabled={save.isPending}
            onChange={change}
          />
        ) : (
          <>
            <div className="pdx-hero-text">
              <Title order={2} className="pdx-hero-name">
                {name}
              </Title>
              <Text>
                {photoCount} {photoCount === 1 ? 'photo' : 'photos'}
              </Text>
            </div>
            {canEdit && natural && (
              <Button
                className="pdx-hero-reposition"
                size="xs"
                variant="filled"
                color="dark"
                onClick={() => {
                  save.reset();
                  change(current);
                }}
              >
                Reposition
              </Button>
            )}
          </>
        )}
      </div>
      {editing && hash && (
        <FramingToolbar
          framing={editing.framing}
          saving={save.isPending}
          error={save.error}
          onChange={change}
          onSave={() => save.mutate({ key: editKey, album: name, hash, framing: editing.framing })}
          onCancel={() => setDraft(null)}
        />
      )}
    </div>
  );
};

export default AlbumHero;
