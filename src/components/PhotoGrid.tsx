import { useCallback, type ReactNode } from 'react';
import { usePhotoColumns } from '../hooks/usePhoneColumns';
import { useThumbRatios } from '../hooks/useThumbRatios';
import type { SerializedPhoto } from '../types/api';
import MasonryGrid from './MasonryGrid';
import { photoRatio } from './masonry';
import PhotoTile from './PhotoTile';

interface PhotoGridProps {
  photos: SerializedPhoto[];
  /** Always-visible status badges per photo (top left corner). */
  badges?: (photo: SerializedPhoto) => ReactNode;
  /** A small marker per photo, drawn before the title (person page: matched automatically). */
  mark?: (photo: SerializedPhoto) => ReactNode;
  /** Owner controls per photo, drawn in the tile's top right corner. */
  actions?: (photo: SerializedPhoto) => ReactNode;
  /** Extra one-line explanation per photo (AI results). */
  note?: (photo: SerializedPhoto) => string | undefined;
  /** Show each photo's album name (Search). */
  showAlbum?: boolean;
}

const PhotoGrid = ({ photos, badges, mark, actions, note, showAlbum }: PhotoGridProps) => {
  const columns = usePhotoColumns();
  const { ratios, report } = useThumbRatios();
  const shapeOf = useCallback((photo: SerializedPhoto) => ratios[photo.id] ?? photoRatio(photo), [ratios]);
  // A real thumbnail that is portrait while the stored size says landscape (or the reverse) is the raw-frame mix-up:
  // trust the thumbnail. Near-square photos are skipped, their orientation is a coin toss.
  const learnShape = (photo: SerializedPhoto) => (width: number, height: number) => {
    if (!width || !height) return;
    const actual = width / height;
    const stored = photoRatio(photo);
    if (Math.abs(actual - 1) < 0.05 || Math.abs(stored - 1) < 0.05) return;
    if (actual > 1 !== stored > 1) report(photo.id, photoRatio({ width, height }));
  };
  return (
    <MasonryGrid
      items={photos}
      ratioOf={shapeOf}
      keyOf={(photo) => photo.id}
      columns={columns}
      renderItem={(photo) => (
        <PhotoTile
          photo={photo}
          ratio={shapeOf(photo)}
          onThumbnailSize={learnShape(photo)}
          badges={badges?.(photo)}
          mark={mark?.(photo)}
          actions={actions?.(photo)}
          note={note?.(photo)}
          showAlbum={showAlbum}
        />
      )}
    />
  );
};

export default PhotoGrid;
