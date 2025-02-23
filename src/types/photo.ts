export interface PhotoMetadata {
  id: string;
  filename: string;
  path: string;
  source: 'local' | 'google_drive';
  dateTime?: Date;
  location?: {
    latitude?: number;
    longitude?: number;
    place?: string;
  };
  aiMetadata: {
    subjects: string[];
    colors: string[];
    patterns: string[];
    album?: string;
    timeOfDay?: string;
    environment?: string;
    season?: string;
    tags: string[];
    description: string;
  };
  technicalInfo: {
    dimensions: {
      width: number;
      height: number;
    };
    format?: string;
    size?: number;
    space?: string;
    hasAlpha?: boolean;
    channels?: number;
    // Camera info
    camera?: string;
    lens?: string;
    aperture?: string;
    shutterSpeed?: string;
    iso?: number;
  };
  vectorEmbedding?: number[];
  lastIndexed: Date;
  instagramSuggested?: Date;
}

export interface SearchCriteria {
  query?: string;
  subjects?: string[];
  colors?: string[];
  patterns?: string[];
  season?: string;
  startDate?: Date;
  endDate?: Date;
  location?: string;
  album?: string;
  semanticSearch?: string;
}

export interface InstagramSuggestion {
  photo: PhotoMetadata;
  reason: string;
  suggestedCaption: string;
  suggestedHashtags: string[];
}

export interface PhotoStats {
  totalPhotos: number;
  uniqueSubjects: number;
  uniqueLocations: number;
  uniqueAlbums: number;
}
