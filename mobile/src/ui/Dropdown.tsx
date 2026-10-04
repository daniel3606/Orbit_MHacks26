import * as Haptics from 'expo-haptics';
import { useRef, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { colors, font, HIT, radius, space } from './theme';

export type DropdownOption<V> = { value: V; label: string };

const ITEM_HEIGHT = HIT;
const MENU_MAX_HEIGHT = ITEM_HEIGHT * 6;
const GAP = 6;
const EDGE = 16;

type Anchor = { x: number; y: number; width: number; height: number };

/**
 * A labelled field that opens a list beneath it. The list lives in a transparent
 * modal so a tap anywhere else closes it and no parent can clip it.
 */
export function Dropdown<V extends string | number>({
  label,
  placeholder,
  options,
  value,
  onChange,
}: {
  label: string;
  placeholder: string;
  options: DropdownOption<V>[];
  value: V | null;
  onChange: (value: V) => void;
}) {
  const field = useRef<View>(null);
  const window = useWindowDimensions();
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const selected = options.find(o => o.value === value) ?? null;
  const selectedIndex = selected ? options.indexOf(selected) : -1;

  function open() {
    field.current?.measureInWindow((x, y, width, height) => setAnchor({ x, y, width, height }));
  }

  function choose(next: V) {
    void Haptics.selectionAsync();
    onChange(next);
    setAnchor(null);
  }

  const menuHeight = Math.min(MENU_MAX_HEIGHT, options.length * ITEM_HEIGHT);
  // Open upward when the list would run off the bottom of the screen.
  const below = anchor ? anchor.y + anchor.height + GAP + menuHeight <= window.height - EDGE : true;
  const menuTop = anchor ? (below ? anchor.y + anchor.height + GAP : anchor.y - GAP - menuHeight) : 0;
  const initialOffset = Math.max(0, Math.min(selectedIndex * ITEM_HEIGHT - menuHeight / 2 + ITEM_HEIGHT / 2, options.length * ITEM_HEIGHT - menuHeight));

  return (
    <View style={styles.wrap}>
      <Text style={styles.label} maxFontSizeMultiplier={1.4}>
        {label}
      </Text>
      <Pressable
        ref={field}
        accessibilityRole="button"
        accessibilityLabel={`${label}, ${selected ? selected.label : 'not chosen'}`}
        accessibilityHint="Opens a list to choose from"
        accessibilityState={{ expanded: anchor !== null }}
        onPress={open}
        style={({ pressed }) => [styles.field, pressed && { opacity: 0.85 }]}>
        <Text
          numberOfLines={1}
          maxFontSizeMultiplier={1.4}
          style={[styles.value, !selected && { color: colors.textMuted }]}>
          {selected ? selected.label : placeholder}
        </Text>
        <Chevron up={anchor !== null && !below} />
      </Pressable>

      <Modal visible={anchor !== null} transparent animationType="fade" onRequestClose={() => setAnchor(null)}>
        <Pressable style={StyleSheet.absoluteFill} accessibilityLabel="Close list" onPress={() => setAnchor(null)} />
        {anchor ? (
          <View style={[styles.menu, { top: menuTop, left: anchor.x, width: anchor.width, height: menuHeight }]}>
            <ScrollView
              contentOffset={{ x: 0, y: initialOffset }}
              showsVerticalScrollIndicator={options.length * ITEM_HEIGHT > menuHeight}
              accessibilityRole="menu">
              {options.map(option => {
                const isSelected = option.value === value;
                return (
                  <Pressable
                    key={String(option.value)}
                    accessibilityRole="menuitem"
                    accessibilityState={{ selected: isSelected }}
                    onPress={() => choose(option.value)}
                    style={({ pressed }) => [
                      styles.item,
                      isSelected && styles.itemSelected,
                      pressed && { backgroundColor: colors.selection },
                    ]}>
                    <Text style={styles.itemText} maxFontSizeMultiplier={1.4}>
                      {option.label}
                    </Text>
                    {isSelected ? <Check /> : null}
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
        ) : null}
      </Modal>
    </View>
  );
}

function Chevron({ up }: { up: boolean }) {
  return (
    <Svg width={16} height={16} viewBox="0 0 16 16" style={up ? { transform: [{ rotate: '180deg' }] } : undefined}>
      <Path d="M4 6l4 4 4-4" stroke={colors.text} strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </Svg>
  );
}

function Check() {
  return (
    <Svg width={16} height={16} viewBox="0 0 16 16">
      <Path d="M3.5 8.5l3 3 6-7" stroke={colors.text} strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </Svg>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.sm },
  label: { fontFamily: font.medium, fontSize: 14, lineHeight: 19, color: colors.text },
  field: {
    height: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.fieldBorder,
    backgroundColor: colors.field,
  },
  value: { flex: 1, fontFamily: font.medium, fontSize: 16, lineHeight: 22, color: colors.text },
  menu: {
    position: 'absolute',
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOpacity: 0.5,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
  },
  item: {
    height: ITEM_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
  },
  itemSelected: { backgroundColor: colors.secondary },
  itemText: { fontFamily: font.medium, fontSize: 16, color: colors.text },
});
