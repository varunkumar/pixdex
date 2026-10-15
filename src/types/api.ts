export interface SerializedPhoto {
  id: string;
  contentHash?: string;
  source?: string;
  path: string | null;
  driveFileId: string | null;
  filename?: string;
  dateTime: string | null;
  width: number | null;
  height: number | null;
  format: string | null;
  fileSize: number | null;
  subjects: string[];
  colors: string[];
  patterns: string[];
  tags: string[];
  season: string | null;
  environment: string | null;
  album: string | null;
  description?: string;
  suggestedCaption?: string;
  suggestedHashtags: string[];
  modelProvider?: string;
  modelName?: string;
  lastIndexed?: string;
  instagramSuggested: string | null;
  thumbnailUrl?: string;
  cameraMake?: string | null;
  cameraModel?: string | null;
  lensModel?: string | null;
  focalLength?: number | null;
  fNumber?: number | null;
  exposureTime?: number | null;
  iso?: number | null;
  latitude?: number | null;
  longitude?: number | null;
  /** null/undefined when unknown (indexed before watermark detection existed). */
  hasWatermark?: boolean | null;
  /** 1-10 vision-model rating of how good the photo looks; null/undefined when not rated. */
  aestheticScore?: number | null;
  /** 3-4 word title; null/undefined when not generated yet. */
  shortCaption?: string | null;
}

export interface SearchResponse {
  results: SerializedPhoto[];
  /** Total rows matching the query and album filter, ignoring limit/offset. */
  total: number;
}

export interface AlbumSummary {
  name: string;
  photoCount: number;
  coverPhotoId: string;
  coverThumbnailUrl: string | null;
  /** Capture date of the cover (newest) photo; null when the photo has no date. */
  latestDate: string | null;
}

export interface AlbumsPageResponse {
  albums: AlbumSummary[];
  /** Total number of albums, ignoring limit/offset. */
  total: number;
}

export interface AlbumsResponse {
  albums: string[];
}

export interface DailyPickResponse {
  photo: SerializedPhoto;
  reason: string;
  suggestedCaption: string;
  suggestedHashtags: string[];
}
