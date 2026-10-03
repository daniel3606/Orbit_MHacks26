import { realtime } from '@/realtime/connection';
import type { ValidDraft } from '@/state/onboarding-draft';

/** Ownership is derived server-side from the connection identity; no user id is sent. */
export function completeOnboarding(value: ValidDraft) {
  return realtime.call(conn => conn.reducers.completeOnboarding(value));
}

export function updatePreferences(expectedVersion: number, value: ValidDraft) {
  return realtime.call(conn => conn.reducers.updatePreferences({ expectedVersion, ...value }));
}

export function requestBackendCheck(): Promise<string> {
  const requestKey = `check-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return realtime.call(conn => conn.reducers.requestBackendCheck({ requestKey })).then(() => requestKey);
}
