import { BlurView } from 'expo-blur';
import { Image } from 'expo-image';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, {
  Easing,
  interpolate,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { scheduleOnRN } from 'react-native-worklets';

import { formatShares, money, signedPct, stamp } from '@/features/market/format';
import { createPaperOrder } from '@/features/profile/actions';
import { realtime, type PaperOrderVM } from '@/realtime/connection';
import { AppError, messageFor } from '@/realtime/errors';
import { useRealtime } from '@/realtime/hooks';
import { Odometer, RollingText } from '@/ui/RollingNumber';
import { StarField } from '@/ui/StarField';
import { backgroundGradient, colors, font, HIT, space } from '@/ui/theme';

import {
  addCents,
  centsLabel,
  centsToMicros,
  clientOrderKey,
  entryCents,
  entryLabel,
  microsToNumber,
  pressKey,
  type Key,
} from './ticket';

const closeIcon = require('../../../assets/icon/close.svg');
const backspaceIcon = require('../../../assets/icon/backspace.svg');
const swipeIcon = require('../../../assets/icon/swipe-up.svg');


/** Room under the card for the swipe prompt, above the home indicator. */
const PROMPT_HEIGHT = 92;
/** How far the finger must travel before letting go places the order. */
const COMMIT_DISTANCE = 150;
/** The card itself only rises this far; the rest of the drag is felt, not seen. */
const MAX_LIFT = 68;
/** Lift at which the card is fully veiled. Most of the fade happens early in the drag. */
const VEIL_LIFT = 45;
const DROP_BACK = { duration: 260, easing: Easing.out(Easing.cubic) };

const AnimatedBlurView = Animated.createAnimatedComponent(BlurView);

/** Benchmarked against Polymarket's ticket: ~56pt cap height on a 393pt-wide phone. */
const AMOUNT_SIZE = 78;
const AMOUNT_MIN_SIZE = 40;
const AMOUNT_PADDING = 40;
const SHARES_LINE = 26;

/** Largest size that keeps the amount on one line. Widths are Manrope Bold advances per em. */
function amountSize(text: string, width: number): number {
  const ems = [...text].reduce((sum, ch) => sum + (ch === ',' || ch === '.' ? 0.3 : 0.62), 0);
  return Math.max(AMOUNT_MIN_SIZE, Math.min(AMOUNT_SIZE, Math.floor((width - AMOUNT_PADDING * 2) / ems)));
}

const KEY_ROWS: Key[][] = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
  ['.', '0', 'back'],
];

type Phase = 'edit' | 'sending' | 'sent' | 'failed';

/** What went to the server, frozen at the moment of the swipe. */
type Placed = { key: string; cents: number; quantityMicros: string | null; price: number };

function tick() {
  try {
    void Haptics.selectionAsync();
  } catch {
    // Haptics are optional.
  }
}

function buzz(kind: Haptics.NotificationFeedbackType) {
  try {
    void Haptics.notificationAsync(kind);
  } catch {
    // Haptics are optional.
  }
}

function outcome(
  phase: Phase,
  order: PaperOrderVM | undefined,
  error: string | null,
  marketOpen: boolean | null,
  nextOpen: Date | null,
): { title: string; detail: string; settled: boolean; failed: boolean } {
  if (phase === 'failed') return { title: 'Order Not Placed', detail: error ?? 'Something went wrong.', settled: true, failed: true };
  if (!order || order.status === 'queued' || order.status === 'submitting') {
    return { title: 'Placing Order…', detail: 'Sending it to your practice account.', settled: false, failed: false };
  }
  switch (order.status) {
    case 'filled':
      return {
        title: 'Order Filled',
        detail: order.filledAvgPriceMicros
          ? `Filled at an average of ${money(microsToNumber(order.filledAvgPriceMicros) ?? 0)} a share.`
          : 'Filled on your practice account.',
        settled: true,
        failed: false,
      };
    case 'partially_filled':
      return {
        title: 'Partly Filled',
        detail: `${formatShares(order.filledQuantityMicros)} shares have filled. The rest is still open.`,
        settled: true,
        failed: false,
      };
    case 'rejected':
      return {
        title: 'Order Rejected',
        detail: order.rejectReason ? messageFor(order.rejectReason) : 'Nothing was bought or sold.',
        settled: true,
        failed: true,
      };
    case 'canceled':
      return { title: 'Order Canceled', detail: 'Nothing was bought or sold.', settled: true, failed: true };
    case 'reconciling':
      return { title: 'Checking Order…', detail: 'Confirming this order with the broker.', settled: false, failed: false };
    default:
      return {
        title: 'Order Placed',
        detail:
          marketOpen === false
            ? `The market is closed. It will fill after the open${nextOpen ? `, ${stamp(nextOpen)}` : ''}.`
            : 'Accepted and waiting to fill.',
        settled: true,
        failed: false,
      };
  }
}

