import { Image } from 'expo-image';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { colors, font } from '@/ui/theme';

/**
 * The company's own logo, clipped to a circle. ETFs have no provider logo, and a logo can fail to
 * load, so both fall back to the ticker's first letter.
 */
export function StockLogo({ ticker, logoUrl, size = 44 }: { ticker: string; logoUrl: string; size?: number }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const showLogo = logoUrl !== '' && failedUrl !== logoUrl;
  const frame = { width: size, height: size, borderRadius: size / 2 };

  return (
    <View style={[styles.frame, frame]} accessible={false}>
      {showLogo ? (
        <Image
          source={{ uri: logoUrl }}
          style={frame}
          contentFit="cover"
          cachePolicy="memory-disk"
          transition={160}
          onError={() => setFailedUrl(logoUrl)}
          accessible={false}
        />
      ) : (
        <Text style={[styles.monogram, { fontSize: Math.round(size * 0.4) }]}>{ticker.charAt(0)}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  monogram: { fontFamily: font.bold, color: colors.text },
});
