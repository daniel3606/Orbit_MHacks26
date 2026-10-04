import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import Animated, { FadeInDown, useReducedMotion } from 'react-native-reanimated';

import { Screen, T } from '@/ui/components';
import { colors, font, space } from '@/ui/theme';
import { AuthField, BrandHeader, FooterLink, OrDivider, PillButton, SocialButtons } from './ui';

const MIN_PASSWORD = 8;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Mode = 'sign-in' | 'sign-up';
type Errors = { email?: string; password?: string; confirm?: string };

function check(mode: Mode, email: string, password: string, confirm: string): Errors {
  const errors: Errors = {};
  if (!EMAIL.test(email.trim())) errors.email = 'Enter a valid email address.';
  if (mode === 'sign-up' && password.length < MIN_PASSWORD) errors.password = `Use at least ${MIN_PASSWORD} characters.`;
  if (mode === 'sign-in' && password.length === 0) errors.password = 'Enter your password.';
  if (mode === 'sign-up' && confirm !== password) errors.confirm = 'Passwords don’t match.';
  return errors;
}

const COPY: Record<Mode, { title: string; subtitle: string }> = {
  'sign-in': {
    title: 'Welcome back',
    subtitle: 'Sign in to continue building your investing profile.',
  },
  'sign-up': {
    title: 'Create your account',
    subtitle: 'A few details now — personalization comes next.',
  },
};

/**
 * The Sign-in and Sign-up frames. Accounts aren't connected yet (OIDC is still
 * to come), so every route here continues with this device's guest session and
 * nothing typed is stored or sent.
 */
export function AuthScreen({ mode }: { mode: Mode }) {
  const router = useRouter();
  const reduceMotion = useReducedMotion();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const passwordRef = useRef<TextInput>(null);
  const confirmRef = useRef<TextInput>(null);
  const signUp = mode === 'sign-up';
  const errors = submitted ? check(mode, email, password, confirm) : {};
  const copy = COPY[mode];

  function proceed() {
    router.push('/onboarding/questions');
  }

  function submit() {
    setSubmitted(true);
    if (Object.keys(check(mode, email, password, confirm)).length === 0) proceed();
  }

  return (
    <Screen
      header={<BrandHeader onBack={() => router.back()} />}
      footerBorder={false}
      footer={
        <FooterLink
          prompt={signUp ? 'Already have an account?' : 'Don’t have an account?'}
          action={signUp ? 'Sign In' : 'Sign Up'}
          onPress={() => router.replace(signUp ? '/onboarding/sign-in' : '/onboarding/sign-up')}
        />
      }>
      <Animated.View entering={reduceMotion ? undefined : FadeInDown.duration(360)} style={styles.body}>
        <View style={styles.heading}>
          <Text style={styles.title} accessibilityRole="header" maxFontSizeMultiplier={1.3}>
            {copy.title}
          </Text>
          <Text style={styles.subtitle} maxFontSizeMultiplier={1.4}>
            {copy.subtitle}
          </Text>
        </View>

        <View style={styles.form}>
          <AuthField
            label="Email"
            value={email}
            onChangeText={setEmail}
            error={errors.email}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            textContentType="emailAddress"
            autoComplete="email"
            returnKeyType="next"
            submitBehavior="submit"
            onSubmitEditing={() => passwordRef.current?.focus()}
          />
          <AuthField
            ref={passwordRef}
            label="Password"
            value={password}
            onChangeText={setPassword}
            error={errors.password}
            secureTextEntry
            // No real account is created, so don't offer to save or generate a password.
            textContentType="none"
            autoComplete="off"
            returnKeyType={signUp ? 'next' : 'go'}
            submitBehavior={signUp ? 'submit' : 'blurAndSubmit'}
            onSubmitEditing={() => (signUp ? confirmRef.current?.focus() : submit())}
          />
          {signUp ? (
            <AuthField
              ref={confirmRef}
              label="Confirm password"
              value={confirm}
              onChangeText={setConfirm}
              error={errors.confirm}
              secureTextEntry
              textContentType="none"
              autoComplete="off"
              returnKeyType="go"
              onSubmitEditing={submit}
            />
          ) : null}
          <View style={styles.continue}>
            <PillButton label="Continue" onPress={submit} />
          </View>
        </View>

        <OrDivider />
        <SocialButtons mode={mode} onPress={proceed} />

        <T variant="caption" muted style={styles.note}>
          Accounts aren’t connected in this build yet. Orbit keeps your profile on this device.
        </T>
      </Animated.View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { gap: space.xl },
  heading: { alignItems: 'center', gap: space.sm, marginTop: space.sm, marginBottom: space.xs },
  title: {
    textAlign: 'center',
    fontFamily: font.semibold,
    fontSize: 30,
    lineHeight: 36,
    color: colors.text,
    letterSpacing: -0.5,
  },
  subtitle: {
    maxWidth: 300,
    textAlign: 'center',
    fontFamily: font.regular,
    fontSize: 15,
    lineHeight: 21,
    color: colors.textMuted,
  },
  form: { gap: space.lg },
  continue: { paddingTop: space.xs },
  note: { textAlign: 'center', paddingHorizontal: space.md },
});
