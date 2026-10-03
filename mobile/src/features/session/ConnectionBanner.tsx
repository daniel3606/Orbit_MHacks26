import { realtime } from '@/realtime/connection';
import { messageFor } from '@/realtime/errors';
import { useRealtime } from '@/realtime/hooks';
import { Banner } from '@/ui/components';

/** Read-only/stale indicator once data has loaded at least once. */
export function ConnectionBanner() {
  const rt = useRealtime();
  if (rt.status === 'ready') return null;
  const synced = rt.diagnostics.subscriptionAppliedAt?.toLocaleTimeString() ?? 'earlier';

  if (rt.status === 'error' && rt.error) {
    return (
      <Banner
        tone="danger"
        title="Connection problem"
        body={messageFor(rt.error.code)}
        action={{ label: 'Retry', onPress: () => realtime.retry() }}
      />
    );
  }
  return (
    <Banner
      tone="warning"
      title={rt.status === 'syncing' ? 'Syncing…' : 'Offline — showing last synced data'}
      body={`Last synced ${synced}. Editing is paused until Orbit reconnects.`}
      action={rt.status === 'syncing' ? undefined : { label: 'Retry', onPress: () => realtime.retry() }}
    />
  );
}
