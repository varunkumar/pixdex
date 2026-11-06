import { Loader, Title } from '@mantine/core';
import { Navigate } from 'react-router-dom';
import { usePromptApiSupport } from '../hooks/usePromptApiSupport';

const AiSearch = () => {
  const support = usePromptApiSupport();
  if (support === 'checking') return <Loader />;
  if (support === 'unsupported') return <Navigate to="/" replace />;
  return <Title order={2}>AI Search</Title>;
};

export default AiSearch;
