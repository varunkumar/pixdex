import { useQuery } from '@tanstack/react-query';
import { workerApiClient } from '../services/api/WorkerApiClient';

/**
 * The signed-in user. `email` stays null until /me answers (and if it fails). There is no special
 * user: what someone may edit is decided per album (photo.canEdit) and per person (person.canEdit).
 */
export function useMe(): {
  email: string | null;
  loading: boolean;
} {
  const { data, isPending } = useQuery({
    queryKey: ['me'],
    queryFn: () => workerApiClient.getMe(),
    staleTime: Infinity,
  });
  return {
    email: data?.email ?? null,
    loading: isPending,
  };
}
