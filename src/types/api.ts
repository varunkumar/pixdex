import type { Framing } from '../services/framing';

export interface SerializedPhoto {
  id: string;
  /** True when the current user may edit this photo (owns its album). */
  canEdit: boolean;
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
  /** Animals the species model found (common and scientific name, confidence 0..1); empty or absent when none or not scanned. */
  species?: { common: string; scientific: string; score: number; box?: [number, number, number, number] }[];
  /** Owner's 1-5 star rating; null/undefined when not rated by hand. */
  userRating?: number | null;
  /** 1-10 blend of the owner's rating and the model's score. */
  combinedScore?: number | null;
  /** Owner edits. subjects/tags/shortCaption above are already the effective values. */
  overrides?: { shortCaption: string | null; subjects: string[] | null; tags: string[] | null };
}

/** Partial update: omit a field to keep it, send null to clear it (back to the AI value). */
export interface PhotoReviewPatch {
  userRating?: number | null;
  caption?: string | null;
  subjects?: string[] | null;
  tags?: string[] | null;
}

export interface SearchResponse {
  results: SerializedPhoto[];
  /** Total rows matching the query and album filter, ignoring limit/offset. */
  total: number;
}

export type TimelineZoom = 'year' | 'month' | 'day';

export interface TimelineGroup {
  /** `YYYY-MM` at year/month zoom, `YYYY-MM-DD` or `undated` at day zoom. */
  key: string;
  total: number;
  shown: number;
  photos: SerializedPhoto[];
}

export interface TimelineResponse {
  groups: TimelineGroup[];
  nextCursor: string | null;
}

export interface TimelineBucketsResponse {
  buckets: { month: string; total: number }[];
  undated: number;
}

export interface AlbumSummary {
  name: string;
  photoCount: number;
  coverPhotoId: string;
  coverThumbnailUrl: string | null;
  /** How the owner placed the current cover in the album banner; null or absent is the centre at 1x. */
  coverFraming?: Framing | null;
  /** Capture date of the cover (newest) photo; null when the photo has no date. */
  latestDate: string | null;
  role: 'owner' | 'viewer';
  /** Lowercase emails the album is shared with; present only when role is 'owner'. */
  sharedWith?: string[];
  /** The owner's email; present only when role is 'viewer' (never the other sharees). */
  ownerEmail?: string | null;
}

export interface AlbumsPageResponse {
  albums: AlbumSummary[];
  /** Total number of albums, ignoring limit/offset. */
  total: number;
}

export interface MeResponse {
  email: string;
  admin: boolean;
}

export interface AccessRequest {
  id: number;
  email: string;
  note: string | null;
  status: 'pending' | 'approved' | 'denied' | 'revoked';
  createdAt: string;
  decidedAt: string | null;
}

