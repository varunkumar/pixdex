// Minimal typing for the browser Prompt API (Chrome Gemini Nano).
// Only the parts PixdeX uses. `LanguageModel` is undefined in most browsers.

interface LanguageModelExpectedIO {
  type: 'text';
  languages?: string[];
}

interface LanguageModelCreateMonitor extends EventTarget {
  addEventListener(
    type: 'downloadprogress',
    listener: (e: Event & { loaded: number }) => void,
  ): void;
}

interface LanguageModelSession {
  prompt(input: string, options?: { responseConstraint?: object }): Promise<string>;
  destroy(): void;
}

interface LanguageModelOptions {
  expectedInputs?: LanguageModelExpectedIO[];
  expectedOutputs?: LanguageModelExpectedIO[];
}

interface LanguageModelCreateOptions extends LanguageModelOptions {
  initialPrompts?: { role: 'system' | 'user' | 'assistant'; content: string }[];
  monitor?(m: LanguageModelCreateMonitor): void;
}

declare const LanguageModel:
  | {
      availability(
        options?: LanguageModelOptions,
      ): Promise<'available' | 'downloadable' | 'downloading' | 'unavailable'>;
      create(options?: LanguageModelCreateOptions): Promise<LanguageModelSession>;
    }
  | undefined;
