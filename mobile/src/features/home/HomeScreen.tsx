import { useFocusEffect, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  Dimensions,
  Easing,
  Image,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type KeyboardEvent,
  type LayoutChangeEvent,
  type StyleProp,
  type TextStyle,
} from 'react-native';
import Svg, { Path, SvgXml } from 'react-native-svg';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { askOrbit, requestHomeBrief } from '@/features/profile/actions';
import { ConnectionBanner } from '@/features/session/ConnectionBanner';
import { chartSeries } from '@/features/market/series';
import { realtime, type StockVM } from '@/realtime/connection';
import { messageFor, toAppError } from '@/realtime/errors';
import { useRealtime } from '@/realtime/hooks';
import { StockGraph } from '@/ui/StockGraph';
import { T } from '@/ui/components';
import { colors, font, space } from '@/ui/theme';

/** Same artwork as assets/images/Template-orbit.svg, stretched to the screen. */
const orbitTemplate = `<svg width="430" height="932" viewBox="0 0 430 932" preserveAspectRatio="none" fill="none" xmlns="http://www.w3.org/2000/svg">
<rect width="430" height="932" fill="url(#paint0_linear_14_774)"/>
<defs>
<linearGradient id="paint0_linear_14_774" x1="215" y1="0" x2="215" y2="932" gradientUnits="userSpaceOnUse">
<stop stop-color="#050308"/>
<stop offset="0.5" stop-color="#0A0710"/>
<stop offset="1" stop-color="#150E22"/>
</linearGradient>
</defs>
</svg>`;

const mark = require('../../../assets/images/icon-transparent.png');
const bell = require('../../../assets/images/bell-icon.png');

function salutation(now = new Date()): string {
  const hour = now.getHours();
  if (hour < 12) return 'Good Morning';
  if (hour < 17) return 'Good Afternoon';
  return 'Good Evening';
}

const INTRO = 'I’m looking at today’s prices so I can explain them in plain language.';

const SUGGESTIONS = ['What is a stock?', 'What does my Trend Score mean?', 'How does practice trading work?'];
const MAX_QUESTION = 500;

const TYPE_PACE_MS = 16;
const ASK_CLEARANCE = 132;

function tickersFor(body: string, citations: string, stocks: StockVM[]): string[] {
  const known = new Set(stocks.map(stock => stock.ticker));
  const found: string[] = [];
  const add = (ticker: string) => {
    if (known.has(ticker) && !found.includes(ticker)) found.push(ticker);
  };
  try {
    const parsed = JSON.parse(citations) as { id?: string }[];
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        const match = /^(?:quote|news|score):([A-Za-z.]+)/.exec(item?.id ?? '');
        if (match?.[1]) add(match[1]);
      }
    }
  } catch {
    // Citations are stored for the server. A bad row just means no chart.
  }
  if (found.length > 0) return found.slice(0, 2);
  for (const stock of stocks) {
    const named = stock.name.length > 2 && body.includes(stock.name);
    if (named || new RegExp(`\\b${stock.ticker}\\b`).test(body)) add(stock.ticker);
  }
  return found.slice(0, 2);
}

