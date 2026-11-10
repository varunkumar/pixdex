import { useQuery } from '@tanstack/react-query';
import { workerApiClient } from '../services/api/WorkerApiClient';

/**
 * The signed-in user. `isDefaultOwner` stays false until /me answers (and if it fails), so
 * people-management controls never flash for a viewer.
 */
export function useMe(): {
  email: string | null;
  isDefaultOwner: boolean;
  loading: boolean;
} {
  const { data, isPending } = useQuery({
    queryKey: ['me'],
    queryFn: () => workerApiClient.getMe(),
    staleTime: Infinity,
  });
  return {
    email: data?.email ?? null,
    isDefaultOwner: data?.isDefaultOwner === true,
    loading: isPending,
  };
}
