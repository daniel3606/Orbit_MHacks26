import Constants from 'expo-constants';
import { TurboModuleRegistry, type TurboModule } from 'react-native';

import { resolveClientConfig } from './public-endpoint';

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
 * Development may use EXPO_PUBLIC_SPACETIME_URI, otherwise the Metro host on
 * port 3000, otherwise ws://127.0.0.1:3000 for the simulator.
 * Production and TestFlight require a public wss:// URI and database name.
 * A missing value fails the build and the launch; localhost is not a fallback.
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

const devHost = devMachineHost();
const resolved = resolveClientConfig({
  explicitUri: process.env.EXPO_PUBLIC_SPACETIME_URI,
  database: process.env.EXPO_PUBLIC_SPACETIME_DB,
  appEnv: process.env.EXPO_PUBLIC_APP_ENV,
  dev: __DEV__,
  devHost: devHost?.host,
  devHostSource: devHost?.source,
});

export const config = {
  ...resolved,
  /** Shown in UI: this build uses server-issued guest identities, not OIDC. */
  authMode: 'device_guest' as const,
};
