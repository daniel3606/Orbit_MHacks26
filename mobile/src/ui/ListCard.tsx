import { Children, Fragment, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { colors, radius, space } from './theme';

/**
 * Grouped rows on black at 30% opacity, the same fill as the Discover cards,
 * with a hairline between each row.
 */
export function ListCard({ children }: { children: ReactNode }) {
  return (
    <View style={styles.card}>
      {Children.toArray(children).map((child, index) => (
        <Fragment key={index}>
          {index > 0 ? <View style={styles.divider} /> : null}
          {child}
        </Fragment>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.xl,
    padding: space.lg + 2,
    gap: space.md,
    backgroundColor: 'rgba(0, 0, 0, 0.3)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 255, 255, 0.08)',
  },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.divider },
});
