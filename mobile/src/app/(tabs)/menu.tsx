import { useRouter, type Href } from 'expo-router';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { realtime } from '@/realtime/connection';
import { useIsLive } from '@/realtime/hooks';
import { Avatar } from '@/ui/Avatar';
import { Screen } from '@/ui/components';
import { ListCard } from '@/ui/ListCard';
import { colors, font, HIT, space } from '@/ui/theme';

type Item = {
  title: string;
  detail: string;
  /** Where the row goes. Rows without one aren't built yet. */
  href?: Href;
  /** Needs a live connection (it writes to the server). */
  live?: boolean;
};

const ITEMS: Item[] = [
  { title: 'General', detail: 'Notifications, account' },
  { title: 'Support', detail: 'Help Center, contact', href: '/diagnostics' },
  { title: 'Investing', detail: 'Risk, goals, sectors you follow', href: '/edit-preferences', live: true },
  { title: 'History', detail: 'Activity across your account' },
  { title: 'Report & Statements', detail: 'Account activity reports, statements' },
  { title: 'Tax Center', detail: 'Tax documents, FAQs' },
  { title: 'Security & Privacy', detail: 'Password, device security, data saving' },
];

function Chevron() {
  return (
    <Svg width={7} height={12} viewBox="0 0 7 12">
      <Path
        d="M1 1l5 5-5 5"
        stroke={colors.textMuted}
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </Svg>
  );
}

function MenuRow({ item, disabled, onPress }: { item: Item; disabled: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${item.title}. ${item.detail}`}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.row, { opacity: disabled ? 0.4 : pressed ? 0.62 : 1 }]}>
      <View style={styles.rowText}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {item.title}
        </Text>
        <Text style={styles.rowDetail} numberOfLines={1}>
          {item.detail}
        </Text>
      </View>
      <Chevron />
    </Pressable>
  );
}

export default function MenuScreen() {
  const router = useRouter();
  const live = useIsLive();

  function open(item: Item) {
    if (item.href) router.push(item.href);
    else Alert.alert(item.title, 'This section is coming soon.');
  }

  // Accounts aren't connected yet, so "Log Out" leaves this device's guest
  // session, which can't be undone.
  function confirmLogOut() {
    Alert.alert(
      'Log out?',
      'You’re using a guest session on this device. Logging out starts over with a new one, and your current profile and practice trades can’t be recovered.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Log Out', style: 'destructive', onPress: () => void realtime.resetGuestSession() },
      ]
    );
  }

  return (
    <Screen edges={['top']}>
      <Text style={styles.title} accessibilityRole="header">
        Menu
      </Text>

      <View style={styles.profile}>
        {/* No profile photos yet; Avatar shows the empty state until one exists. */}
        <Avatar uri={null} />
        {/* Guest sessions have no email until accounts are connected. */}
        <View style={styles.identity}>
          <Text style={styles.name}>Guest</Text>
          <Text style={styles.session}>Signed in on this device</Text>
        </View>
      </View>

      <ListCard>
        {ITEMS.map(item => (
          <MenuRow key={item.title} item={item} disabled={!!item.live && !live} onPress={() => open(item)} />
        ))}
      </ListCard>

      <Pressable
        accessibilityRole="button"
        onPress={confirmLogOut}
        style={({ pressed }) => [styles.logOut, pressed && { opacity: 0.62 }]}>
        <Text style={styles.logOutLabel}>Log Out</Text>
      </Pressable>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontFamily: font.semibold, fontSize: 24, lineHeight: 32, color: colors.text },
  profile: { alignItems: 'center', gap: space.md, marginTop: space.sm, marginBottom: space.sm },
  identity: { alignItems: 'center', gap: 2 },
  name: { fontFamily: font.semibold, fontSize: 18, lineHeight: 24, color: colors.text },
  session: { fontFamily: font.regular, fontSize: 13, lineHeight: 18, color: colors.textMuted },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.lg, minHeight: HIT },
  rowText: { flex: 1, gap: 2 },
  rowTitle: { fontFamily: font.semibold, fontSize: 16, lineHeight: 21, color: colors.text },
  rowDetail: { fontFamily: font.regular, fontSize: 13, lineHeight: 17, color: colors.textMuted },
  logOut: {
    alignSelf: 'center',
    width: 261,
    minHeight: HIT + 4,
    marginTop: space.sm,
    borderWidth: 1.5,
    borderColor: colors.textSubtle,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logOutLabel: { fontFamily: font.medium, fontSize: 16, lineHeight: 21, color: colors.textSubtle },
});
