/**
 * Public SpacetimeDB address resolution.
 *
 * Release builds talk only to an explicit public `wss://` host. Development
 * may use the Metro machine or an explicit LAN address. Nothing in this
 * module may read a secret.
 */

export class ProductionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProductionConfigError';
  }
}

const DATABASE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isPrivateHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host === 'host.docker.internal'
  ) {
    return true;
  }
  if (host.endsWith('.local') || host.endsWith('.internal')) return true;

  const parts = host.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) return false;
  const numbers = parts.map(Number);
  if (numbers.some((part) => part > 255)) return false;
  const a = numbers[0] ?? 0;
  const b = numbers[1] ?? 0;
  if (a === 10 || a === 127) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  // Carrier-grade NAT. Not a publicly reachable host.
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

export function assertReleaseSpacetimeConfig(input: {
  uri: string | undefined;
  database: string | undefined;
}): { uri: string; database: string } {
  const uri = input.uri?.trim() ?? '';
  const database = input.database?.trim() ?? '';
  if (!uri) {
    throw new ProductionConfigError(
      'Production requires EXPO_PUBLIC_SPACETIME_URI set to a public wss:// SpacetimeDB URL. Localhost is not used as a fallback.',
    );
  }
  if (!database || !DATABASE_NAME.test(database)) {
    throw new ProductionConfigError(
      'Production requires EXPO_PUBLIC_SPACETIME_DB (lowercase letters, numbers, and single hyphens).',
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new ProductionConfigError('EXPO_PUBLIC_SPACETIME_URI is not a valid URL.');
  }
  if (parsed.protocol !== 'wss:') {
    throw new ProductionConfigError('Production EXPO_PUBLIC_SPACETIME_URI must use wss://.');
  }
  if (!parsed.hostname || isPrivateHostname(parsed.hostname)) {
    throw new ProductionConfigError(
      'Production EXPO_PUBLIC_SPACETIME_URI must be a public host. Localhost and private network addresses are refused.',
    );
  }
  return { uri, database };
}

export function resolveClientConfig(input: {
  explicitUri: string | undefined;
  database: string | undefined;
  appEnv: string | undefined;
  dev: boolean;
  devHost: string | undefined;
  devHostSource: string | undefined;
}): {
  spacetimeUri: string;
  spacetimeUriSource: string;
  spacetimeDatabase: string;
  sessionScope: string;
} {
  const explicitUri = input.explicitUri?.trim();
  const release = !input.dev || input.appEnv === 'production';
  if (release) {
    const checked = assertReleaseSpacetimeConfig({ uri: explicitUri, database: input.database });
    return {
      spacetimeUri: checked.uri,
      spacetimeUriSource: 'EXPO_PUBLIC_SPACETIME_URI',
      spacetimeDatabase: checked.database,
      sessionScope: checked.uri.replace(/^wss?:\/\//, ''),
    };
  }

  const devHost = explicitUri ? undefined : input.devHost;
  const spacetimeUri = explicitUri || (devHost ? `ws://${devHost}:3000` : 'ws://127.0.0.1:3000');
  return {
    spacetimeUri,
    spacetimeUriSource: explicitUri
      ? 'EXPO_PUBLIC_SPACETIME_URI'
      : input.devHostSource ?? 'default (simulator only)',
    spacetimeDatabase: input.database?.trim() || 'orbit-dev',
    sessionScope: explicitUri ? explicitUri.replace(/^wss?:\/\//, '') : 'devhost',
  };
}
