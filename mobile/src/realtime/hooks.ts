import { useSyncExternalStore } from 'react';

import { realtime, type RealtimeSnapshot } from './connection';

/** Subscribed server state. This is the only client copy of it — no second cache. */
export function useRealtime(): RealtimeSnapshot {
  return useSyncExternalStore(realtime.subscribe, realtime.getSnapshot);
}

export function useIsLive(): boolean {
  return useRealtime().status === 'ready';
}
