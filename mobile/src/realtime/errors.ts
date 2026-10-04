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
  rate_limited: 'Please wait a moment before trying that again.',
  paper_not_enabled: 'Paper trading is not turned on for this guest.',
  paper_demo_already_bound: 'The paper account is already bound to another guest.',
  insufficient_cash: 'The paper account does not have enough cash for this order.',
  insufficient_shares: 'You do not have enough shares for this sale.',
  not_tradable: 'This stock cannot be traded on the paper account.',
  whole_shares_only: 'This stock only accepts whole shares.',
  notional_not_supported: 'This stock does not accept a dollar amount. Enter a whole number of shares.',
  quote_stale: 'The price is too old to use for an order.',
  invalid_order_amount: 'Enter a share quantity or a dollar amount, not both.',
  session_rejected: 'The server rejected the saved session.',
  identity_changed: 'The server returned a different identity for the saved session.',
  invalid_message_length: 'Keep the question under 500 characters.',
  invalid_request_key: 'That question could not be sent. Try again.',
  assistant_unavailable: 'Orbit cannot answer right now.',
  assistant_busy: 'Orbit is still answering. Start a new chat once it finishes.',
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
