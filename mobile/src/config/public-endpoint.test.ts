import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ProductionConfigError, resolveClientConfig } from './public-endpoint.ts';

const release = {
  appEnv: 'production',
  dev: false,
  devHost: '192.168.1.20',
  devHostSource: 'Metro bundle host',
};

describe('public SpacetimeDB endpoint', () => {
  it('uses the Metro host in development when no URI is set', () => {
    const config = resolveClientConfig({
      explicitUri: '',
      database: '',
      appEnv: undefined,
      dev: true,
      devHost: '192.168.1.20',
      devHostSource: 'Metro bundle host',
    });
    assert.equal(config.spacetimeUri, 'ws://192.168.1.20:3000');
    assert.equal(config.spacetimeDatabase, 'orbit-dev');
    assert.equal(config.sessionScope, 'devhost');
  });

  it('keeps an explicit development URI, including a LAN address', () => {
    const config = resolveClientConfig({
      explicitUri: 'ws://10.0.0.8:3000',
      database: 'orbit-dev',
      appEnv: 'development',
      dev: true,
      devHost: '127.0.0.1',
      devHostSource: 'Expo manifest hostUri',
    });
    assert.equal(config.spacetimeUri, 'ws://10.0.0.8:3000');
    assert.equal(config.sessionScope, '10.0.0.8:3000');
  });

  it('accepts a public wss URL for a production build', () => {
    const config = resolveClientConfig({
      ...release,
      explicitUri: 'wss://orbit.example.com',
      database: 'orbit-dev',
    });
    assert.equal(config.spacetimeUri, 'wss://orbit.example.com');
    assert.equal(config.spacetimeDatabase, 'orbit-dev');
    assert.equal(config.spacetimeUriSource, 'EXPO_PUBLIC_SPACETIME_URI');
  });

  it('refuses a missing, local, or non-wss URL in production', () => {
    const rejected = ['', 'ws://127.0.0.1:3000', 'ws://orbit.example.com', 'wss://192.168.1.20:3000', 'wss://localhost:3000'];
    for (const explicitUri of rejected) {
      assert.throws(
        () => resolveClientConfig({ ...release, explicitUri, database: 'orbit-dev' }),
        ProductionConfigError,
      );
    }
  });

  it('does not fall back to the dev machine when a release build is misconfigured', () => {
    assert.throws(
      () => resolveClientConfig({ ...release, explicitUri: undefined, database: 'orbit-dev' }),
      /EXPO_PUBLIC_SPACETIME_URI/,
    );
  });

  it('requires the database name in production', () => {
    assert.throws(
      () =>
        resolveClientConfig({
          ...release,
          explicitUri: 'wss://orbit.example.com',
          database: ' ',
        }),
      /EXPO_PUBLIC_SPACETIME_DB/,
    );
  });
});
