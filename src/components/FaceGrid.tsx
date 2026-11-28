import type { ReactNode } from 'react';
import { TbSparkles } from 'react-icons/tb';
import { Link } from 'react-router-dom';
import { workerApiClient } from '../services/api/WorkerApiClient';
import { formatPhotoDate } from '../services/exif';
import type { FaceItem } from '../services/faces';
import { photoCaption } from '../services/text';
import type { SerializedFace } from '../types/api';

/** A percentage of the tile, rounded to three places. */
const percent = (value: number) => Math.round(value * 100_000) / 1000;

/** About the first rows of a page: these load at once, the others lazily. */
const EAGER_FACES = 8;

/** The sharp crop when the face has one, else the photo thumbnail enlarged and moved so the bbox fills the tile. */
const FacePicture = ({ face, label, eager }: { face: SerializedFace; label: string; eager: boolean }) => {
  const loading = eager ? 'eager' : 'lazy';
  if (face.cropUrl)
    return (
      <img
        src={workerApiClient.thumbnailUrl({ thumbnailUrl: face.cropUrl })}
        alt={label}
        loading={loading}
        className="pdx-tile-img"
      />
    );
  const { x, y, w, h } = face.bbox;
  const width = w > 0 ? 1 / w : 1;
  const height = h > 0 ? 1 / h : 1;
  return (
    <div className="pdx-face-cut" data-testid="face-cut">
      <img
        src={workerApiClient.thumbnailUrl(face)}
        alt={label}
        loading={loading}
        style={{
          width: `${percent(width)}%`,
          height: `${percent(height)}%`,
          left: `${percent(-x * width)}%`,
          top: `${percent(-y * height)}%`,
        }}
      />
    </div>
  );
};

interface FaceGridProps {
  items: FaceItem[];
  /** Always-visible status badges per face (top left corner). */
  badges?: (item: FaceItem) => ReactNode;
  /** A small marker per face, drawn before the title. */
  mark?: (item: FaceItem) => ReactNode;
  /** Owner controls per face, drawn in the tile's top right corner. */
  actions?: (item: FaceItem) => ReactNode;
}

/** Small square face tiles, sized like the "Review auto matches" grid, with the photo tile's overlay, caption line and control places (see `PhotoTile`). */
const FaceGrid = ({ items, badges, mark, actions }: FaceGridProps) => (
  <div className="pdx-faces-wrap">
    {/* Safari drops the list meaning of a list that is a grid, so the role is explicit. */}
    <ul className="pdx-faces" role="list">
    {items.map((item, index) => {
      const { face, photo, label } = item;
      const date = formatPhotoDate(photo.dateTime);
      const marker = mark?.(item);
      const badge = badges?.(item);
      const controls = actions?.(item);
      return (
        <li className="pdx-tile-item" key={face.id}>
          <div className="pdx-tile pdx-face">
            <Link to={`/photos/${photo.id}`} className="pdx-tile-link" aria-label={date ? `${label}, ${date}` : label}>
              <FacePicture face={face} label={label} eager={index < EAGER_FACES} />
            </Link>
            <div className="pdx-tile-overlay">
              <div className="pdx-tile-info">
                <div className="pdx-tile-line">
                  {marker}
                  <b>{photoCaption(photo)}</b>
                  {date && <span className="pdx-tile-date">{date}</span>}
                </div>
              </div>
            </div>
            {badge && <div className="pdx-tile-badges">{badge}</div>}
            {controls && <div className="pdx-tile-actions">{controls}</div>}
          </div>
          <div className="pdx-tile-cap">
            {marker && <TbSparkles size={11} aria-hidden className="pdx-tile-cap-mark" />}
            {/* A small tile has room for one short thing; the caption is in the link's name. */}
            <span>{date || photoCaption(photo)}</span>
          </div>
        </li>
      );
    })}
    </ul>
  </div>
);

export default FaceGrid;
