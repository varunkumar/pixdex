import { useEffect, useState } from 'react';
import { getPromptApiStatus } from '../services/aiSearch/promptApi';

export type PromptApiSupport = 'checking' | 'supported' | 'unsupported';

/** Resolves once per mount whether the browser's Prompt API can be used. */
export function usePromptApiSupport(): PromptApiSupport {
  const [support, setSupport] = useState<PromptApiSupport>('checking');

  useEffect(() => {
    let active = true;
    getPromptApiStatus()
      .then((status) => {
        if (active) setSupport(status === 'unsupported' ? 'unsupported' : 'supported');
      })
      .catch(() => {
        if (active) setSupport('unsupported');
      });
    return () => {
      active = false;
    };
  }, []);

  return support;
}
