import { Timestamp } from 'spacetimedb';

import { realtime } from '@/realtime/connection';
import type { ValidDraft } from '@/state/onboarding-draft';

/** Ownership is derived server-side from the connection identity; no user id is sent. */
export function completeOnboarding(value: ValidDraft) {
  return realtime.call(conn => conn.reducers.completeOnboarding(value));
}

export function updatePreferences(expectedVersion: number, value: ValidDraft) {
  return realtime.call(conn => conn.reducers.updatePreferences({ expectedVersion, ...value }));
}

export function requestRecommendations() {
  return realtime.call(conn => conn.reducers.requestRecommendations({}));
}

/** Asks for today's Discovery set. `localDate` is the device's calendar day; the owner is the connection. */
export function requestDailyDiscovery(localDate: string) {
  return realtime.call(conn => conn.reducers.requestDailyDiscovery({ localDate }));
}

/** Asks the server for recent news on one company; it coalesces repeats and fetches on its side. */
export function requestStockNews(ticker: string) {
  return realtime.call(conn => conn.reducers.requestStockNews({ ticker }));
}

export function requestPaperSync() {
  return realtime.call(conn => conn.reducers.requestPaperSync({}));
}

export function createPaperOrder(input: {
  ticker: string;
  side: 'buy' | 'sell';
  quantityMicros?: bigint;
  notionalMicros?: bigint;
  clientOrderKey: string;
  quoteMicros: bigint;
  quoteTime: Date;
}) {
  return realtime.call(conn =>
    conn.reducers.createPaperOrderIntent({
      ticker: input.ticker,
      side: input.side,
      quantityMicros: input.quantityMicros,
      notionalMicros: input.notionalMicros,
      clientOrderKey: input.clientOrderKey,
      quoteMicros: input.quoteMicros,
      quoteTime: new Timestamp(BigInt(input.quoteTime.getTime()) * 1000n),
    })
  );
}

/** Asks the server to write today's home introduction. The owner is the connection. */
export function requestHomeBrief(clientKey: string) {
  return realtime.call(conn => conn.reducers.requestHomeBrief({ clientKey }));
}

/** Sends one question. The same clientKey is idempotent, so a retried tap cannot double-send. */
export function askOrbit(clientKey: string, text: string) {
  return realtime.call(conn => conn.reducers.enqueueAssistantMessage({ clientKey, text }));
}

/** Clears the caller's questions and answers so the next question starts a new conversation. */
export function clearOrbitChat() {
  return realtime.call(conn => conn.reducers.clearAssistantChat({}));
}

export function requestBackendCheck(): Promise<string> {
  const requestKey = `check-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return realtime.call(conn => conn.reducers.requestBackendCheck({ requestKey })).then(() => requestKey);
}

export function markNotificationRead(notificationId: string) {
  return realtime.call(conn => conn.reducers.markNotificationRead({ notificationId: BigInt(notificationId) }));
}

export function markAllNotificationsRead() {
  return realtime.call(conn => conn.reducers.markAllNotificationsRead({}));
}
