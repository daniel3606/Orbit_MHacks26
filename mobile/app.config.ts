import type { ConfigContext, ExpoConfig } from '@expo/config';

import { assertReleaseSpacetimeConfig } from './src/config/public-endpoint.ts';

function isProductionBuild(): boolean {
  return process.env.EXPO_PUBLIC_APP_ENV === 'production' || process.env.EAS_BUILD_PROFILE === 'production';
}

export default ({ config }: ConfigContext): ExpoConfig => {
  if (isProductionBuild()) {
    assertReleaseSpacetimeConfig({
      uri: process.env.EXPO_PUBLIC_SPACETIME_URI,
      database: process.env.EXPO_PUBLIC_SPACETIME_DB,
    });
  }

  return {
    ...config,
    name: config.name ?? 'Orbit',
    slug: config.slug ?? 'orbit',
    ios: {
      ...config.ios,
      bundleIdentifier: 'com.dllim.orbitmhacks26',
    },
  };
};
