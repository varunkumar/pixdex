import { useQueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { matchQueueFor } from '../services/matchQueue';

/** The app's background matching queue and its current state. */
export function useMatchQueue() {
  const queue = matchQueueFor(useQueryClient());
  const state = useSyncExternalStore(queue.subscribe, queue.getSnapshot);
  return { ...state, enqueue: queue.enqueue };
}
