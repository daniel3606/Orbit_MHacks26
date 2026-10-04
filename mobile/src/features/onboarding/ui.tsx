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

import { colors, font, HIT, radius, space, type } from '@/ui/theme';

const mark = require('../../../assets/images/icon-transparent.png');
const backArrow = require('../../../assets/images/icons/back.svg');
const googleIcon = require('../../../assets/images/social/google.svg');
const appleIcon = require('../../../assets/images/social/apple.svg');

/** Control height shared by auth fields, social buttons, and primary CTAs. */
export const CONTROL_HEIGHT = 52;

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
          style={({ pressed }) => [styles.back, pressed && styles.pressed]}>
          <LocalSvg asset={backArrow} width={28} height={28} />
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
        <View
          key={i}
          style={[styles.segment, { backgroundColor: i <= current ? colors.text : 'rgba(227, 227, 227, 0.16)' }]}
        />
      ))}
    </View>
  );
}

/** Rounded button from the onboarding frames: purple for the main action, light for the alternative. */
export function PillButton({
  label,
  onPress,
  tone = 'primary',
  disabled,
  busy,
  accessibilityHint,
}: {
  label: string;
  onPress: () => void;
  tone?: 'primary' | 'light';
  /** @deprecated Kept for callers; all pills share one control height. */
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
        { backgroundColor: tone === 'light' ? colors.text : colors.secondary },
        { opacity: inactive ? 0.45 : pressed ? 0.88 : 1 },
      ]}>
      {busy ? (
        <ActivityIndicator color={fg} />
      ) : (
        <Text style={[styles.pillLabel, { color: fg }]} maxFontSizeMultiplier={1.4}>
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
        style={[styles.field, error ? styles.fieldInvalid : null, style]}
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

export function SocialButtons({
  mode = 'sign-in',
  onPress,
}: {
  mode?: 'sign-in' | 'sign-up';
  onPress: (provider: 'google' | 'apple') => void;
}) {
  const verb = mode === 'sign-up' ? 'Sign up' : 'Sign in';
  return (
    <View style={styles.socialStack}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${verb} with Google`}
        onPress={() => onPress('google')}
        style={({ pressed }) => [styles.social, styles.socialLight, pressed && styles.pressed]}>
        <LocalSvg asset={googleIcon} width={18} height={18} />
        <Text style={[styles.socialLabel, { color: colors.socialLightText }]} maxFontSizeMultiplier={1.4}>
          {verb} with Google
        </Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${verb} with Apple`}
        onPress={() => onPress('apple')}
        style={({ pressed }) => [styles.social, styles.socialDark, pressed && styles.pressed]}>
        <LocalSvg asset={appleIcon} width={18} height={18} />
        <Text style={[styles.socialLabel, { color: colors.socialLight }]} maxFontSizeMultiplier={1.4}>
          {verb} with Apple
        </Text>
      </Pressable>
    </View>
  );
}

/** "Don't have an account? Sign Up" at the foot of the auth screens. */
export function FooterLink({
  prompt,
  action,
  onPress,
}: {
  prompt: string;
  action: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`${prompt} ${action}`}
      onPress={onPress}
      hitSlop={8}
      style={({ pressed }) => [styles.footerLink, pressed && styles.pressed]}>
      <Text style={styles.footerPrompt} maxFontSizeMultiplier={1.4}>
        {prompt}{' '}
        <Text style={styles.footerAction}>{action}</Text>
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  header: { height: HIT, justifyContent: 'center', alignItems: 'center' },
  back: {
    position: 'absolute',
    left: -space.sm,
    width: HIT,
    height: HIT,
    alignItems: 'center',
    justifyContent: 'center',
  },
  brand: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  mark: { width: 28, height: 32 },
  wordmark: { fontFamily: font.bold, fontSize: 26, lineHeight: 32, color: colors.text, letterSpacing: -0.3 },
  segments: { flexDirection: 'row', gap: 6, paddingTop: space.xs },
  segment: { flex: 1, height: 3, borderRadius: 2 },
  pill: {
    minHeight: CONTROL_HEIGHT,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.xl,
  },
  pillLabel: { ...type.label, fontFamily: font.semibold, fontSize: 17, lineHeight: 22 },
  fieldWrap: { gap: space.sm },
  fieldLabel: { fontFamily: font.medium, fontSize: 14, lineHeight: 18, color: colors.text },
  field: {
    height: CONTROL_HEIGHT,
    paddingHorizontal: space.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.fieldBorder,
    backgroundColor: colors.field,
    color: colors.text,
    fontFamily: font.medium,
    fontSize: 16,
    lineHeight: 22,
  },
  fieldInvalid: { borderColor: colors.danger },
  fieldError: { fontFamily: font.medium, fontSize: 13, lineHeight: 18, color: colors.danger },
  divider: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  rule: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: colors.text, opacity: 0.22 },
  or: { ...type.caption, color: colors.textMuted, textTransform: 'lowercase' },
  socialStack: { gap: space.md },
  social: {
    minHeight: CONTROL_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm + 2,
    paddingHorizontal: space.lg,
    borderRadius: radius.md,
  },
  socialLight: { backgroundColor: colors.socialLight, borderWidth: 1, borderColor: colors.socialLightBorder },
  socialDark: { backgroundColor: colors.socialDark, borderWidth: 1, borderColor: 'rgba(227, 227, 227, 0.22)' },
  socialLabel: { fontFamily: font.semibold, fontSize: 16, lineHeight: 22 },
  footerLink: {
    alignSelf: 'center',
    minHeight: HIT,
    justifyContent: 'center',
    paddingHorizontal: space.md,
  },
  footerPrompt: { fontFamily: font.regular, fontSize: 15, lineHeight: 20, color: colors.textMuted, textAlign: 'center' },
  footerAction: { fontFamily: font.semibold, color: colors.text, textDecorationLine: 'underline' },
  pressed: { opacity: 0.72 },
});
