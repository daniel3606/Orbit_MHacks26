import { type ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { SafeAreaView, type Edge } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';

import { backgroundGradient, colors, HIT, radius, space, type } from './theme';

type Variant = keyof typeof type;

export function T({
  variant = 'body',
  muted,
  color,
  style,
  children,
  ...rest
}: {
  variant?: Variant;
  muted?: boolean;
  color?: string;
  style?: StyleProp<TextStyle>;
  children: ReactNode;
  accessibilityRole?: 'header' | 'text' | 'alert';
  numberOfLines?: number;
  adjustsFontSizeToFit?: boolean;
  minimumFontScale?: number;
  selectable?: boolean;
}) {
  return (
    <Text style={[type[variant], { color: color ?? (muted ? colors.textMuted : colors.text) }, style]} {...rest}>
      {children}
    </Text>
  );
}

export function Screen({
  children,
  scroll = true,
  edges = ['top', 'bottom'],
  header,
  footer,
  footerBorder = true,
}: {
  children: ReactNode;
  scroll?: boolean;
  edges?: Edge[];
  /** Stays above the scrolling content. */
  header?: ReactNode;
  footer?: ReactNode;
  footerBorder?: boolean;
}) {
  return (
    <LinearGradient colors={backgroundGradient} locations={[0, 0.5, 1] as const} style={styles.fill}>
      <SafeAreaView style={styles.fill} edges={edges}>
        {header ? <View style={styles.header}>{header}</View> : null}
        {scroll ? (
          <ScrollView
            contentContainerStyle={styles.content}
            keyboardShouldPersistTaps="handled"
            automaticallyAdjustKeyboardInsets>
            {children}
          </ScrollView>
        ) : (
          <View style={[styles.content, { flex: 1 }]}>{children}</View>
        )}
        {footer ? <View style={[styles.footer, !footerBorder && { borderTopWidth: 0 }]}>{footer}</View> : null}
      </SafeAreaView>
    </LinearGradient>
  );
}

export function Button({
  label,
  onPress,
  kind = 'primary',
  disabled,
  busy,
  accessibilityHint,
}: {
  label: string;
  onPress: () => void;
  kind?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
  busy?: boolean;
  accessibilityHint?: string;
}) {
  const inactive = disabled || busy;
  const palette =
    kind === 'primary'
      ? { bg: colors.accent, fg: colors.accentText, border: colors.accent }
      : kind === 'danger'
        ? { bg: 'transparent', fg: colors.danger, border: colors.danger }
        : { bg: colors.secondary, fg: colors.secondaryText, border: colors.secondary };
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: !!inactive, busy: !!busy }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: palette.bg, borderColor: palette.border, opacity: inactive ? 0.5 : pressed ? 0.85 : 1 },
      ]}>
      {busy ? <ActivityIndicator color={palette.fg} /> : <T variant="label" color={palette.fg}>{label}</T>}
    </Pressable>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

/** Selectable option used by single- and multi-select questions. */
export function OptionCard({
  title,
  description,
  selected,
  onPress,
  multi,
}: {
  title: string;
  description?: string;
  selected: boolean;
  onPress: () => void;
  multi?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole={multi ? 'checkbox' : 'radio'}
      accessibilityState={multi ? { checked: selected } : { selected }}
      accessibilityLabel={description ? `${title}. ${description}` : title}
      onPress={onPress}
      style={({ pressed }) => [
        styles.option,
        selected && styles.optionSelected,
        pressed && { opacity: 0.85 },
      ]}>
      {multi ? (
        <View style={[styles.marker, styles.markerSquare, selected && styles.markerChecked]}>
          {selected ? (
            <Svg width={12} height={10} viewBox="0 0 12 10">
              <Path
                d="M1 5l3.5 3.5L11 1.5"
                stroke={colors.background}
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                fill="none"
              />
            </Svg>
          ) : null}
        </View>
      ) : (
        <View style={[styles.marker, styles.markerRound, selected && styles.markerOn]}>
          {selected ? <View style={styles.markerDot} /> : null}
        </View>
      )}
      <View style={{ flex: 1 }}>
        <T variant="label">{title}</T>
        {description ? (
          <T variant="caption" muted style={{ marginTop: 2 }}>
            {description}
          </T>
        ) : null}
      </View>
    </Pressable>
  );
}

export function Chip({ label }: { label: string }) {
  return (
    <View style={styles.chip}>
      <T variant="caption">{label}</T>
    </View>
  );
}

export type BannerTone = 'info' | 'warning' | 'danger' | 'success';

export function Banner({
  tone,
  title,
  body,
  action,
}: {
  tone: BannerTone;
  title: string;
  body?: string;
  action?: { label: string; onPress: () => void };
}) {
  const tint = { info: colors.info, warning: colors.warning, danger: colors.danger, success: colors.success }[tone];
  return (
    <View accessibilityRole="alert" style={[styles.banner, { borderColor: tint }]}>
      <View style={{ flex: 1 }}>
        <T variant="label" color={tint}>
          {title}
        </T>
        {body ? (
          <T variant="caption" muted style={{ marginTop: 2 }}>
            {body}
          </T>
        ) : null}
      </View>
      {action ? (
        <Pressable
          accessibilityRole="button"
          onPress={action.onPress}
          hitSlop={8}
          style={{ minHeight: HIT, justifyContent: 'center', paddingLeft: space.md }}>
          <T variant="label" color={tint}>
            {action.label}
          </T>
        </Pressable>
      ) : null}
    </View>
  );
}

export function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <View style={styles.row}>
      <T variant="caption" muted style={{ flex: 1 }}>
        {label}
      </T>
      <View style={{ flex: 2, alignItems: 'flex-end' }}>
        {typeof value === 'string' ? <T variant="caption" style={{ textAlign: 'right' }}>{value}</T> : value}
      </View>
    </View>
  );
}

export function Gap({ size = 'lg' }: { size?: keyof typeof space }) {
  return <View style={{ height: space[size] }} />;
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { padding: space.xl, gap: space.lg },
  header: { paddingHorizontal: space.xl, paddingTop: space.sm, gap: space.md },
  footer: {
    paddingHorizontal: space.xl,
    paddingTop: space.md,
    paddingBottom: space.md,
    gap: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: 'transparent',
  },
  button: {
    minHeight: HIT + 4,
    borderRadius: radius.pill,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.xl,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: space.lg,
    gap: space.sm,
  },
  option: {
    minHeight: HIT + 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.md + 2,
    paddingHorizontal: space.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  optionSelected: { borderColor: 'rgba(227, 227, 227, 0.72)', backgroundColor: colors.selection },
  marker: {
    width: 22,
    height: 22,
    borderWidth: 1.5,
    borderColor: colors.textMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  markerRound: { borderRadius: 11 },
  markerSquare: { borderRadius: 6, borderColor: colors.textSubtle },
  markerOn: { borderColor: colors.text },
  markerChecked: { borderColor: colors.text, backgroundColor: colors.text },
  markerDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.text },
  chip: {
    paddingHorizontal: space.md,
    paddingVertical: space.xs + 2,
    borderRadius: radius.pill,
    backgroundColor: colors.accentSoft,
  },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: radius.md,
    padding: space.md,
    backgroundColor: colors.surface,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    gap: space.md,
  },
});
