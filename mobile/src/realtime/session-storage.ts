import * as SecureStore from 'expo-secure-store';

/**
 * Persists the SpacetimeDB identity token in the iOS Keychain / Android
 * Keystore. `THIS_DEVICE_ONLY` keeps it out of backups and device migration:
 * this is a device-bound guest session, not a recoverable account.
 *
 * Keys are scoped to `config.sessionScope` + database (see config/env.ts).
 */
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

export type StoredSession = { token: string; identityHex: string; createdAt: string };

function keyFor(scope: string, database: string): string {
  return `orbit.session.v1.${scope}_${database}`.replace(/[^A-Za-z0-9._-]/g, '_');
}

export async function loadSession(scope: string, database: string): Promise<StoredSession | null> {
  const raw = await SecureStore.getItemAsync(keyFor(scope, database), OPTIONS);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredSession>;
    if (typeof parsed.token === 'string' && typeof parsed.identityHex === 'string') {
      return { token: parsed.token, identityHex: parsed.identityHex, createdAt: parsed.createdAt ?? '' };
    }
  } catch {
    // fall through: surface corruption instead of silently minting a new identity
  }
  throw new Error('stored_session_corrupt');
}

export async function saveSession(scope: string, database: string, session: StoredSession): Promise<void> {
  await SecureStore.setItemAsync(keyFor(scope, database), JSON.stringify(session), OPTIONS);
}

export async function clearSession(scope: string, database: string): Promise<void> {
  await SecureStore.deleteItemAsync(keyFor(scope, database), OPTIONS);
}
