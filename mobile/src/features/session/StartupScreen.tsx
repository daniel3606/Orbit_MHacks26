import { LinearGradient } from 'expo-linear-gradient';
import { useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { DiagnosticsPanel } from '@/features/diagnostics/DiagnosticsPanel';
import { realtime } from '@/realtime/connection';
import { messageFor } from '@/realtime/errors';
import { useRealtime } from '@/realtime/hooks';
import { Banner, Button, T } from '@/ui/components';
import { OrbitLogo } from '@/ui/OrbitLogo';
import { backgroundGradient, colors, space } from '@/ui/theme';

const STATUS_COPY: Record<string, string> = {
  starting: 'Restoring your session…',
  connecting: 'Connecting to Orbit…',
  syncing: 'Loading your profile…',
  reconnecting: 'Trying to reach Orbit again…',
  paused: 'Paused while the app is in the background.',
};

/** The Loading frame: shown until authoritative state has been received at least once. */
export function StartupScreen() {
  const rt = useRealtime();
  const { width } = useWindowDimensions();
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const isError = rt.status === 'error';
  const failing = rt.status === 'reconnecting' && rt.diagnostics.reconnectAttempt > 0;
  const trouble = isError || failing;

  return (
    <LinearGradient colors={backgroundGradient} locations={[0, 0.5, 1] as const} style={styles.fill}>
      <SafeAreaView style={styles.fill}>
        <View style={styles.center}>
          {/* The design's lockup is ~300pt wide on a 430pt screen; keep that share on smaller phones. */}
          <OrbitLogo scale={Math.min(1, width / 430)} />
        </View>

        <ScrollView
          style={{ flexGrow: 0, maxHeight: trouble ? '60%' : undefined }}
          contentContainerStyle={styles.bottom}
          scrollEnabled={showDiagnostics || trouble}>
          {!isError ? (
            <View style={styles.status}>
              <ActivityIndicator color={colors.textMuted} accessibilityLabel="Loading" />
              <T variant="caption" muted>
                {STATUS_COPY[rt.status] ?? 'Connecting…'}
              </T>
            </View>
          ) : null}
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
          {trouble ? (
            <Button
              label={showDiagnostics ? 'Hide diagnostics' : 'Connection diagnostics'}
              kind="secondary"
              onPress={() => setShowDiagnostics(v => !v)}
            />
          ) : null}
          {showDiagnostics ? <DiagnosticsPanel /> : null}
        </ScrollView>
      </SafeAreaView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  bottom: { paddingHorizontal: space.xl, paddingBottom: space.lg, gap: space.md },
  status: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.sm, minHeight: 44 },
});
