import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { workerApiClient } from '../services/api/WorkerApiClient';
import { formatPhotoDate } from '../services/exif';
import { photoCaption } from '../services/text';
import type { SerializedPhoto } from '../types/api';
import { photoRatio } from './masonry';

const MAX_TILE_TAGS = 3;

interface PhotoTileProps {
  photo: SerializedPhoto;
  /** Always-visible status badges (Cover, Auto), drawn in the top left corner. */
  badges?: ReactNode;
  /** Owner controls, drawn in the top right corner (outside the link). */
  actions?: ReactNode;
  /** The shape to lay the tile out in; defaults to the photo's stored size. */
  ratio?: number;
  /** Called with the thumbnail's real size once it has loaded. */
  onThumbnailSize?: (width: number, height: number) => void;
  /** Extra one-line explanation (AI results), shown in the overlay and replacing the caption line tail. */
  note?: string;
  /** Search results span albums: show the album name (chip in the overlay, tail of the caption line). */
  showAlbum?: boolean;
}

/**
 * Image-first tile. Hover-capable devices get an overlay (caption, date, tags); touch devices get one caption line
 * under the image. Both are always in the DOM, CSS (`@media (hover: ...)`) picks which one is visible.
 */
const PhotoTile = ({ photo, badges, actions, ratio, onThumbnailSize, note, showAlbum = false }: PhotoTileProps) => {
  const caption = photoCaption(photo);
  const date = formatPhotoDate(photo.dateTime);
  const album = showAlbum ? photo.album : null;
  const tail = note ?? album ?? date;
  const tags = photo.tags.slice(0, MAX_TILE_TAGS);

  return (
    <div className="pdx-tile-item">
      <div className="pdx-tile" style={{ aspectRatio: ratio ?? photoRatio(photo) }}>
        <Link to={`/photos/${photo.id}`} className="pdx-tile-link" aria-label={date ? `${caption}, ${date}` : caption}>
          <img
            src={workerApiClient.thumbnailUrl(photo)}
            alt={caption}
            loading="lazy"
            className="pdx-tile-img"
            onLoad={(e) => onThumbnailSize?.(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)}
          />
        </Link>
        <div className="pdx-tile-overlay">
          {album && <span className="pdx-tile-album">{album}</span>}
          <b>{caption}</b>
          {date && <span>{date}</span>}
          {tags.length > 0 && <span className="pdx-tile-tags">{tags.map((t) => `#${t}`).join(' ')}</span>}
          {note && <span>{note}</span>}
        </div>
        {badges && <div className="pdx-tile-badges">{badges}</div>}
        {actions && <div className="pdx-tile-actions">{actions}</div>}
      </div>
      <div className="pdx-tile-cap">
        <span>{caption}</span>
        {tail && (
          <>
            {' · '}
            <span>{tail}</span>
          </>
        )}
      </div>
    </div>
  );
};

export default PhotoTile;
