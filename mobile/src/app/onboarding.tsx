import { useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { isAnswered, QuestionBlock, QUESTIONS } from '@/features/onboarding/questions';
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
import { completeOnboarding } from '@/features/profile/actions';
import { ConnectionBanner } from '@/features/session/ConnectionBanner';
import { messageFor, toAppError } from '@/realtime/errors';
import { useRealtime } from '@/realtime/hooks';
import { useDraft, validateDraft } from '@/state/onboarding-draft';
import { Banner, Button, Card, Row, Screen, T } from '@/ui/components';
import { colors, space } from '@/ui/theme';

const INTRO = 0;
const REVIEW = QUESTIONS.length + 1;

export default function OnboardingScreen() {
  const router = useRouter();
  const rt = useRealtime();
  const { draft, step, setStep, reset } = useDraft();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = rt.status === 'ready';

  const question = step > INTRO && step < REVIEW ? QUESTIONS[step - 1] : null;
  const canContinue = question ? isAnswered(question, draft) : true;

  async function save() {
    const result = validateDraft(draft);
    if (!result.ok) {
      setError(`Please answer: ${result.missing.join(', ')}.`);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await completeOnboarding(result.value);
      // The protected route switches to Home when the profile row arrives by subscription.
      reset();
    } catch (err) {
      setError(messageFor(toAppError(err).code));
    } finally {
      setSaving(false);
    }
  }

  const footer =
    step === INTRO ? (
      <>
        <Button label="Get started" onPress={() => setStep(1)} />
        <Button label="Connection diagnostics" kind="secondary" onPress={() => router.push('/diagnostics')} />
      </>
    ) : step === REVIEW ? (
      <>
        <Button label="Save my profile" busy={saving} disabled={!live} onPress={save} />
        <Button label="Back" kind="secondary" disabled={saving} onPress={() => setStep(step - 1)} />
      </>
    ) : (
      <>
        <Button
          label={question?.optional && !draft.zodiacSign ? 'Skip' : 'Continue'}
          disabled={!canContinue}
          onPress={() => setStep(step + 1)}
        />
        <Button label="Back" kind="secondary" onPress={() => setStep(step - 1)} />
      </>
    );

  return (
    <Screen footer={footer}>
      <ConnectionBanner />
      {step > INTRO ? (
        <View
          accessibilityRole="progressbar"
          accessibilityValue={{ min: 1, max: REVIEW, now: step }}
          style={{ flexDirection: 'row', gap: 4 }}>
          {Array.from({ length: REVIEW }, (_, i) => (
            <View
              key={i}
              style={{ flex: 1, height: 4, borderRadius: 2, backgroundColor: i < step ? colors.accent : colors.border }}
            />
          ))}
        </View>
      ) : null}

      {step === INTRO ? (
        <View style={{ gap: space.lg, paddingTop: space.xxl }}>
          <T variant="display" accessibilityRole="header">
            Let’s map your Orbit
          </T>
          <T muted>
            A few questions about how you’d like to invest. Orbit uses your answers to explain which companies may fit
            you — it does not predict prices, and practice trades use virtual money.
          </T>
          <T variant="caption" muted>
            This development build uses a guest session tied to this device. It can’t be recovered on another device.
          </T>
        </View>
      ) : null}

      {question ? <QuestionBlock question={question} /> : null}

      {step === REVIEW ? (
        <View style={{ gap: space.lg }}>
          <T variant="title" accessibilityRole="header">
            Review your answers
          </T>
          <Card>
            <Row label="Risk comfort" value={labelFor(RISK_TOLERANCE, draft.riskTolerance)} />
            <Row label="Time horizon" value={labelFor(INVESTMENT_HORIZON, draft.investmentHorizon)} />
            <Row label="Style" value={labelFor(INVESTMENT_STYLE, draft.investmentStyle)} />
            <Row label="Sectors" value={draft.sectorInterests.map(s => labelFor(SECTORS, s)).join(', ')} />
            <Row label="Experience" value={labelFor(EXPERIENCE_LEVEL, draft.experienceLevel)} />
            <Row label="Goal" value={labelFor(PRIMARY_GOAL, draft.primaryGoal)} />
            <Row label="Sign (daily theme)" value={draft.zodiacSign ? labelFor(ZODIAC_SIGNS, draft.zodiacSign) : 'None'} />
          </Card>
          {error ? <Banner tone="danger" title="Not saved" body={error} /> : null}
          {!live ? <T variant="caption" muted>Saving is available once Orbit is connected.</T> : null}
        </View>
      ) : null}
    </Screen>
  );
}
