import type { Ref } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from 'react-native';
import { LocalSvg } from 'react-native-svg/css';

import { colors, font, HIT, space } from '@/ui/theme';

const mark = require('../../../assets/images/icon-transparent.png');
const backArrow = require('../../../assets/images/icons/back.svg');
const googleIcon = require('../../../assets/images/social/google.svg');
const appleIcon = require('../../../assets/images/social/apple.svg');

/** Small logo and wordmark centred over an optional back arrow (Sign-in, Sign-up and Q1 frames). */
export function BrandHeader({ onBack }: { onBack?: () => void }) {
  return (
    <View style={styles.header}>
      {onBack ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={8}
          onPress={onBack}
          style={({ pressed }) => [styles.back, pressed && { opacity: 0.6 }]}>
          <LocalSvg asset={backArrow} width={35} height={35} />
        </Pressable>
      ) : null}
      <View style={styles.brand} accessible accessibilityRole="header" accessibilityLabel="Orbit">
        <Image source={mark} style={styles.mark} resizeMode="contain" accessibilityIgnoresInvertColors />
        <Text style={styles.wordmark} allowFontScaling={false}>
          Orbit
        </Text>
      </View>
    </View>
  );
}

/** One segment per step; finished steps and the current one are lit. */
export function ProgressSegments({ count, current }: { count: number; current: number }) {
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={`Step ${current + 1} of ${count}`}
      accessibilityValue={{ min: 1, max: count, now: current + 1 }}
      style={styles.segments}>
      {Array.from({ length: count }, (_, i) => (
        <View key={i} style={[styles.segment, { backgroundColor: i <= current ? colors.text : colors.secondary }]} />
      ))}
    </View>
  );
}

/** Rounded button from the onboarding frames: purple for the main action, light for the alternative. */
export function PillButton({
  label,
  onPress,
  tone = 'primary',
  compact,
  disabled,
  busy,
  accessibilityHint,
}: {
  label: string;
  onPress: () => void;
  tone?: 'primary' | 'light';
  /** The shorter Continue button under a form. */
  compact?: boolean;
  disabled?: boolean;
  busy?: boolean;
  accessibilityHint?: string;
}) {
  const inactive = disabled || busy;
  const fg = tone === 'light' ? colors.background : colors.secondaryText;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: !!inactive, busy: !!busy }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [
        styles.pill,
        compact && styles.pillCompact,
        { backgroundColor: tone === 'light' ? colors.text : colors.secondary },
        { opacity: inactive ? 0.5 : pressed ? 0.85 : 1 },
      ]}>
      {busy ? (
        <ActivityIndicator color={fg} />
      ) : (
        <Text style={[compact ? styles.pillLabelCompact : styles.pillLabel, { color: fg }]} maxFontSizeMultiplier={1.4}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}

/** Labelled text input from the Sign-in and Sign-up frames. */
export function AuthField({
  label,
  error,
  style,
  ref,
  ...input
}: TextInputProps & { label: string; error?: string | null; ref?: Ref<TextInput> }) {
  return (
    <View style={styles.fieldWrap}>
      <Text style={styles.fieldLabel} maxFontSizeMultiplier={1.4}>
        {label}
      </Text>
      <TextInput
        ref={ref}
        accessibilityLabel={label}
        placeholderTextColor={colors.textMuted}
        selectionColor={colors.text}
        keyboardAppearance="dark"
        style={[styles.field, error ? { borderColor: colors.danger } : null, style]}
        {...input}
      />
      {error ? (
        <Text style={styles.fieldError} accessibilityRole="alert" maxFontSizeMultiplier={1.4}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

export function OrDivider() {
  return (
    <View style={styles.divider} accessible={false} importantForAccessibility="no-hide-descendants">
      <View style={styles.rule} />
      <Text style={styles.or}>or</Text>
      <View style={styles.rule} />
    </View>
  );
}

export function SocialButtons({ onPress }: { onPress: (provider: 'google' | 'apple') => void }) {
  return (
    <View style={{ gap: space.lg }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Sign in with Google"
        onPress={() => onPress('google')}
        style={({ pressed }) => [styles.social, styles.socialLight, pressed && { opacity: 0.85 }]}>
        <LocalSvg asset={googleIcon} width={20} height={20} />
        <Text style={[styles.socialLabel, { color: colors.socialLightText }]} maxFontSizeMultiplier={1.4}>
          Sign in with Google
        </Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Sign in with Apple"
        onPress={() => onPress('apple')}
        style={({ pressed }) => [styles.social, styles.socialDark, pressed && { opacity: 0.85 }]}>
        <LocalSvg asset={appleIcon} width={20} height={20} />
        <Text style={[styles.socialLabel, { color: colors.socialLight }]} maxFontSizeMultiplier={1.4}>
          Sign in with Apple
        </Text>
      </Pressable>
    </View>
  );
}

/** "Don't have an account? Sign Up" at the foot of the auth screens. */
export function FooterLink({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="link" onPress={onPress} hitSlop={8} style={styles.footerLink}>
      <Text style={styles.footerLinkText} maxFontSizeMultiplier={1.4}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  header: { height: HIT, justifyContent: 'center', alignItems: 'center' },
  back: { position: 'absolute', left: -space.xs, width: HIT, height: HIT, alignItems: 'center', justifyContent: 'center' },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  mark: { width: 32, height: 37 },
  wordmark: { fontFamily: font.bold, fontSize: 30, lineHeight: 38, color: colors.text },
  segments: { flexDirection: 'row', gap: 5 },
  segment: { flex: 1, height: 5, borderRadius: 3 },
  pill: { minHeight: 48, borderRadius: 15, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.xl },
  pillCompact: { minHeight: 43 },
  pillLabel: { fontFamily: font.medium, fontSize: 20 },
  pillLabelCompact: { fontFamily: font.semibold, fontSize: 16 },
  fieldWrap: { gap: space.sm },
  fieldLabel: { fontFamily: font.medium, fontSize: 14, lineHeight: 19, color: colors.text },
  field: {
    height: 50,
    paddingHorizontal: space.lg,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.fieldBorder,
    backgroundColor: colors.field,
    color: colors.text,
    fontFamily: font.medium,
    fontSize: 16,
  },
  fieldError: { fontFamily: font.medium, fontSize: 13, lineHeight: 18, color: colors.danger },
  divider: { flexDirection: 'row', alignItems: 'center', gap: space.lg },
  rule: { flex: 1, height: 1, backgroundColor: colors.text, opacity: 0.5 },
  or: { fontFamily: font.regular, fontSize: 20, lineHeight: 26, color: '#FFFFFF' },
  social: {
    minHeight: HIT,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingHorizontal: space.lg,
    paddingVertical: 10,
    borderRadius: 8,
  },
  socialLight: { backgroundColor: colors.socialLight, borderWidth: 1, borderColor: colors.socialLightBorder },
  socialDark: { backgroundColor: colors.socialDark },
  socialLabel: { fontFamily: font.semibold, fontSize: 16, lineHeight: 24 },
  footerLink: { alignSelf: 'center', minHeight: HIT, justifyContent: 'center' },
  footerLinkText: { fontFamily: font.medium, fontSize: 15, color: colors.textSubtle, textDecorationLine: 'underline' },
});
