import * as SecureStore from 'expo-secure-store';
import { create } from 'zustand';

import { config } from '@/config/env';
import { prefetchConstellation } from '@/ui/Constellation';

/**
 * The last zodiac sign this device saw for its guest session, so Discover can draw the right
 * constellation on launch instead of waiting for the server. The server's value replaces it
 * once synced. Scoped like the saved session (see realtime/session-storage.ts).
 */
const KEY = `orbit.sign.v1.${config.sessionScope}_${config.spacetimeDatabase}`.replace(/[^A-Za-z0-9._-]/g, '_');

type SignCache = { sign: string | null; loaded: boolean };

export const useCachedSign = create<SignCache>(() => ({ sign: null, loaded: false }));

SecureStore.getItemAsync(KEY).then(
  sign => {
    // A sign the server sent while this was being read is newer; keep it.
    if (useCachedSign.getState().loaded) return;
    useCachedSign.setState({ sign, loaded: true });
    if (sign) prefetchConstellation(sign);
  },
  () => useCachedSign.setState({ loaded: true }),
);

export function rememberSign(sign: string | null) {
  const current = useCachedSign.getState();
  if (current.loaded && current.sign === sign) return;
  useCachedSign.setState({ sign, loaded: true });
  void (sign ? SecureStore.setItemAsync(KEY, sign) : SecureStore.deleteItemAsync(KEY)).catch(() => undefined);
}
