import axios, { AxiosInstance } from 'axios';
import { AppConfig } from '../../types/config';
import {
  InstagramSuggestion,
  PhotoMetadata,
  PhotoStats,
  SearchCriteria,
} from '../../types/photo';

class ApiClient {
  private client: AxiosInstance;
  private baseUrl = 'http://localhost:3001/api';

  constructor() {
    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: 300000, // Increase to 5 minutes
    });
  }

  async indexLocalPhotos(): Promise<PhotoMetadata[]> {
    const { data } = await this.client.post<PhotoMetadata[]>('/index/local');
    return data;
  }

  async indexGoogleDrivePhotos(): Promise<PhotoMetadata[]> {
    const { data } = await this.client.post<PhotoMetadata[]>('/index/drive');
    return data;
  }

  async analyzePhoto(file: File): Promise<PhotoMetadata> {
    const formData = new FormData();
    formData.append('photo', file);
    const { data } = await this.client.post<PhotoMetadata>(
      '/photos/analyze',
      formData,
      {
        headers: { 'Content-Type': 'multipart/form-data' },
      }
    );
    return data;
  }

  async searchPhotos(criteria: SearchCriteria): Promise<PhotoMetadata[]> {
    const { data } = await this.client.post<PhotoMetadata[]>(
      '/photos/search',
      criteria
    );
    return data;
  }

  async getDailySuggestion(): Promise<InstagramSuggestion> {
    const { data } = await this.client.get<InstagramSuggestion>(
      '/photos/daily'
    );
    return data;
  }

  async getConfig(): Promise<AppConfig> {
    const { data } = await this.client.get<AppConfig>('/config');
    return data;
  }

  async updateConfig(config: AppConfig): Promise<void> {
    await this.client.post('/config', config);
  }

  async getPhotoStats(): Promise<PhotoStats> {
    const { data } = await this.client.get<PhotoStats>('/photos/stats');
    return data;
  }

  async getAlbums(): Promise<string[]> {
    const { data } = await this.client.get<string[]>('/albums');
    return data;
  }

  async clearAlbumIndex(album: string): Promise<void> {
    const response = await fetch(
      `${this.baseUrl}/index/clear/${encodeURIComponent(album)}`,
      {
        method: 'DELETE',
      }
    );
    if (!response.ok) {
      throw new Error('Failed to clear album index');
    }
  }

  async clearAllIndices(): Promise<void> {
    const response = await fetch(`${this.baseUrl}/index/clear-all`, {
      method: 'DELETE',
    });
    if (!response.ok) {
      throw new Error('Failed to clear all indices');
    }
  }
}

export const apiClient = new ApiClient();
