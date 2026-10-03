import Constants from 'expo-constants';
import { TurboModuleRegistry, type TurboModule } from 'react-native';

interface SourceCodeSpec extends TurboModule {
  getConstants(): { scriptURL: string };
}

/** URL the JS bundle was loaded from (same source as RN's internal getDevServer). */
function bundleHost(): string | undefined {
  const scriptURL = TurboModuleRegistry.get<SourceCodeSpec>('SourceCode')?.getConstants().scriptURL;
  if (!scriptURL || !/^https?:\/\//.test(scriptURL)) return undefined; // embedded bundle
  return new URL(scriptURL).hostname || undefined;
}

/**
 * Public, non-secret client configuration. EXPO_PUBLIC_* values are inlined
 * into the bundle, so nothing secret may ever be placed here.
 *
 * SpacetimeDB address resolution:
 *  1. EXPO_PUBLIC_SPACETIME_URI if set (use for staging, or if 2 fails).
 *  2. In development, the host that served the JS bundle, on port 3000. That
 *     host is the dev machine as reachable from this device — on a physical
 *     iPhone `localhost` would be the phone itself.
 *  3. ws://127.0.0.1:3000 as a last resort (simulator only).
 */
function devMachineHost(): { host: string; source: string } | undefined {
  if (!__DEV__) return undefined;
  const fromManifest = Constants.expoConfig?.hostUri?.split(':')[0];
  if (fromManifest) return { host: fromManifest, source: 'Expo manifest hostUri' };
  try {
    const host = bundleHost();
    if (host) return { host, source: 'Metro bundle host' };
  } catch {
    // fall through to the default
  }
  return undefined;
}

const explicitUri = process.env.EXPO_PUBLIC_SPACETIME_URI?.trim();
const devHost = explicitUri ? undefined : devMachineHost();

export const config = {
  spacetimeUri: explicitUri || (devHost ? `ws://${devHost.host}:3000` : 'ws://127.0.0.1:3000'),
  spacetimeUriSource: explicitUri ? 'EXPO_PUBLIC_SPACETIME_URI' : devHost?.source ?? 'default (simulator only)',
  spacetimeDatabase: process.env.EXPO_PUBLIC_SPACETIME_DB?.trim() || 'orbit-dev',
  /**
   * Secure-storage scope for the session token. Dev-derived hosts share one
   * scope so a changing LAN IP does not orphan the guest session; explicit
   * URIs are scoped to their host so a token is never replayed elsewhere.
   */
  sessionScope: explicitUri ? explicitUri.replace(/^wss?:\/\//, '') : 'devhost',
  /** Shown in UI: this build uses server-issued guest identities, not OIDC. */
  authMode: 'device_guest' as const,
};
