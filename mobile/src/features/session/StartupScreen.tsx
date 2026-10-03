import { useState } from 'react';
import { ActivityIndicator, View } from 'react-native';

import { DiagnosticsPanel } from '@/features/diagnostics/DiagnosticsPanel';
import { realtime } from '@/realtime/connection';
import { messageFor } from '@/realtime/errors';
import { useRealtime } from '@/realtime/hooks';
import { Banner, Button, Screen, T } from '@/ui/components';
import { colors, space } from '@/ui/theme';

const STATUS_COPY: Record<string, string> = {
  starting: 'Restoring your session…',
  connecting: 'Connecting to Orbit…',
  syncing: 'Loading your profile…',
  reconnecting: 'Trying to reach Orbit again…',
  paused: 'Paused while the app is in the background.',
};

/** Shown until authoritative state has been received at least once. */
export function StartupScreen() {
  const rt = useRealtime();
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const isError = rt.status === 'error';
  const failing = rt.status === 'reconnecting' && rt.diagnostics.reconnectAttempt > 0;

  return (
    <Screen>
      <View style={{ alignItems: 'center', gap: space.md, paddingTop: space.xxxl }}>
        <T variant="display" accessibilityRole="header">
          Orbit
        </T>
        <T muted style={{ textAlign: 'center' }}>
          Discover, understand, and practice investing with virtual money.
        </T>
      </View>

      <View style={{ alignItems: 'center', gap: space.md, paddingVertical: space.xl }}>
        {!isError ? <ActivityIndicator color={colors.accent} accessibilityLabel="Loading" /> : null}
        {!isError ? <T muted>{STATUS_COPY[rt.status] ?? 'Connecting…'}</T> : null}
      </View>

      {isError && rt.error ? (
        <Banner tone="danger" title="Can't open your session" body={messageFor(rt.error.code)} />
      ) : null}
      {failing ? (
        <Banner
          tone="warning"
          title="Can't reach the Orbit server"
          body={`Attempt ${rt.diagnostics.reconnectAttempt}. Check that SpacetimeDB is running and reachable at ${rt.diagnostics.uri}.`}
          action={{ label: 'Retry', onPress: () => realtime.retry() }}
        />
      ) : null}
      {isError ? <Button label="Try again" onPress={() => realtime.retry()} /> : null}

      <Button
        label={showDiagnostics ? 'Hide diagnostics' : 'Connection diagnostics'}
        kind="secondary"
        onPress={() => setShowDiagnostics(v => !v)}
      />
      {showDiagnostics ? <DiagnosticsPanel /> : null}
    </Screen>
  );
}
