import { Image } from 'expo-image';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { markAllNotificationsRead, markNotificationRead } from '@/features/profile/actions';
import { ConnectionBanner } from '@/features/session/ConnectionBanner';
import type { NotificationVM } from '@/realtime/connection';
import { useRealtime } from '@/realtime/hooks';
import { Screen } from '@/ui/components';
import { colors, font, HIT, space } from '@/ui/theme';

const backIcon = require('../../../assets/icon/arrow-back.svg');

function relativeTime(at: Date, now = new Date()): string {
  const seconds = Math.max(0, Math.floor((now.getTime() - at.getTime()) / 1000));
  if (seconds < 60) return 'Just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function openHref(router: ReturnType<typeof useRouter>, href: string | null, ticker: string | null) {
  if (ticker) {
    router.push({ pathname: '/stock/[ticker]', params: { ticker } });
    return;
  }
  if (!href || href === '/') {
    router.replace('/');
    return;
  }
  if (href === '/discover') {
    router.replace('/discover');
    return;
  }
  if (href === '/portfolio') {
    router.replace('/portfolio');
    return;
  }
  router.back();
}

function NotificationRow({
  item,
  onPress,
}: {
  item: NotificationVM;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${item.read ? '' : 'Unread. '}${item.title}. ${item.body}`}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
      <View style={styles.rowMain}>
        <View style={styles.titleRow}>
          {!item.read ? <View style={styles.unreadDot} accessibilityElementsHidden /> : null}
          <Text style={[styles.rowTitle, item.read && styles.rowTitleRead]} numberOfLines={1}>
            {item.title}
          </Text>
          <Text style={styles.when}>{relativeTime(item.createdAt)}</Text>
        </View>
        <Text style={styles.rowBody} numberOfLines={3}>
          {item.body}
        </Text>
      </View>
    </Pressable>
  );
}

export default function NotificationsScreen() {
  const router = useRouter();
  const rt = useRealtime();
  const notifications = rt.notifications;

  // Opening the inbox clears the home-tab bell badge, like other brokerage apps.
  useFocusEffect(
    useCallback(() => {
      if (!rt.notifications.some(item => !item.read)) return;
      void markAllNotificationsRead().catch(() => undefined);
    }, [rt.notifications])
  );

  async function openItem(item: NotificationVM) {
    if (!item.read) {
      try {
        await markNotificationRead(item.id);
      } catch {
        // Navigation still works if the mark-read call fails.
      }
    }
    openHref(router, item.href, item.ticker);
  }

  return (
    <Screen
      edges={['top']}
      header={
        <View style={styles.nav}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back"
            onPress={() => router.back()}
            hitSlop={8}
            style={({ pressed }) => [styles.navButton, pressed && styles.pressed]}>
            <Image source={backIcon} style={styles.backIcon} contentFit="contain" accessible={false} />
          </Pressable>
          <Text style={styles.title} accessibilityRole="header">
            Notifications
          </Text>
          <View style={styles.navButton} />
        </View>
      }>
      <ConnectionBanner />
      {notifications.length === 0 ? (
        <Text style={styles.empty}>
          Order fills, today’s brief, and Daily Discovery will show up here.
        </Text>
      ) : (
        notifications.map(item => (
          <NotificationRow key={item.id} item={item} onPress={() => void openItem(item)} />
        ))
      )}
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
  empty: {
    fontFamily: font.regular,
    fontSize: 15,
    lineHeight: 22,
    color: colors.textMuted,
    marginTop: space.lg,
  },
  row: {
    paddingVertical: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  rowMain: { gap: space.xs },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  unreadDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#FF3B30',
  },
  rowTitle: {
    flex: 1,
    fontFamily: font.semibold,
    fontSize: 15,
    lineHeight: 20,
    color: colors.text,
  },
  rowTitleRead: { fontFamily: font.medium, color: colors.textMuted },
  when: { fontFamily: font.regular, fontSize: 12, lineHeight: 16, color: colors.textMuted },
  rowBody: { fontFamily: font.regular, fontSize: 14, lineHeight: 20, color: colors.textMuted },
});
