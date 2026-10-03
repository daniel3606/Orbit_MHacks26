import { useRouter } from 'expo-router';
import { useLayoutEffect, useState } from 'react';
import { View } from 'react-native';

import { QuestionBlock, QUESTIONS } from '@/features/onboarding/questions';
import { updatePreferences } from '@/features/profile/actions';
import { ConnectionBanner } from '@/features/session/ConnectionBanner';
import type { RealtimeSnapshot } from '@/realtime/connection';
import { messageFor, toAppError } from '@/realtime/errors';
import { useRealtime } from '@/realtime/hooks';
import { draftFromProfile, useDraft, validateDraft, type Draft } from '@/state/onboarding-draft';
import { Banner, Button, Screen } from '@/ui/components';
import { space } from '@/ui/theme';

function sameDraft(a: Draft, b: Draft) {
  return JSON.stringify(a) === JSON.stringify(b);
}

type Baseline = { version: number; draft: Draft };

function baselineFrom(rt: RealtimeSnapshot): Baseline | null {
  if (!rt.profile) return null;
  return { version: rt.profile.profileVersion, draft: draftFromProfile(rt.profile, rt.branding?.zodiacSign ?? null) };
}

export default function EditPreferencesScreen() {
  const router = useRouter();
  const rt = useRealtime();
  const { draft, replace, reset } = useDraft();
  // Start from the subscribed, committed values.
  const [baseline, setBaseline] = useState<Baseline | null>(() => baselineFrom(rt));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ code: string; text: string } | null>(null);

  // Sync the external draft store with the baseline before paint; discard on exit.
  useLayoutEffect(() => {
    if (baseline) replace(baseline.draft);
    return () => reset();
  }, [baseline, replace, reset]);

  if (!rt.profile || !baseline) return null;

  const live = rt.status === 'ready';
  const dirty = !sameDraft(draft, baseline.draft);
  const newerOnServer = rt.profile.profileVersion !== baseline.version;

  async function save() {
    const result = validateDraft(draft);
    if (!result.ok) {
      setError({ code: 'invalid', text: `Please answer: ${result.missing.join(', ')}.` });
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await updatePreferences(baseline!.version, result.value);
      router.back();
    } catch (err) {
      const code = toAppError(err).code;
      setError({ code, text: messageFor(code) });
    } finally {
      setSaving(false);
    }
  }

  function loadLatest() {
    setError(null);
    setBaseline(baselineFrom(rt));
  }

  return (
    <Screen
      edges={['bottom']}
      footer={
        <>
          <Button label="Save changes" busy={saving} disabled={!live || !dirty} onPress={save} />
          <Button label="Cancel" kind="secondary" disabled={saving} onPress={() => router.back()} />
        </>
      }>
      <ConnectionBanner />
      {newerOnServer || error?.code === 'profile_version_conflict' ? (
        <Banner
          tone="warning"
          title="Your profile changed elsewhere"
          body="Load the latest saved values before editing."
          action={{ label: 'Load latest', onPress: loadLatest }}
        />
      ) : null}
      {error && error.code !== 'profile_version_conflict' ? <Banner tone="danger" title="Not saved" body={error.text} /> : null}
      <View style={{ gap: space.xxl }}>
        {QUESTIONS.map(q => (
          <QuestionBlock key={q.key} question={q} compact />
        ))}
      </View>
    </Screen>
  );
}
