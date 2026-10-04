import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

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

/**
 * The Sign-in and Sign-up frames. Accounts aren't connected yet (OIDC is still
 * to come), so every route here continues with this device's guest session and
 * nothing typed is stored or sent.
 */
export function AuthScreen({ mode }: { mode: Mode }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const passwordRef = useRef<TextInput>(null);
  const confirmRef = useRef<TextInput>(null);
  const signUp = mode === 'sign-up';
  const errors = submitted ? check(mode, email, password, confirm) : {};

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
          label={signUp ? 'Already have an account? Sign In' : 'Don’t have an account? Sign Up'}
          onPress={() => router.replace(signUp ? '/onboarding/sign-in' : '/onboarding/sign-up')}
        />
      }>
      <Text style={styles.title} accessibilityRole="header" maxFontSizeMultiplier={1.3}>
        {signUp ? 'Welcome to Orbit!' : 'Welcome Back!'}
      </Text>

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
            label="Password again"
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
          <PillButton label="Continue" compact onPress={submit} />
        </View>
      </View>

      <OrDivider />
      <SocialButtons onPress={proceed} />

      <T variant="caption" muted style={styles.note}>
        Accounts aren’t connected in this build yet. Orbit keeps your profile on this device.
      </T>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: {
    textAlign: 'center',
    fontFamily: font.semibold,
    fontSize: 38,
    lineHeight: 52,
    color: colors.text,
    marginTop: space.lg,
    marginBottom: space.md,
  },
  form: { gap: space.lg },
  continue: { paddingHorizontal: space.xs, paddingTop: space.sm },
  note: { textAlign: 'center' },
});
