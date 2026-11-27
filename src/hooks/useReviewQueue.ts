import { useQuery } from '@tanstack/react-query';
import { workerApiClient } from '../services/api/WorkerApiClient';

/**
 * People with auto matches waiting, most first. The Worker reads every pending face to count them, so changes only
 * mark this stale (`markReviewQueueStale`): it is requested again when a page that shows it is next opened.
 */
export const useReviewQueue = () =>
  useQuery({
    queryKey: ['review-queue'],
    queryFn: () => workerApiClient.getReviewQueue(),
    staleTime: 5 * 60 * 1000,
  });
