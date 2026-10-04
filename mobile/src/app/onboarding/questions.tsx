import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { isAnswered, QuestionBlock, QUESTIONS } from '@/features/onboarding/questions';
import { BrandHeader, PillButton, ProgressSegments } from '@/features/onboarding/ui';
import { completeOnboarding } from '@/features/profile/actions';
import { ConnectionBanner } from '@/features/session/ConnectionBanner';
import { messageFor, toAppError } from '@/realtime/errors';
import { useRealtime } from '@/realtime/hooks';
import { useDraft, validateDraft } from '@/state/onboarding-draft';
import { useReveal } from '@/state/reveal';
import { Banner, Screen, T } from '@/ui/components';
import { space } from '@/ui/theme';

/** The questionnaire (Q1 template frame): one question per step, saved after the last. */
export default function QuestionsScreen() {
  const router = useRouter();
  const rt = useRealtime();
  const { draft, step, setStep, reset } = useDraft();
  const begin = useReveal(s => s.begin);
  const end = useReveal(s => s.end);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = rt.status === 'ready';

  const index = Math.min(step, QUESTIONS.length - 1);
  const question = QUESTIONS[index];
  const last = index === QUESTIONS.length - 1;
  const canContinue = isAnswered(question, draft);

  function back() {
    setError(null);
    if (index === 0) router.back();
    else setStep(index - 1);
  }

  async function save() {
    const result = validateDraft(draft);
    if (!result.ok) {
      setError(`Please answer: ${result.missing.join(', ')}.`);
      return;
    }
    setError(null);
    setSaving(true);
    // The loading screen goes up now and stays while the routes switch to Home underneath it.
    begin(draft.zodiacSign);
    try {
      await completeOnboarding(result.value);
      reset();
    } catch (err) {
      end();
      setError(messageFor(toAppError(err).code));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Screen
      // A fresh scroll position for each question.
      key={index}
      header={
        <>
          <BrandHeader onBack={back} />
          <ProgressSegments count={QUESTIONS.length} current={index} />
        </>
      }
      footerBorder={false}
      footer={
        <View style={styles.next}>
          <PillButton
            label={last ? 'Continue' : 'Next'}
            busy={saving}
            disabled={!canContinue || (last && !live)}
            onPress={last ? save : () => setStep(index + 1)}
          />
        </View>
      }>
      <ConnectionBanner />
      <QuestionBlock question={question} />
      {error ? <Banner tone="danger" title="Not saved" body={error} /> : null}
      {last && !live ? (
        <T variant="caption" muted>
          Saving is available once Orbit is connected.
        </T>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  next: { paddingHorizontal: space.xl, paddingBottom: space.sm },
});
