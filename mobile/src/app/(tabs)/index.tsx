import { useRouter } from 'expo-router';
import { View } from 'react-native';

import {
  EXPERIENCE_LEVEL,
  INVESTMENT_HORIZON,
  INVESTMENT_STYLE,
  PRIMARY_GOAL,
  RISK_TOLERANCE,
  SECTORS,
  ZODIAC_SIGNS,
  labelFor,
} from '@/features/onboarding/options';
import { ConnectionBanner } from '@/features/session/ConnectionBanner';
import { useRealtime } from '@/realtime/hooks';
import { Button, Card, Chip, Row, Screen, T } from '@/ui/components';
import { space } from '@/ui/theme';

export default function HomeScreen() {
  const router = useRouter();
  const rt = useRealtime();
  const profile = rt.profile;
  if (!profile) return null; // route is guarded; transient during sign-out

  const sign = rt.branding?.zodiacSign ?? null;

  return (
    <Screen edges={['top']}>
      <ConnectionBanner />
      <View style={{ gap: space.xs }}>
        <T variant="caption" muted>
          {sign ? `${labelFor(ZODIAC_SIGNS, sign)} · ` : ''}Your Orbit
        </T>
        <T variant="display" accessibilityRole="header">
          Welcome back
        </T>
      </View>

      <Card>
        <T variant="heading">Your investing profile</T>
        <Row label="Risk comfort" value={labelFor(RISK_TOLERANCE, profile.riskTolerance)} />
        <Row label="Time horizon" value={labelFor(INVESTMENT_HORIZON, profile.investmentHorizon)} />
        <Row label="Style" value={labelFor(INVESTMENT_STYLE, profile.investmentStyle)} />
        <Row label="Experience" value={labelFor(EXPERIENCE_LEVEL, profile.experienceLevel)} />
        <Row label="Goal" value={labelFor(PRIMARY_GOAL, profile.primaryGoal)} />
        <View style={{ gap: space.sm, paddingTop: space.sm }}>
          <T variant="caption" muted>
            Sectors
          </T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
            {profile.sectorInterests.map(s => (
              <Chip key={s} label={labelFor(SECTORS, s)} />
            ))}
          </View>
        </View>
        <T variant="caption" muted style={{ paddingTop: space.sm }}>
          Version {profile.profileVersion} · saved {profile.updatedAt.toLocaleString()}
        </T>
        <Button
          label="Edit preferences"
          kind="secondary"
          disabled={rt.status !== 'ready'}
          accessibilityHint={rt.status !== 'ready' ? 'Unavailable while offline' : undefined}
          onPress={() => router.push('/edit-preferences')}
        />
      </Card>

      <Card>
        <T variant="heading">Practice with virtual money</T>
        <T muted>
          Orbit explains market activity in plain language and lets you practice with a paper (simulated) account.
          Nothing here is financial advice.
        </T>
      </Card>

      <Button label="Connection diagnostics" kind="secondary" onPress={() => router.push('/diagnostics')} />
    </Screen>
  );
}
