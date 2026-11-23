import type { ReactNode } from 'react';
import { usePhotoColumns } from '../hooks/usePhoneColumns';
import type { SerializedPhoto } from '../types/api';
import MasonryGrid from './MasonryGrid';
import { photoRatio } from './masonry';
import PhotoTile from './PhotoTile';

interface PhotoGridProps {
  photos: SerializedPhoto[];
  /** Always-visible status badges per photo (top left corner). */
  badges?: (photo: SerializedPhoto) => ReactNode;
  /** Owner controls per photo, drawn in the tile's top right corner. */
  actions?: (photo: SerializedPhoto) => ReactNode;
  /** Extra one-line explanation per photo (AI results). */
  note?: (photo: SerializedPhoto) => string | undefined;
  /** Show each photo's album name (Search). */
  showAlbum?: boolean;
}

const PhotoGrid = ({ photos, badges, actions, note, showAlbum }: PhotoGridProps) => {
  const columns = usePhotoColumns();
  return (
    <MasonryGrid
      items={photos}
      ratioOf={photoRatio}
      keyOf={(photo) => photo.id}
      columns={columns}
      renderItem={(photo) => (
        <PhotoTile
          photo={photo}
          badges={badges?.(photo)}
          actions={actions?.(photo)}
          note={note?.(photo)}
          showAlbum={showAlbum}
        />
      )}
    />
  );
};

export default PhotoGrid;
