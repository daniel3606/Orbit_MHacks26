import { ConnectionBanner } from '@/features/session/ConnectionBanner';
import { Card, Screen, T } from '@/ui/components';

/** Empty state until paper trading (PRD Phase 5) exists. */
export default function PortfolioScreen() {
  return (
    <Screen edges={['top']}>
      <ConnectionBanner />
      <T variant="title" accessibilityRole="header">
        Practice
      </T>
      <Card>
        <T variant="heading">Paper trading isn’t connected yet</T>
        <T muted>
          Your virtual balance, positions, and orders will appear here once the paper trading account is linked.
          No balances or trades are shown until they come from the provider.
        </T>
      </Card>
    </Screen>
  );
}
