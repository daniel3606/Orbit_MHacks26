/** Display helpers for market intelligence. Values are shown as published; nothing is simulated. */

export function money(value: number, currency = 'USD'): string {
  return value.toLocaleString('en-US', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
