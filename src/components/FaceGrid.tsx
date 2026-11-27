import type { ReactNode } from 'react';
import { TbSparkles } from 'react-icons/tb';
import { Link } from 'react-router-dom';
import { workerApiClient } from '../services/api/WorkerApiClient';
import { formatPhotoDate } from '../services/exif';
import type { FaceItem } from '../services/faces';
import { photoCaption } from '../services/text';
import type { SerializedFace } from '../types/api';

/** CSS percentage that puts a box starting at `start` and `length` long (both 0 to 1) in view. */
const position = (start: number, length: number) =>
  length < 1 ? Math.round((start / (1 - length)) * 100_000) / 1000 : 0;
const scale = (length: number) => (length > 0 ? Math.round(100_000 / length) / 1000 : 100);

/** The sharp crop when the face has one, else the face cut out of the photo thumbnail by its bbox, at any tile size. */
const FacePicture = ({ face, label }: { face: SerializedFace; label: string }) => {
  if (face.cropUrl)
    return (
      <img
        src={workerApiClient.thumbnailUrl({ thumbnailUrl: face.cropUrl })}
        alt={label}
        loading="lazy"
        className="pdx-tile-img"
      />
    );
  const { x, y, w, h } = face.bbox;
  return (
    <div
      className="pdx-face-cut"
      data-testid="face-cut"
      style={{
        backgroundImage: `url("${workerApiClient.thumbnailUrl(face)}")`,
        backgroundSize: `${scale(w)}% ${scale(h)}%`,
        backgroundPosition: `${position(x, w)}% ${position(y, h)}%`,
      }}
    />
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

/** Square face tiles with the photo tile's overlay, caption line and control places (see `PhotoTile`). */
const FaceGrid = ({ items, badges, mark, actions }: FaceGridProps) => (
  <div className="pdx-faces">
    {items.map((item) => {
      const { face, photo, label } = item;
      const date = formatPhotoDate(photo.dateTime);
      const marker = mark?.(item);
      const badge = badges?.(item);
      const controls = actions?.(item);
      return (
        <div className="pdx-tile-item" key={face.id}>
          <div className="pdx-tile pdx-face">
            <Link to={`/photos/${photo.id}`} className="pdx-tile-link" aria-label={date ? `${label}, ${date}` : label}>
              <FacePicture face={face} label={label} />
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
            <span>{photoCaption(photo)}</span>
            {date && (
              <>
                {' · '}
                <span>{date}</span>
              </>
            )}
          </div>
        </div>
      );
    })}
  </div>
);

export default FaceGrid;