export default function TradeTicket() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const params = useLocalSearchParams<{ ticker: string; side: string }>();
  const ticker = typeof params.ticker === 'string' ? params.ticker : '';
  const side: 'buy' | 'sell' = params.side === 'sell' ? 'sell' : 'buy';
  const rt = useRealtime();
  useFocusEffect(useCallback(() => realtime.acquireMarket(), []));

  const [entry, setEntry] = useState('');
  const [sellAll, setSellAll] = useState(false);
  const [phase, setPhase] = useState<Phase>('edit');
  const [placed, setPlaced] = useState<Placed | null>(null);
  const [error, setError] = useState<string | null>(null);

  const stock = rt.market.stocks.find(row => row.ticker === ticker);
  const quote = rt.market.quotes[ticker];
  const price = quote?.price ?? null;
  const position = rt.paperPositions.find(row => row.ticker === ticker);
  const heldShares = microsToNumber(position?.quantityMicros) ?? 0;
  const cash = microsToNumber(rt.paperAccount?.cashMicros);
  const name = stock?.name ? `${stock.name} (${ticker})` : ticker;
  const verb = side === 'buy' ? 'buy' : 'sell';

  const cents = sellAll && price != null ? Math.floor(heldShares * price * 100) : entryCents(entry);
  const shares = price ? cents / 100 / price : null;
  const heldValue = price != null ? heldShares * price : null;

  const blocker = (() => {
    if (!rt.paperEnabled) return 'Practice trading is off for this account';
    if (!quote || price == null) return 'No price to trade against yet';
    if (rt.status !== 'ready' || rt.stale) return 'Reconnect to place an order';
    if (side === 'sell' && !position) return `You don’t hold ${ticker}`;
    if (cents <= 0) return 'Enter an amount';
    if (!sellAll && cents < 100) return 'The minimum is $1';
    if (side === 'buy' && cash != null && cents / 100 > cash) return 'More than your available cash';
    if (side === 'sell' && !sellAll && heldValue != null && cents / 100 > heldValue) return `More than the ${ticker} you hold`;
    return null;
  })();
  const ready = blocker === null;
  const overLimit =
    (side === 'buy' && cash != null && cents / 100 > cash) ||
    (side === 'sell' && !sellAll && heldValue != null && cents / 100 > heldValue);

  const order = placed ? rt.paperOrders.find(row => row.clientOrderKey === placed.key) : undefined;
  const result = outcome(phase, order, error, rt.paperAccount?.marketOpen ?? null, rt.paperAccount?.nextOpen ?? null);

  // The card slides off the top to reveal the confirmation underneath.
  const lift = useSharedValue(0);
  const armed = useSharedValue(false);
  const reveal = useSharedValue(0);
  const bob = useSharedValue(0);
  // Digits rise as the amount grows and fall as it shrinks.
  const roll = useSharedValue(1);

  useEffect(() => {
    const ease = { duration: 700, easing: Easing.inOut(Easing.quad) };
    bob.set(withRepeat(withSequence(withTiming(-5, ease), withTiming(0, ease)), -1));
  }, [bob]);

  const lastStatus = order?.status;
  useEffect(() => {
    if (phase !== 'sent' || !lastStatus) return;
    if (lastStatus === 'rejected' || lastStatus === 'canceled') buzz(Haptics.NotificationFeedbackType.Error);
    else if (lastStatus !== 'queued' && lastStatus !== 'submitting') buzz(Haptics.NotificationFeedbackType.Success);
  }, [phase, lastStatus]);

  const submit = useCallback(async () => {
    if (!quote || price == null) return;
    const key = clientOrderKey();
    const quantityMicros = sellAll && position ? position.quantityMicros : null;
    setPlaced({ key, cents, quantityMicros, price });
    setError(null);
    setPhase('sending');
    reveal.set(withDelay(180, withTiming(1, { duration: 320 })));
    try {
      await createPaperOrder({
        ticker,
        side,
        quantityMicros: quantityMicros ? BigInt(quantityMicros) : undefined,
        notionalMicros: quantityMicros ? undefined : centsToMicros(cents),
        clientOrderKey: key,
        quoteMicros: BigInt(quote.priceMicros),
        quoteTime: quote.providerTime,
      });
      setPhase('sent');
    } catch (err) {
      setError(messageFor(err instanceof AppError ? err.code : 'unexpected_error'));
      setPhase('failed');
      buzz(Haptics.NotificationFeedbackType.Error);
    }
  }, [cents, position, price, quote, reveal, sellAll, side, ticker]);

  function editAgain() {
    setPhase('edit');
    setPlaced(null);
    setError(null);
    reveal.set(withTiming(0, { duration: 160 }));
    lift.set(withTiming(0, DROP_BACK));
  }

  const pan = Gesture.Pan()
    // A blocked order does not move at all; the prompt already says why.
    .enabled(phase === 'edit' && ready)
    .activeOffsetY(-12)
    .failOffsetX([-30, 30])
    .onUpdate(event => {
      const up = Math.max(0, -event.translationY);
      // Eases toward MAX_LIFT so a long drag never pulls the card far.
      lift.set(-MAX_LIFT * (1 - Math.exp(-up / VEIL_LIFT)));
      const isArmed = up > COMMIT_DISTANCE;
      if (isArmed !== armed.get()) {
        armed.set(isArmed);
        scheduleOnRN(tick);
      }
    })
    .onEnd(event => {
      const up = -event.translationY;
      const flung = event.velocityY < -900 && up > 48;
      armed.set(false);
      if (up > COMMIT_DISTANCE || flung) {
        lift.set(withTiming(-height, { duration: 360, easing: Easing.out(Easing.cubic) }));
        scheduleOnRN(submit);
        return;
      }
      // Straight back down, no bounce.
      lift.set(withTiming(0, DROP_BACK));
    });

  const cardStyle = useAnimatedStyle(() => ({ transform: [{ translateY: lift.get() }] }));
  // 0 at rest, 1 once the card has risen VEIL_LIFT.
  const veilOf = (value: number) => {
    'worklet';
    return interpolate(value, [-VEIL_LIFT, 0], [1, 0], 'clamp');
  };
  const contentStyle = useAnimatedStyle(() => ({ opacity: interpolate(veilOf(lift.get()), [0, 1], [1, 0.45]) }));
  const blurProps = useAnimatedProps(() => ({ intensity: interpolate(veilOf(lift.get()), [0, 1], [0, 45]) }));
  const promptStyle = useAnimatedStyle(() => ({
    // Follows the card halfway, then fades once the card leaves for good.
    opacity: interpolate(lift.get(), [-MAX_LIFT - 60, -MAX_LIFT - 10], [0, 1], 'clamp'),
    transform: [{ translateY: Math.max(lift.get(), -MAX_LIFT) * 0.5 }],
  }));
  const restingNoteStyle = useAnimatedStyle(() => ({ opacity: 1 - veilOf(lift.get()) }));
  const draggingNoteStyle = useAnimatedStyle(() => ({ opacity: veilOf(lift.get()) }));
  const chevronStyle = useAnimatedStyle(() => ({ transform: [{ translateY: ready ? bob.get() : 0 }] }));
  const confirmStyle = useAnimatedStyle(() => ({
    opacity: reveal.get(),
    transform: [{ translateY: interpolate(reveal.get(), [0, 1], [12, 0]) }],
  }));

  function onKey(key: Key) {
    tick();
    roll.set(key === 'back' ? -1 : 1);
    if (sellAll) {
      setSellAll(false);
      setEntry(key === 'back' ? '' : pressKey('', key));
      return;
    }
    setEntry(current => pressKey(current, key));
  }

  function onQuick(kind: 'add25' | 'add100' | 'share' | 'all') {
    tick();
    roll.set(1);
    if (kind === 'all') {
      setSellAll(true);
      return;
    }
    const base = sellAll ? '' : entry;
    setSellAll(false);
    if (kind === 'share') {
      if (price != null) setEntry(addCents(base, price * 100));
      return;
    }
    setEntry(addCents(base, kind === 'add25' ? 2500 : 10000));
  }

  const dayChange = quote && quote.previousClose > 0 ? quote.price / quote.previousClose - 1 : null;
  const availableLine =
    !rt.paperEnabled
      ? 'No practice account connected'
      : side === 'buy'
      ? cash != null
        ? `${money(cash)} Available`
        : 'Cash not synced yet'
      : position
        ? `${formatShares(position.quantityMicros)} shares${heldValue != null ? ` · ${money(heldValue)}` : ''} Available`
        : 'No shares to sell';
  const sharesLine = sellAll
    ? `All ${formatShares(position?.quantityMicros ?? '0')} shares`
    : shares != null && cents > 0
      ? `≈ ${shares.toFixed(3)} shares`
      : '';
  const amountText = sellAll ? centsLabel(cents) : entryLabel(entry);
  const amountFont = amountSize(amountText, width);
  const summary = placed
    ? placed.quantityMicros
      ? `${formatShares(placed.quantityMicros)} shares`
      : centsLabel(placed.cents)
    : '';

  return (
    <GestureHandlerRootView style={styles.root}>
      <LinearGradient colors={backgroundGradient} locations={[0, 0.5, 1] as const} style={StyleSheet.absoluteFill} />

      <StarField width={width} />

      {phase !== 'edit' ? (
        <Animated.View style={[styles.confirm, { paddingTop: insets.top + 96, paddingBottom: insets.bottom + space.lg }, confirmStyle]}>
          <View style={styles.confirmBody} accessibilityLiveRegion="polite">
            <Text style={styles.confirmTitle} accessibilityRole="header">
              {result.title}
            </Text>
            <Text style={styles.confirmAmount} adjustsFontSizeToFit numberOfLines={1}>
              {summary}
            </Text>
            <Text style={styles.confirmName} numberOfLines={1} adjustsFontSizeToFit>
              {side === 'buy' ? 'Buy' : 'Sell'} · {name}
            </Text>
            <Text style={[styles.confirmDetail, result.failed && { color: colors.danger }]}>{result.detail}</Text>
            {placed && !result.failed ? (
              <Text style={styles.confirmNote}>
                Market order on your practice account at about {money(placed.price)} a share. Virtual money only.
              </Text>
            ) : null}
          </View>
          <View style={styles.confirmActions}>
            {result.failed ? (
              <Pressable
                accessibilityRole="button"
                onPress={editAgain}
                style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}>
                <Text style={styles.primaryText}>Edit Order</Text>
              </Pressable>
            ) : null}
            <Pressable
              accessibilityRole="button"
              disabled={!result.settled}
              onPress={() => router.back()}
              style={({ pressed }) => [
                result.failed ? styles.secondaryButton : styles.primaryButton,
                !result.settled && styles.disabled,
                pressed && styles.pressed,
              ]}>
              <Text style={result.failed ? styles.secondaryText : styles.primaryText}>{result.failed ? 'Close' : 'Done'}</Text>
            </Pressable>
          </View>
        </Animated.View>
      ) : null}

      <GestureDetector gesture={pan}>
        <View style={StyleSheet.absoluteFill} pointerEvents={phase === 'edit' ? 'auto' : 'none'}>
          <Animated.View
            style={[styles.prompt, { height: PROMPT_HEIGHT + insets.bottom, paddingBottom: insets.bottom }, promptStyle]}
            accessible
            accessibilityRole="button"
            accessibilityLabel={ready ? `Swipe up to ${verb} ${ticker}` : blocker ?? ''}
            accessibilityHint={ready ? 'Double-tap to place the order' : undefined}
            accessibilityState={{ disabled: !ready }}
            accessibilityActions={ready ? [{ name: 'activate' }] : []}
            onAccessibilityAction={() => {
              if (!ready) return;
              lift.set(withTiming(-height, { duration: 360, easing: Easing.out(Easing.cubic) }));
              void submit();
            }}>
            <Animated.View style={chevronStyle}>
              <Image source={swipeIcon} style={[styles.swipeIcon, !ready && styles.dim]} contentFit="contain" accessible={false} />
            </Animated.View>
            <Text style={[styles.promptTitle, !ready && styles.dim]}>{ready ? `Swipe to ${verb} ${ticker}` : blocker}</Text>
            <View>
              <Animated.Text style={[styles.promptNote, restingNoteStyle]}>
                {rt.paperAccount?.marketOpen === false
                  ? 'Market order · Fills after the market opens'
                  : 'Market order · Price may change slightly'}
              </Animated.Text>
              <Animated.Text style={[styles.promptNote, styles.promptNoteOver, draggingNoteStyle]} accessible={false}>
                {price != null ? `Submitting at about ${money(price)} a share` : 'Submitting'}
              </Animated.Text>
            </View>
          </Animated.View>

          <Animated.View style={[styles.card, { bottom: PROMPT_HEIGHT + insets.bottom }, cardStyle]}>
            <Animated.View style={[styles.cardInner, { paddingTop: insets.top }, contentStyle]}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close"
                onPress={() => router.back()}
                hitSlop={8}
                style={({ pressed }) => [styles.close, pressed && styles.pressed]}>
                <Image source={closeIcon} style={styles.closeIcon} contentFit="contain" accessible={false} />
              </Pressable>

              <View style={styles.heading}>
                <Text style={styles.title} accessibilityRole="header" numberOfLines={1} adjustsFontSizeToFit>
                  {name}
                </Text>
                <Text style={styles.quote}>
                  {price != null ? money(price) : 'No quote'}
                  {dayChange != null ? (
                    <Text style={styles.change}>
                      {'  '}
                      <Text style={{ color: dayChange >= 0 ? colors.success : colors.danger }}>{signedPct(dayChange)}</Text>
                      {' today'}
                    </Text>
                  ) : null}
                </Text>
              </View>

              <View style={styles.amountBlock} accessibilityLiveRegion="polite">
                <RollingText
                  text={amountText}
                  direction={roll}
                  fontSize={amountFont}
                  lineHeight={Math.round(amountFont * 1.2)}
                  style={styles.amount}
                  color={colors.text}
                  dimColor={colors.amountEmpty}
                  dim={cents === 0}
                  accessibilityLabel={`${side === 'buy' ? 'Buy' : 'Sell'} amount ${sellAll ? sharesLine : amountText}`}
                />
                {!sellAll && shares != null && cents > 0 ? (
                  <Odometer value={shares} digits={3} prefix="≈ " suffix=" shares" lineHeight={SHARES_LINE} style={styles.shares} />
                ) : (
                  <Text style={[styles.shares, { lineHeight: SHARES_LINE, height: SHARES_LINE }]}>{sharesLine}</Text>
                )}
                <Text style={[styles.available, overLimit && { color: colors.danger }]}>{availableLine}</Text>
              </View>

              <View style={styles.keypad}>
                <View style={styles.keyRow}>
                  <KeyButton label="+$25" small onPress={() => onQuick('add25')} />
                  <KeyButton label="+$100" small onPress={() => onQuick('add100')} />
                  {side === 'buy' ? (
                    <KeyButton label="+1 Share" small disabled={price == null} onPress={() => onQuick('share')} />
                  ) : (
                    <KeyButton label="Sell All" small selected={sellAll} disabled={!position} onPress={() => onQuick('all')} />
                  )}
                </View>
                {KEY_ROWS.map(row => (
                  <View key={row.join('')} style={styles.keyRow}>
                    {row.map(key =>
                      key === 'back' ? (
                        <KeyButton
                          key={key}
                          label="Delete"
                          icon
                          onPress={() => onKey('back')}
                          onLongPress={() => {
                            tick();
                            roll.set(-1);
                            setSellAll(false);
                            setEntry('');
                          }}
                        />
                      ) : (
                        <KeyButton key={key} label={key} onPress={() => onKey(key)} />
                      ),
                    )}
                  </View>
                ))}
              </View>
            </Animated.View>
            <AnimatedBlurView tint="dark" animatedProps={blurProps} style={StyleSheet.absoluteFill} pointerEvents="none" />
          </Animated.View>
        </View>
      </GestureDetector>
    </GestureHandlerRootView>
  );
}

