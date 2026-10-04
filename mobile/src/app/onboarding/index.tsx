import { useRouter } from 'expo-router';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

import { PillButton } from '@/features/onboarding/ui';
import { Screen } from '@/ui/components';
import { colors, font, space } from '@/ui/theme';

const mark = require('../../../assets/images/icon-transparent.png');
const phones = require('../../../assets/images/onboarding/welcome-phones.png');

/** The Welcome frame. */
export default function WelcomeScreen() {
  const router = useRouter();

  return (
    <Screen
      scroll={false}
      footerBorder={false}
      footer={
        <View style={styles.actions}>
          <PillButton label="Sign In" tone="light" onPress={() => router.push('/onboarding/sign-in')} />
          <PillButton label="Sign Up" onPress={() => router.push('/onboarding/sign-up')} />
        </View>
      }>
      <View style={styles.top}>
        {/* Long-press the mark for connection diagnostics while there is no Menu tab yet. */}
        <Pressable
          onLongPress={() => router.push('/diagnostics')}
          accessibilityRole="image"
          accessibilityLabel="Orbit"
          accessibilityHint="Long press for connection diagnostics">
          <Image source={mark} style={styles.mark} resizeMode="contain" accessibilityIgnoresInvertColors />
        </Pressable>
        <Text style={styles.title} accessibilityRole="header" maxFontSizeMultiplier={1.3}>
          Start your Financial Life
        </Text>
      </View>
      <View style={styles.art}>
        <Image
          source={phones}
          style={styles.phones}
          resizeMode="contain"
          accessibilityLabel="Orbit's stock and Discover screens"
          accessibilityIgnoresInvertColors
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  top: { alignItems: 'center', gap: space.xl },
  mark: { width: 72, height: 84 },
  title: {
    maxWidth: 282,
    textAlign: 'center',
    fontFamily: font.semibold,
    fontSize: 35,
    lineHeight: 48,
    color: colors.text,
  },
  // The phones bleed to the screen edges, as in the frame.
  art: { flex: 1, marginHorizontal: -space.xl, justifyContent: 'center' },
  phones: { width: '100%', height: '100%' },
  actions: { paddingHorizontal: space.xl, paddingBottom: space.sm, gap: 22 },
});
