import { ConnectionBanner } from '@/features/session/ConnectionBanner';
import { useRealtime } from '@/realtime/hooks';
import { Card, Row, Screen, T } from '@/ui/components';

const STATUS: Record<string, string> = {
  queued: 'Queued',
  running: 'In progress',
  retry_wait: 'Waiting to retry',
  succeeded: 'Done',
  failed: 'Failed',
};

/** Empty state until discovery (PRD Phase 4) exists. Shows the real queued refresh request. */
export default function DiscoverScreen() {
  const rt = useRealtime();
  const refresh = rt.jobs.find(j => j.kind === 'refresh_recommendations');

  return (
    <Screen edges={['top']}>
      <ConnectionBanner />
      <T variant="title" accessibilityRole="header">
        Discover
      </T>
      <Card>
        <T variant="heading">Matches aren’t available yet</T>
        <T muted>
          Personalized matches need live market data and the ranking engine, which are not connected in this build.
          Orbit will not show placeholder stocks or scores.
        </T>
        {refresh ? (
          <>
            <Row label="Your refresh request" value={STATUS[refresh.status] ?? refresh.status} />
            <Row label="For profile version" value={String(refresh.inputVersion)} />
            <Row label="Requested" value={refresh.createdAt.toLocaleString()} />
          </>
        ) : null}
      </Card>
    </Screen>
  );
}
