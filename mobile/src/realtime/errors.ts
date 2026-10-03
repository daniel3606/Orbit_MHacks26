/** Stable app error with a code from the module (SenderError) or the client. */
export class AppError extends Error {
  constructor(
    readonly code: string,
    message?: string
  ) {
    super(message ?? code);
    this.name = 'AppError';
  }
}

const MESSAGES: Record<string, string> = {
  not_connected: 'You are offline. Changes are not queued — reconnect and try again.',
  request_timeout: 'The server did not confirm in time. Your saved profile below is the source of truth.',
  profile_already_exists: 'A profile already exists for this session.',
  profile_not_found: 'No profile exists yet for this session.',
  profile_version_conflict: 'Your preferences changed elsewhere. Review the latest values and save again.',
  invalid_sector_interests_count: 'Choose between 1 and 5 sectors.',
  invalid_sector_interests_duplicate: 'Each sector can be chosen once.',
  rate_limited: 'Too many requests in progress. Wait for one to finish.',
  session_rejected: 'The server rejected the saved session.',
  identity_changed: 'The server returned a different identity for the saved session.',
};

export function messageFor(code: string): string {
  if (MESSAGES[code]) return MESSAGES[code];
  if (code.startsWith('invalid_')) return 'One of the answers is not valid. Please review it.';
  return 'Something went wrong. Please try again.';
}

/** Extracts a stable code from SDK SenderError messages and other failures. */
export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  const raw = err instanceof Error ? err.message : String(err);
  const code = /^[a-z][a-z0-9_]{0,63}$/.test(raw.trim()) ? raw.trim() : 'unexpected_error';
  return new AppError(code, raw);
}
