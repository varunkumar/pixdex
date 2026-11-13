import { Loader } from '@mantine/core';
import { Navigate, useLocation } from 'react-router-dom';
import { usePromptApiSupport } from '../hooks/usePromptApiSupport';
import { mapLegacyAiParams, stripAiParams } from '../services/omnibox/urlState';

/** Old `/ai-search` links land on the merged Search page: in AI mode when supported, else as a plain search. */
export default function LegacyAiRedirect() {
  const support = usePromptApiSupport();
  const { search } = useLocation();
  if (support === 'checking') return <Loader />;
  const mapped = new URLSearchParams(mapLegacyAiParams(search));
  const next = support === 'supported' ? mapped : stripAiParams(mapped);
  const qs = next.toString();
  return <Navigate to={qs ? `/search?${qs}` : '/search'} replace />;
}
