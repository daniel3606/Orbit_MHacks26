import { useMemo, useState } from 'react';
import { Alert, View } from 'react-native';

import { requestBackendCheck } from '@/features/profile/actions';
import { realtime } from '@/realtime/connection';
import { messageFor, toAppError } from '@/realtime/errors';
import { useRealtime } from '@/realtime/hooks';
import { Banner, Button, Card, Row, T } from '@/ui/components';
import { colors, space } from '@/ui/theme';
import { runRuntimeChecks } from './runtime-checks';

const fmt = (d: Date | null) => (d ? d.toLocaleTimeString() : '—');

export function DiagnosticsPanel() {
  const rt = useRealtime();
  const checks = useMemo(() => runRuntimeChecks(), []);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [requestedAt, setRequestedAt] = useState<number | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const d = rt.diagnostics;

  const job = pendingKey ? rt.jobs.find(j => j.requestKey === pendingKey) : undefined;
  // Measured on this device's clock: tap → committed row observed via subscription.
  const roundTripMs =
    job?.status === 'succeeded' && requestedAt !== null ? job.observedAt.getTime() - requestedAt : null;

  async function runBackendCheck() {
    setCheckError(null);
    try {
      const started = Date.now();
      const key = await requestBackendCheck();
      setRequestedAt(started);
      setPendingKey(key);
    } catch (err) {
      setCheckError(messageFor(toAppError(err).code));
    }
  }

  function confirmReset() {
    Alert.alert(
      'Start a new guest session?',
      'This device will get a new identity. Your current profile stays on the server but this device will no longer be able to reach it. Guest sessions cannot be recovered.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Start new session', style: 'destructive', onPress: () => void realtime.resetGuestSession() },
      ]
    );
  }

  return (
    <View style={{ gap: space.lg }}>
      <Card>
        <T variant="heading">Connection</T>
        <Row label="Status" value={rt.status} />
        <Row label="Server" value={d.uri} />
        <Row label="Address source" value={d.uriSource} />
        <Row label="Database" value={d.database} />
        <Row label="Session" value="Device-bound guest (not recoverable across devices)" />
        <Row label="Identity" value={rt.identityHex ? `${rt.identityHex.slice(0, 10)}…${rt.identityHex.slice(-6)}` : '—'} />
        <Row label="Restored from secure storage" value={d.sessionRestored ? 'yes' : 'no'} />
        <Row label="Saved to secure storage" value={d.sessionPersisted === null ? '—' : d.sessionPersisted ? 'yes' : 'FAILED'} />
        <Row label="Connections opened" value={String(d.connectCount)} />
        <Row label="Live connections" value={String(d.liveConnections)} />
        <Row label="Reconnect attempt" value={String(d.reconnectAttempt)} />
        <Row label="Connected at" value={fmt(d.connectedAt)} />
        <Row label="Subscription applied" value={fmt(d.subscriptionAppliedAt)} />
        <Row label="Last row event" value={fmt(d.lastEventAt)} />
        <Row label="Last disconnect" value={d.lastDisconnectReason ?? '—'} />
        {rt.error ? <Banner tone="danger" title={rt.error.code} body={messageFor(rt.error.code)} /> : null}
        <Button label="Reconnect now" kind="secondary" onPress={() => realtime.retry()} />
      </Card>

      <Card>
        <T variant="heading">Backend round trip</T>
        <T variant="caption" muted>
          Enqueues a durable job. The Python worker claims it, reads your profile through a service-only view, and
          commits a result that arrives here by subscription. Requires the worker to be running.
        </T>
        {job ? (
          <>
            <Row label="Job" value={`#${job.jobId} · ${job.status}`} />
            <Row label="Attempts" value={String(job.attemptCount)} />
            <Row label="Result" value={job.resultRef ?? job.errorCode ?? '—'} />
            {roundTripMs !== null ? <Row label="Request → committed" value={`${roundTripMs} ms`} /> : null}
          </>
        ) : null}
        {checkError ? <Banner tone="warning" title="Could not enqueue" body={checkError} /> : null}
        <Button label="Run backend check" kind="secondary" disabled={rt.status !== 'ready'} onPress={runBackendCheck} />
      </Card>

      <Card>
        <T variant="heading">Runtime compatibility</T>
        {checks.map(c => (
          <Row
            key={c.name}
            label={c.name}
            value={<T variant="caption" color={c.ok ? colors.success : colors.danger}>{c.ok ? `✓ ${c.detail}` : `✗ ${c.detail}`}</T>}
          />
        ))}
        <T variant="caption" muted>
          Binary protocol: verified when “Subscription applied” has a time (server frames decoded) and a save or
          backend check succeeds (client frames encoded).
        </T>
      </Card>

      <Button label="Start a new guest session…" kind="danger" onPress={confirmReset} />
    </View>
  );
}
