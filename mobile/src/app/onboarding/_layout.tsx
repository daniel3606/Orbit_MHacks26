import { Stack } from 'expo-router';

import { colors } from '@/ui/theme';

/** Welcome → Sign in / Sign up → questionnaire. Shown only while there is no profile. */
export default function OnboardingLayout() {
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }} />;
}
