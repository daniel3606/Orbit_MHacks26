import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { useLayoutEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { PillButton } from '@/features/onboarding/ui';
import { QuestionBlock, QUESTIONS } from '@/features/onboarding/questions';
import { updatePreferences } from '@/features/profile/actions';
import { ConnectionBanner } from '@/features/session/ConnectionBanner';
import type { RealtimeSnapshot } from '@/realtime/connection';
import { messageFor, toAppError } from '@/realtime/errors';
import { useRealtime } from '@/realtime/hooks';
import { draftFromProfile, useDraft, validateDraft, type Draft } from '@/state/onboarding-draft';
import { Banner, Screen } from '@/ui/components';
import { colors, font, HIT, space } from '@/ui/theme';

const backIcon = require('../../assets/icon/arrow-back.svg');

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
      edges={['top', 'bottom']}
      header={
        <View style={styles.nav}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back"
            accessibilityHint={dirty ? 'Discards your changes' : undefined}
            onPress={() => router.back()}
            disabled={saving}
            hitSlop={8}
            style={({ pressed }) => [styles.navButton, pressed && styles.pressed]}>
            <Image source={backIcon} style={styles.backIcon} contentFit="contain" accessible={false} />
          </Pressable>
          <Text style={styles.title} accessibilityRole="header">
            Edit preferences
          </Text>
          <View style={styles.navButton} />
        </View>
      }
      footerBorder={false}
      footer={<PillButton label="Save changes" compact busy={saving} disabled={!live || !dirty} onPress={save} />}>
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
      <View style={styles.questions}>
        {QUESTIONS.map(q => (
          <QuestionBlock key={q.key} question={q} compact />
        ))}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  nav: {
    minHeight: HIT,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginHorizontal: -space.sm,
  },
  navButton: { width: HIT, height: HIT, alignItems: 'center', justifyContent: 'center' },
  backIcon: { width: 35, height: 35 },
  pressed: { opacity: 0.7 },
  title: { fontFamily: font.semibold, fontSize: 17, lineHeight: 22, color: colors.text },
  questions: { gap: space.xxl },
});
