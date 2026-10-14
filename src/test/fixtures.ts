import type { SerializedPhoto } from '../types/api';

export function makePhoto(overrides: Partial<SerializedPhoto> = {}): SerializedPhoto {
  return {
    id: 'p1',
    path: null,
    driveFileId: null,
    source: 'local',
    filename: 'DSC_0001.jpg',
    dateTime: null,
    width: null,
    height: null,
    format: null,
    fileSize: null,
    subjects: [],
    colors: [],
    patterns: [],
    tags: [],
    season: null,
    environment: null,
    album: null,
    description: 'A leopard in a tree.',
    suggestedHashtags: [],
    instagramSuggested: null,
    thumbnailUrl: '/thumbnails/h1',
    ...overrides,
  };
}