function clientKey(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** How far the composer should rise so it sits just above the keyboard, not the tab bar. */
function useKeyboardLift(tabBarHeight: number) {
  const lift = useRef(new Animated.Value(0)).current;
  const [inset, setInset] = useState(0);

  useEffect(() => {
    function onFrame(event: KeyboardEvent) {
      const covered = Math.max(0, Dimensions.get('window').height - event.endCoordinates.screenY);
      const next = Math.max(0, covered - tabBarHeight);
      setInset(next);
      const duration = event.duration && event.duration > 0 ? event.duration : 0;
      if (duration === 0) {
        lift.setValue(-next);
        return;
      }
      Animated.timing(lift, {
        toValue: -next,
        duration,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    }

    const frames =
      Platform.OS === 'ios'
        ? [Keyboard.addListener('keyboardWillChangeFrame', onFrame)]
        : [
            Keyboard.addListener('keyboardDidShow', onFrame),
            Keyboard.addListener('keyboardDidHide', () => {
              setInset(0);
              Animated.timing(lift, { toValue: 0, duration: 180, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
            }),
          ];
    return () => frames.forEach(frame => frame.remove());
  }, [lift, tabBarHeight]);

  return { lift, inset };
}

function paragraphs(text: string): string[] {
  const parts = text.split(/\n+/).map(part => part.trim()).filter(Boolean);
  return parts.length > 0 ? parts : [text];
}

/** Reveals `text` one character at a time, with a light tick on each key. */
function TypedText({
  text,
  active,
  onDone,
  style,
  accessibilityRole,
}: {
  text: string;
  active: boolean;
  onDone?: () => void;
  style?: StyleProp<TextStyle>;
  accessibilityRole?: 'header' | 'text';
}) {
  const [seen, setSeen] = useState(text);
  const [count, setCount] = useState(0);
  const [caretOn, setCaretOn] = useState(true);
  if (seen !== text) {
    setSeen(text);
    setCount(0);
  }
  const done = !active || count >= text.length;

  useEffect(() => {
    if (!active || count >= text.length) return;
    const timer = setTimeout(() => {
      const next = text[count];
      setCount(current => current + 1);
      if (next && !/\s/.test(next)) {
        try {
          void Haptics.selectionAsync();
        } catch {
          // The dev client needs a rebuild before the haptic module is available.
        }
      }
    }, TYPE_PACE_MS);
    return () => clearTimeout(timer);
  }, [active, count, text]);

  useEffect(() => {
    if (active && count >= text.length) onDone?.();
  }, [active, count, onDone, text.length]);

  useEffect(() => {
    if (done) return;
    const timer = setInterval(() => setCaretOn(on => !on), 460);
    return () => clearInterval(timer);
  }, [done]);

  return (
    <Text style={style} accessibilityRole={accessibilityRole} accessibilityLabel={text}>
      {text.slice(0, active ? count : 0)}
      {done ? null : <Text style={{ color: caretOn ? '#FFFFFF' : 'transparent' }}>▍</Text>}
    </Text>
  );
}

export default function HomeScreen() {
  const router = useRouter();
  const rt = useRealtime();
  const [frame, setFrame] = useState({ width: 0, height: 0 });
  const greeting = `${salutation()} Daniel!`;
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const inflightKey = useRef<string | null>(null);
  const lastText = useRef('');
  const typedIds = useRef(new Set<string>());
  const typedText = useRef(new Map<string, string>());
  const [typedTick, setTypedTick] = useState(0);
  const markTyped = useCallback((id: string) => {
    if (typedIds.current.has(id)) return;
    typedIds.current.add(id);
    setTypedTick(tick => tick + 1);
  }, []);
  const insets = useSafeAreaInsets();
  const tabBarHeight = (Platform.OS === 'ios' ? 49 : 56) + insets.bottom;
  const { lift, inset } = useKeyboardLift(tabBarHeight);
  useFocusEffect(
    useCallback(() => {
      const release = realtime.acquireMarket();
      void requestHomeBrief(clientKey('brief')).catch(() => undefined);
      return release;
    }, [])
  );
  useEffect(() => {
    if (rt.status !== 'ready') return;
    void requestHomeBrief(clientKey('brief')).catch(() => undefined);
  }, [rt.status]);

  const messages = rt.assistantMessages;
  const brief = [...messages].reverse().find(message => message.kind === 'brief' && message.role === 'assistant');
  const intro =
    brief?.status === 'complete' && brief.body
      ? brief.body
      : brief?.status === 'pending'
        ? 'Looking at today’s prices…'
        : INTRO;
  const chat = messages.filter(message => message.kind === 'chat');
  const thinking = chat.some(message => message.role === 'assistant' && message.status === 'pending');
  const send = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || sending || thinking) return;
      lastText.current = text;
      const key = inflightKey.current ?? clientKey('ask');
      inflightKey.current = key;
      setSending(true);
      setSendError(null);
      try {
        await askOrbit(key, text.slice(0, MAX_QUESTION));
        inflightKey.current = null;
        setDraft('');
      } catch (err) {
        setSendError(messageFor(toAppError(err).code));
      } finally {
        setSending(false);
      }
    },
    [sending, thinking]
  );

  const stocks = rt.market.stocks;
  const historyIds = useRef<Set<string> | null>(null);
  if ((rt.status === 'ready' || rt.hasSynced) && historyIds.current === null) {
    historyIds.current = new Set(
      messages.filter(message => message.role === 'assistant' && message.status === 'complete' && message.body).map(message => message.id)
    );
  }
  const opened = historyIds.current !== null;
  const remembered = (id: string) => historyIds.current?.has(id) ?? false;
  const introIsRemembered = opened && !!(brief && remembered(brief.id));
  const introParts = paragraphs(intro);
  const blocks = [
    { id: 'greeting', text: greeting },
    ...(opened && !introIsRemembered ? introParts.map((text, index) => ({ id: `intro:${index}`, text })) : []),
    ...(opened
      ? chat
      .filter(message => message.role === 'assistant' && !remembered(message.id))
      .flatMap(message =>
        paragraphs(message.body || (message.status === 'pending' ? 'Thinking…' : '')).map((text, index) => ({
          id: `${message.id}:${index}`,
          text,
        }))
      )
      : []),
  ];
  const blockSignature = blocks.map(block => `${block.id}\u0000${block.text}`).join('\u0001');
  const [seenSignature, setSeenSignature] = useState(blockSignature);
  if (seenSignature !== blockSignature) {
    setSeenSignature(blockSignature);
    const live = new Set(blocks.map(block => block.id));
    for (const block of blocks) {
      const previous = typedText.current.get(block.id);
      if (previous !== undefined && previous !== block.text) typedIds.current.delete(block.id);
      typedText.current.set(block.id, block.text);
    }
    for (const id of typedIds.current) {
      if (!live.has(id)) typedIds.current.delete(id);
    }
  }
  void typedTick;
  const typedThrough = (index: number) => blocks.slice(0, index).every(block => typedIds.current.has(block.id));
  const introTyped = introIsRemembered || introParts.every((_, index) => typedIds.current.has(`intro:${index}`));
  const briefTickers = introTyped && brief?.status === 'complete' ? tickersFor(brief.body, brief.citations, stocks) : [];

  function openTicker(ticker: string) {
    router.push({ pathname: '/stock/[ticker]', params: { ticker } });
  }

  function onFrame(event: LayoutChangeEvent) {
    const { width, height } = event.nativeEvent.layout;
    setFrame(current => (current.width === width && current.height === height ? current : { width, height }));
  }

  return (
    <View style={styles.root} onLayout={onFrame}>
      {frame.width > 0 ? (
        <SvgXml
          xml={orbitTemplate}
          width={frame.width}
          height={frame.height}
          pointerEvents="none"
          style={StyleSheet.absoluteFill}
        />
      ) : null}
      <SafeAreaView style={styles.fill} edges={['top']}>
        <ScrollView
          contentContainerStyle={[styles.scroll, { paddingBottom: ASK_CLEARANCE + inset }]}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
          showsVerticalScrollIndicator={false}>
          <ConnectionBanner />
          <View style={styles.header}>
            <View style={styles.brand}>
              <Image source={mark} style={styles.mark} resizeMode="contain" accessibilityIgnoresInvertColors />
              <T variant="title" style={styles.wordmark}>
                Orbit
              </T>
            </View>
            <View accessibilityLabel="Notifications" style={styles.bellWrap}>
              <Image source={bell} style={styles.bell} resizeMode="contain" accessibilityIgnoresInvertColors />
              <View style={styles.badge} />
            </View>
          </View>

          <TypedText
            text={greeting}
            active={typedThrough(0)}
            onDone={() => markTyped('greeting')}
            style={styles.greeting}
            accessibilityRole="header"
          />
          {opened && introIsRemembered ? (
            <Text style={styles.intro}>{intro}</Text>
          ) : opened ? (
            introParts.map((text, index) => (
              <TypedText
                key={`intro:${index}`}
                text={text}
                active={typedThrough(1 + index)}
                onDone={() => markTyped(`intro:${index}`)}
                style={styles.intro}
              />
            ))
          ) : null}
          {briefTickers.map(ticker => {
            const stock = stocks.find(item => item.ticker === ticker);
            const quote = rt.market.quotes[ticker];
            if (!stock) return null;
            return (
              <Pressable
                key={ticker}
                accessibilityRole="button"
                accessibilityLabel={`Open ${stock.name || ticker}`}
                onPress={() => openTicker(ticker)}>
                <StockGraph
                  title={stock.name || ticker}
                  plain
                  price={quote?.price ?? null}
                  previousClose={quote?.previousClose}
                  points={chartSeries(rt.market.closes[ticker], quote)}
                />
              </Pressable>
            );
          })}
          {brief?.status === 'failed' ? (
            <Pressable accessibilityRole="button" onPress={() => void requestHomeBrief(clientKey('brief'))}>
              <Text style={styles.retry}>{brief.body || 'I couldn’t load today’s note. Tap to try again.'}</Text>
            </Pressable>
          ) : null}
          <View style={styles.suggestions}>
            {SUGGESTIONS.map(question => (
              <Pressable
                key={question}
                accessibilityRole="button"
                disabled={sending || thinking}
                onPress={() => void send(question)}
                style={styles.suggestion}>
                <Text style={styles.suggestionText}>{question}</Text>
              </Pressable>
            ))}
          </View>

          {chat.map((message, index) => {
            if (message.role === 'user') {
              return (
                <Text key={message.id} style={styles.userLine}>
                  {message.body}
                </Text>
              );
            }
            const parts = paragraphs(message.body || (message.status === 'pending' ? 'Thinking…' : ''));
            const replyReady =
              remembered(message.id) || parts.every((_, part) => typedIds.current.has(`${message.id}:${part}`));
            return (
              <View key={message.id} style={styles.threadItem}>
                {remembered(message.id) ? (
                  <Text style={styles.replyLine}>{message.body}</Text>
                ) : (
                  parts.map((text, part) => {
                    const blockIndex = blocks.findIndex(block => block.id === `${message.id}:${part}`);
                    return (
                      <TypedText
                        key={`${message.id}:${part}`}
                        text={text}
                        active={blockIndex >= 0 && typedThrough(blockIndex)}
                        onDone={() => markTyped(`${message.id}:${part}`)}
                        style={styles.replyLine}
                      />
                    );
                  })
                )}
                {message.status === 'complete' && replyReady
                  ? tickersFor(message.body, message.citations, stocks).map(ticker => {
                      const stock = stocks.find(item => item.ticker === ticker);
                      const quote = rt.market.quotes[ticker];
                      if (!stock) return null;
                      return (
                        <Pressable
                          key={ticker}
                          accessibilityRole="button"
                          accessibilityLabel={`Open ${stock.name || ticker}`}
                          onPress={() => openTicker(ticker)}>
                          <StockGraph
                            title={stock.name || ticker}
                            plain
                            price={quote?.price ?? null}
                            previousClose={quote?.previousClose}
                            points={chartSeries(rt.market.closes[ticker], quote)}
                          />
                        </Pressable>
                      );
                    })
                  : null}
                {message.status === 'failed' ? (
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => {
                      const previous = [...chat.slice(0, index)].reverse().find(item => item.role === 'user');
                      if (previous) void send(previous.body);
                    }}>
                    <Text style={styles.retry}>Try again</Text>
                  </Pressable>
                ) : null}
              </View>
            );
          })}
          {sendError ? (
            <Pressable accessibilityRole="button" onPress={() => void send(lastText.current || draft)}>
              <Text style={styles.retry}>{sendError} Tap to retry.</Text>
            </Pressable>
          ) : null}
        </ScrollView>

        <Animated.View style={[styles.askWrap, { transform: [{ translateY: lift }] }]}>
          <Text style={styles.notice}>For learning. Not a recommendation to buy or sell.</Text>
          <View style={styles.ask}>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              placeholder="Ask Anything..."
              placeholderTextColor="#999999"
              style={styles.askInput}
              accessibilityLabel="Ask Anything"
              maxLength={MAX_QUESTION}
              editable={!sending}
              returnKeyType="send"
              onSubmitEditing={() => void send(draft)}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Send"
              accessibilityState={{ disabled: sending || thinking || draft.trim().length === 0 }}
              disabled={sending || thinking || draft.trim().length === 0}
              onPress={() => void send(draft)}
              style={styles.askButton}>
              <Svg width={16} height={16} viewBox="0 0 16 16">
                <Path
                  d="M8 12.5 V3.5 M3.8 7.4 L8 3.2 L12.2 7.4"
                  stroke="#FFFFFF"
                  strokeWidth={1.7}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  fill="none"
                />
              </Svg>
            </Pressable>
          </View>
        </Animated.View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  fill: { flex: 1, backgroundColor: 'transparent' },
  scroll: {
    paddingHorizontal: space.xl,
    paddingTop: space.sm,
    paddingBottom: ASK_CLEARANCE,
    gap: space.lg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: space.md,
  },
  brand: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  mark: { width: 34, height: 34 },
  wordmark: { fontFamily: font.bold, fontSize: 26, lineHeight: 32, color: '#FFFFFF' },
  bellWrap: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  bell: { width: 26, height: 26 },
  badge: {
    position: 'absolute',
    top: 1,
    right: 0,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#FF3B30',
  },
  greeting: { fontFamily: font.bold, fontSize: 22, lineHeight: 28, color: '#FFFFFF' },
  intro: { fontFamily: font.regular, fontSize: 16, lineHeight: 23, color: colors.text, marginTop: -space.sm },
  suggestions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  suggestion: {
    borderRadius: 16,
    backgroundColor: '#1E1F20',
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  suggestionText: { fontFamily: font.regular, fontSize: 14, lineHeight: 18, color: colors.text },
  threadItem: { gap: space.md },
  userLine: { fontFamily: font.regular, fontSize: 16, lineHeight: 23, color: '#FFFFFF', textAlign: 'right' },
  replyLine: { fontFamily: font.regular, fontSize: 16, lineHeight: 23, color: colors.text },
  retry: { fontFamily: font.regular, fontSize: 14, lineHeight: 20, color: '#FFFFFF' },
  notice: {
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 16,
    color: '#999999',
    textAlign: 'center',
    marginBottom: space.sm,
  },
  askWrap: {
    position: 'absolute',
    left: space.lg,
    right: space.lg,
    bottom: space.sm,
  },
  ask: {
    minHeight: 52,
    borderRadius: 26,
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: space.lg,
    paddingRight: 8,
    backgroundColor: '#1E1F20',
  },
  askInput: {
    flex: 1,
    fontFamily: font.regular,
    fontSize: 16,
    color: colors.text,
    paddingVertical: space.md,
  },
  askButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.secondary,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
