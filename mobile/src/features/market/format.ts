/** Display helpers for market intelligence. Values are shown as published; nothing is simulated. */

export function money(value: number, currency = 'USD'): string {
  return value.toLocaleString('en-US', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Short venue name, e.g. "NASDAQ NMS - GLOBAL MARKET" → "Nasdaq". */
export function exchangeLabel(exchange: string): string {
  const upper = exchange.toUpperCase();
  if (upper.startsWith('NASDAQ')) return 'Nasdaq';
  if (upper.startsWith('NEW YORK STOCK EXCHANGE') || upper.startsWith('NYSE')) return 'NYSE';
  return exchange.split(' - ')[0].replace(/,?\s*INC\.?$/i, '');
}

export function signedPct(fraction: number, digits = 2): string {
  const pct = fraction * 100;
  return `${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(digits)}%`;
}

export function signedPoints(fraction: number): string {
  const pts = fraction * 100;
  return `${pts >= 0 ? '+' : '−'}${Math.abs(pts).toFixed(2)} pts`;
}

/** Local time with zone, e.g. "Fri, Oct 2, 4:00 PM EDT". */
export function stamp(d: Date): string {
  return d.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

export function sessionLabel(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export function ago(from: Date, now: number): string {
  const s = Math.max(0, Math.round((now - from.getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}

export const FEATURE_LABELS: Record<string, string> = {
  relative_momentum: 'Relative momentum (1/5/20-day vs benchmark)',
  vol_adjusted_momentum: 'Volatility-adjusted momentum',
  abnormal_volume: 'Completed-day volume vs 20-day average',
  news_velocity: 'News velocity',
  sentiment_shift: 'Sentiment shift',
  breadth_materiality: 'Source breadth & materiality',
};

export type FeedKind = 'sip' | 'iex' | 'none';

/** Which daily-history feed the probed Alpaca capability is actually using. */
export function historyFeed(capabilities: { key: string; available: boolean; detail: string }[]): FeedKind {
  const bars = capabilities.find(c => c.key === 'alpaca.historical_bars');
  if (!bars?.available) return 'none';
  if (bars.detail.includes('feed=iex') || bars.detail.includes('not consolidated')) return 'iex';
  return 'sip';
}

export function providerLabel(provider: string): string {
  if (provider === 'finnhub+alpaca') return 'Quotes: Finnhub · Daily history: Alpaca';
  if (provider === 'finnhub') return 'Finnhub';
  if (provider === 'fixture') return 'Test fixture';
  return provider;
}

/** Plain-language note. Internal quote bookkeeping stays in the raw note list. */
export function explainNote(note: string): string | null {
  if (note === 'adjustment:split') return 'Prices and volume are adjusted for stock splits, not dividends.';
  if (note === 'iex_volume_not_consolidated') return 'Volume counts the IEX exchange only, not every US exchange.';
  if (note === 'history_source:alpaca_sip') return 'Daily history: Alpaca consolidated US tape.';
  if (note === 'history_source:alpaca_iex') return 'Daily history: Alpaca IEX feed.';
  if (note.startsWith('history_source:')) return `Daily history: ${note.slice('history_source:'.length)}.`;
  if (note.startsWith('benchmark_fallback:')) {
    const fallback = note.split('->')[1];
    return fallback ? `The sector benchmark was missing, so ${fallback} was used instead.` : note;
  }
  if (note.startsWith('history_unavailable:')) return 'Daily history could not be refreshed for this stock.';
  if (note === 'quote_stale') return 'The latest quote is older than the usual update window.';
  if (note.startsWith('quote_')) return null;
  return note;
}

export function explainReason(reason: string | null): string {
  if (!reason) return '';
  const [code, detail] = reason.split(/:(.*)/s);
  switch (code) {
    case 'insufficient_history': {
      const [have, need] = (detail ?? '').split('/');
      return `Needs ${need} completed sessions of history; ${have} available.`;
    }
    case 'insufficient_baseline': {
      const [have, need] = (detail ?? '').split('/');
      return `Needs ${need} prior observations to normalize; ${have} available.`;
    }
    case 'volume_unavailable':
      return 'Completed-day volume is not available from the current data source.';
    case 'news_phase_pending':
      return 'News analysis is not connected yet.';
    case 'stale_history':
      return 'Stored history is behind the latest completed session.';
    case 'inconsistent_adjustment':
      return 'History mixes adjusted and unadjusted prices, so it is not used.';
    case 'possible_corporate_action':
      return `Large one-day jump on ${detail} may be a split; history paused until reconciled.`;
    case 'adjustment_conflict':
      return `The provider revised the ${detail} close; history paused until reconciled.`;
    case 'no_history':
      return 'No completed-session history yet.';
    default:
      return reason;
  }
}

/** `1234567` → `1,234,567`. Hermes' BigInt#toLocaleString ignores grouping, so it is done on the digits. */
function groupDigits(digits: string): string {
  return digits.replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Integer micro-units (1e-6). Display only; orders keep the integer. */
export function formatMicros(micros: string, digits = 2): string {
  if (!/^-?\d+$/.test(micros)) return '—';
  const negative = micros.startsWith('-');
  const digitsOnly = negative ? micros.slice(1) : micros;
  const padded = digitsOnly.padStart(7, '0');
  const whole = padded.slice(0, -6);
  const frac = padded.slice(-6, -6 + digits);
  return `${negative ? '−' : ''}$${groupDigits(whole)}.${frac}`;
}

export function formatShares(micros: string): string {
  if (!/^\d+$/.test(micros)) return '—';
  const padded = micros.padStart(7, '0');
  const whole = padded.slice(0, -6);
  const frac = padded.slice(-6).replace(/0+$/, '');
  return frac ? `${groupDigits(whole)}.${frac}` : groupDigits(whole);
}

export function parseDecimalMicros(text: string): bigint | null {
  const trimmed = text.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(trimmed)) return null;
  const [whole, frac = ''] = trimmed.split('.');
  const padded = (frac + '000000').slice(0, 6);
  const value = BigInt(whole) * 1_000_000n + BigInt(padded);
  return value > 0n ? value : null;
}
