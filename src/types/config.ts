export type LLMProvider = 'openai' | 'grok3';

export interface LLMConfig {
  provider: LLMProvider;
  apiKey: string;
  modelName?: string;
  temperature?: number;
}

export interface StorageConfig {
  localPaths: string[];
  googleDrive: {
    enabled: boolean;
    credentialsPath: string;
  };
}

export interface AppConfig {
  llm: LLMConfig;
  storage: StorageConfig;
  chromaDbPath: string;
  cacheDir: string;
}
