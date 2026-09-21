import type { AlbumsResponse, DailyPickResponse, SearchResponse, SerializedPhoto } from '../../types/api';

export interface SearchParams {
  q?: string;
  album?: string;
  limit?: number;
  offset?: number;
}

export class WorkerApiClient {
  constructor(
    private baseUrl: string,
    private fetchFn: typeof fetch = fetch
  ) {}

  private async getJson<T>(path: string): Promise<T> {
    const response = await this.fetchFn(`${this.baseUrl}${path}`);
    if (!response.ok) {
      throw new Error(`Request to ${path} failed: ${response.status}`);
    }
    return (await response.json()) as T;
  }

  async search(params: SearchParams): Promise<SerializedPhoto[]> {
    const query = new URLSearchParams();
    if (params.q) query.set('q', params.q);
    if (params.album) query.set('album', params.album);
    if (params.limit != null) query.set('limit', String(params.limit));
    if (params.offset != null) query.set('offset', String(params.offset));

    const suffix = query.toString() ? `?${query.toString()}` : '';
    const { results } = await this.getJson<SearchResponse>(`/search${suffix}`);
    return results;
  }

  async getAlbums(): Promise<string[]> {
    const { albums } = await this.getJson<AlbumsResponse>('/albums');
    return albums;
  }

  async getPhoto(id: string): Promise<SerializedPhoto> {
    return this.getJson<SerializedPhoto>(`/photos/${id}`);
  }

  async getDailyPick(): Promise<DailyPickResponse> {
    return this.getJson<DailyPickResponse>('/daily-pick');
  }

  thumbnailUrl(photo: Pick<SerializedPhoto, 'thumbnailUrl'>): string {
    return `${this.baseUrl}${photo.thumbnailUrl ?? ''}`;
  }
}

if (!import.meta.env.VITE_WORKER_API_BASE_URL) {
  console.error('VITE_WORKER_API_BASE_URL is not set — API requests will fail.');
}

export const workerApiClient = new WorkerApiClient(
  import.meta.env.VITE_WORKER_API_BASE_URL ?? ''
);