function KeyButton({
  label,
  onPress,
  onLongPress,
  small = false,
  icon = false,
  selected = false,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  onLongPress?: () => void;
  small?: boolean;
  icon?: boolean;
  selected?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label === '.' ? 'Decimal point' : label}
      accessibilityState={{ disabled, selected }}
      disabled={disabled}
      onPress={onPress}
      onLongPress={onLongPress}
      style={styles.key}>
      {({ pressed }) => (
        <View style={[styles.keyFace, pressed && styles.keyPressed, selected && styles.keySelected]}>
          {icon ? (
            <Image source={backspaceIcon} style={styles.backspace} contentFit="contain" accessible={false} />
          ) : (
            <Text style={[small ? styles.quickText : styles.keyText, disabled && styles.dim, selected && styles.keySelectedText]}>
              {label}
            </Text>
          )}
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.45 },
  dim: { opacity: 0.45 },
  card: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    backgroundColor: colors.background,
    borderBottomLeftRadius: 70,
    borderBottomRightRadius: 70,
    overflow: 'hidden',
  },
  cardInner: { flex: 1, paddingBottom: space.xl },
  close: { width: HIT, height: HIT, marginLeft: space.lg, marginTop: space.xs, alignItems: 'center', justifyContent: 'center' },
  closeIcon: { width: 35, height: 35 },
  heading: { paddingHorizontal: 40, gap: space.xs, marginTop: space.xs },
  title: { fontFamily: font.semibold, fontSize: 21, lineHeight: 28, color: colors.text },
  quote: { fontFamily: font.semibold, fontSize: 16, lineHeight: 22, color: colors.textSubtle, fontVariant: ['tabular-nums'] },
  /** Smaller than the price it follows. */
  change: { fontFamily: font.medium, fontSize: 13 },
  amountBlock: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 40, minHeight: 150 },
  amount: { fontFamily: font.bold, letterSpacing: -2, textAlign: 'center' },
  shares: { fontFamily: font.medium, fontSize: 20, color: colors.textSubtle, fontVariant: ['tabular-nums'] },
  available: { fontFamily: font.medium, fontSize: 13, lineHeight: 18, color: colors.textSubtle, marginTop: space.sm },
  keypad: { paddingHorizontal: space.xxl },
  keyRow: { flexDirection: 'row' },
  key: { flex: 1, height: 64, alignItems: 'center', justifyContent: 'center' },
  keyFace: {
    minWidth: 64,
    height: 56,
    borderRadius: 28,
    paddingHorizontal: space.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyPressed: { backgroundColor: 'rgba(227, 227, 227, 0.08)' },
  keySelected: { backgroundColor: colors.rangeActive },
  keySelectedText: { color: colors.text },
  keyText: { fontFamily: font.semibold, fontSize: 22, lineHeight: 28, color: colors.textSubtle },
  quickText: { fontFamily: font.semibold, fontSize: 18, lineHeight: 24, color: colors.textSubtle },
  backspace: { width: 46.6667, height: 46.6667 },
  prompt: { position: 'absolute', left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'flex-end', gap: 2 },
  swipeIcon: { width: 35, height: 35 },
  promptTitle: { fontFamily: font.semibold, fontSize: 17, lineHeight: 22, color: colors.text, textAlign: 'center' },
  promptNote: { fontFamily: font.semibold, fontSize: 12, lineHeight: 16, color: colors.textSubtle, textAlign: 'center' },
  promptNoteOver: { position: 'absolute', left: 0, right: 0, top: 0 },
  confirm: { ...StyleSheet.absoluteFill, paddingHorizontal: space.xl, justifyContent: 'space-between' },
  confirmBody: { alignItems: 'center', gap: space.xs },
  confirmTitle: { fontFamily: font.bold, fontSize: 35, lineHeight: 44, color: colors.text, textAlign: 'center' },
  confirmAmount: {
    fontFamily: font.bold,
    fontSize: 55,
    lineHeight: 68,
    color: colors.text,
    textAlign: 'center',
    marginTop: space.xl,
    fontVariant: ['tabular-nums'],
  },
  confirmName: { fontFamily: font.bold, fontSize: 30, lineHeight: 38, color: colors.textSubtle, textAlign: 'center' },
  confirmDetail: {
    fontFamily: font.medium,
    fontSize: 16,
    lineHeight: 22,
    color: colors.text,
    textAlign: 'center',
    marginTop: space.xl,
  },
  confirmNote: { fontFamily: font.regular, fontSize: 13, lineHeight: 18, color: colors.textSubtle, textAlign: 'center' },
  confirmActions: { gap: space.md },
  primaryButton: {
    height: 55,
    borderRadius: 15,
    backgroundColor: colors.text,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryText: { fontFamily: font.semibold, fontSize: 20, lineHeight: 26, color: colors.background },
  secondaryButton: {
    height: 55,
    borderRadius: 15,
    backgroundColor: colors.secondary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryText: { fontFamily: font.semibold, fontSize: 20, lineHeight: 26, color: colors.secondaryText },
});