export interface AccessRequestsResponse {
  requests: AccessRequest[];
  pendingCount: number;
  queueFull: boolean;
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

export interface SerializedFace {
  id: string;
  photoId: string;
  thumbnailUrl: string;
  /** Sharp crop of the face cut from the original; absent for faces scanned before crops existed. */
  cropUrl?: string | null;
  bbox: { x: number; y: number; w: number; h: number };
  detScore: number;
  personId: string | null;
  personName: string | null;
  status: 'unassigned' | 'auto' | 'confirmed';
  matchScore: number | null;
  /** Ignored by the album owner: left out of unnamed groups and matching. */
  ignored?: boolean;
}

export interface PersonSummary {
  id: string;
  /** The owner's name for their own people; for anyone else's person, the caller's private label or null. */
  name: string | null;
  faceCount: number;
  photoCount: number;
  /** The caller owns this person (may rename, delete, name faces); false for another owner's person. */
  canEdit: boolean;
  cover: SerializedFace | null;
}

/** One person in an album (`GET /albums/contents`). */
export interface AlbumPersonTile {
  id: string;
  name: string | null;
  canEdit: boolean;
  photoCount: number;
  cover: SerializedFace | null;
}

/** One known personality in an album. */
export interface AlbumKnownTile {
  id: string;
  name: string;
  photoCount: number;
  cover: SerializedFace | null;
}

/** One species in an album; `scientific` is the `species=` filter key. */
export interface AlbumSpeciesTile {
  scientific: string;
  common: string;
  photoCount: number;
  coverPhotoId: string;
  thumbnailUrl: string;
}

export interface AlbumContents {
  people: AlbumPersonTile[];
  known: AlbumKnownTile[];
  species: AlbumSpeciesTile[];
}

/** A known personality (global reference data) matched in at least one photo the caller can see. */
export interface KnownPersonSummary {
  id: string;
  name: string;
  aliases: string[];
  photoCount: number;
}

export interface FaceGroup {
  faces: SerializedFace[];
}

export interface FaceGroupsResponse {
  groups: FaceGroup[];
  scanned: number;
  nextCursor: string | null;
}

export interface MatchResponse {
  auto: SerializedFace[];
  suggestions: SerializedFace[];
  scanned: number;
  nextCursor: string | null;
}

/** Dashboard insights. The fact types mirror worker/src/insights/types.ts: change both together. */
export type InsightTopic = 'time' | 'gear' | 'wildlife' | 'people' | 'places';

/** A span of years and its busiest month (1 to 12). */
export interface YearSpan {
  from: number;
  to: number;
  month: number;
}

export type TimeFact =
  /** counts: 12 months, index 0 is January. */
  | { id: 'top-month'; data: { counts: number[]; total: number } }
  /** counts: 7 weekdays, index 0 is Sunday. */
  | { id: 'top-weekday'; data: { counts: number[]; total: number } }
  | { id: 'records'; data: { busiest: { date: string; count: number }; gap: { days: number; from: string; to: string } } }
  | { id: 'shifts'; data: { older: YearSpan; newer: YearSpan } };

export type FocalGroup = 'under-35' | '35-69' | '70-199' | '200-399' | '400-plus';

export type GearFact =
  | { id: 'top-lens'; data: { lens: string; hits: number; photos: number; knownLensPhotos: number } }
  | { id: 'hit-rate'; data: { lenses: { lens: string; hits: number; photos: number }[] } }
  /** slot: the first hour of a 2-hour slot (0, 2, ... 22). */
  | { id: 'recipe'; data: { weekday: number; slot: number; focal: FocalGroup; hits: number; photos: number; allHits: number; allPhotos: number } }
  | { id: 'zoom'; data: { lens: string; min: number; max: number; atMax: number; photos: number; buckets: { from: number; to: number; photos: number }[] } }
  | { id: 'burst'; data: { years: { year: number; photos: number; moments: number }[] } }
  | { id: 'progress'; data: { years: { year: number; photos: number; hits: number; camera: string | null }[] } }
  | { id: 'cameras'; data: { total: number; cameras: { camera: string; first: string; last: string; photos: number }[] } };

export type WildlifeFact =
  /** byYear: the running species total at the end of each of the last years that added one. */
  | { id: 'life-list'; data: { total: number; year: number; newInYear: number; once: number; byYear: { year: number; total: number }[] } }
  /** month: 1 to 12. slots: the 2-hour slots within that month. */
  | { id: 'best-chance'; data: { species: string; photos: number; month: number; slot: number; slots: { slot: number; photos: number }[] } };

export interface FactPerson {
  id: string;
  name: string;
}

export type PeopleFact =
  | { id: 'together'; data: { pairs: { a: FactPerson; b: FactPerson; photos: number }[] } }
  | { id: 'missed'; data: { person: FactPerson; lastDate: string; photos: number } };

export type PlacesFact =
  | { id: 'travel'; data: { km: number; place: string | null; date: string; gpsPhotos: number } }
  | { id: 'places'; data: { year: number; newCount: number; top: { place: string; days: number; photos: number }[]; gpsPhotos: number } };

export type Fact = TimeFact | GearFact | WildlifeFact | PeopleFact | PlacesFact;

export interface InsightsResponse {
  day: string;
  facts: Fact[];
}

export interface OnThisDayResponse {
  date: string;
  years: { year: number; photos: SerializedPhoto[] }[];
}
