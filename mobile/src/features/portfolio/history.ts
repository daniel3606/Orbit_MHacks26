import type { ClosePoint } from '@/features/market/series';
import type { PaperAccountVM, PaperOrderVM, PaperPositionVM } from '@/realtime/connection';

/**
 * Portfolio value over time, rebuilt from Orbit's own fills and published session closes.
 *
 * Nothing stores the account's equity history, so each session is valued as
 * cash then + shares held then × that session's close. The rebuild is only
 * drawn when the fills Orbit can see add up to every open position; a trade
 * placed outside Orbit, or one older than the orders view keeps, would make
 * the history wrong, so the chart is left out instead.
 */

export type ValuePoint = {
  /** `YYYY-MM-DD` session date, or null for the live account value. */
  sessionDate: string | null;
  value: number;
};

export type ValueHistory = {
  /** Oldest first. The last point is the account's own equity. */
  points: ValuePoint[];
  /** Value the change is measured from: the first point, usually the cash before the first fill. */
  base: number;
  /** Session the change is measured from. */
  since: string;
};

export type HistoryGap = 'no_fills' | 'untracked_positions' | 'no_closes';

type Fill = { ticker: string; day: string; shares: bigint; cash: bigint; price: number };

const MICROS = 1_000_000;

/** Exchange date of a timestamp, matching how sessions are dated. */
export function exchangeDay(at: Date): string {
  return at.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function fillsOf(orders: PaperOrderVM[]): Fill[] {
  const fills: Fill[] = [];
  for (const order of orders) {
    if (!/^\d+$/.test(order.filledQuantityMicros) || order.filledQuantityMicros === '0') continue;
    if (!order.filledAvgPriceMicros || !/^\d+$/.test(order.filledAvgPriceMicros)) continue;
    const shares = BigInt(order.filledQuantityMicros);
    // shares and price are both micros, so the product is micros².
    const cost = (shares * BigInt(order.filledAvgPriceMicros)) / BigInt(MICROS);
    const buy = order.side === 'buy';
    fills.push({
      ticker: order.ticker,
      // The orders view has no fill time; the last update is the closest stamp it keeps.
      day: exchangeDay(order.updatedAt),
      shares: buy ? shares : -shares,
      cash: buy ? -cost : cost,
      price: Number(order.filledAvgPriceMicros) / MICROS,
    });
  }
  return fills.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

/** True when Orbit's fills explain every open position share for share. */
function fillsMatchPositions(fills: Fill[], positions: PaperPositionVM[]): boolean {
  const net = new Map<string, bigint>();
  for (const fill of fills) net.set(fill.ticker, (net.get(fill.ticker) ?? 0n) + fill.shares);
  const held = new Map<string, bigint>();
  for (const position of positions) {
    if (!/^-?\d+$/.test(position.quantityMicros)) return false;
    held.set(position.ticker, BigInt(position.quantityMicros));
  }
  for (const ticker of new Set([...net.keys(), ...held.keys()])) {
    if ((net.get(ticker) ?? 0n) !== (held.get(ticker) ?? 0n)) return false;
  }
  return true;
}

export function valueHistory(
  account: PaperAccountVM,
  positions: PaperPositionVM[],
  orders: PaperOrderVM[],
  closes: Record<string, ClosePoint[]>,
): ValueHistory | HistoryGap {
  const fills = fillsOf(orders);
  if (fills.length === 0) return 'no_fills';
  if (!fillsMatchPositions(fills, positions)) return 'untracked_positions';

  const tickers = [...new Set(fills.map(fill => fill.ticker))];
  const byTicker = new Map(
    tickers.map(ticker => [ticker, new Map((closes[ticker] ?? []).filter(p => p.close > 0).map(p => [p.sessionDate, p.close]))]),
  );
  const sessions = [...new Set(tickers.flatMap(ticker => [...(byTicker.get(ticker)?.keys() ?? [])]))].sort();
  if (sessions.length === 0) return 'no_closes';

  const firstDay = fills[0].day;
  // One session before the first fill shows the starting cash; earlier sessions are flat.
  const before = sessions.filter(day => day < firstDay);
  const window = [...(before.length > 0 ? [before[before.length - 1]] : []), ...sessions.filter(day => day >= firstDay)];

  const cashNow = BigInt(account.cashMicros);
  const startCash = fills.reduce((cash, fill) => cash - fill.cash, cashNow);
  const shares = new Map<string, bigint>();
  const lastClose = new Map<string, number>();
  let cash = startCash;
  let next = 0;
  const points: ValuePoint[] = [];
  for (const day of window) {
    while (next < fills.length && fills[next].day <= day) {
      const fill = fills[next];
      shares.set(fill.ticker, (shares.get(fill.ticker) ?? 0n) + fill.shares);
      cash += fill.cash;
      // A fill older than the published closes is valued at its own price until a close exists.
      if (!lastClose.has(fill.ticker)) lastClose.set(fill.ticker, fill.price);
      next += 1;
    }
    let value = Number(cash) / MICROS;
    for (const [ticker, held] of shares) {
      if (held === 0n) continue;
      const close = byTicker.get(ticker)?.get(day) ?? lastClose.get(ticker);
      if (close == null) continue;
      lastClose.set(ticker, close);
      value += (Number(held) / MICROS) * close;
    }
    points.push({ sessionDate: day, value });
  }

  const equity = Number(BigInt(account.equityMicros)) / MICROS;
  const today = exchangeDay(account.providerTime);
  if (points.length > 0 && points[points.length - 1].sessionDate === today) points.pop();
  points.push({ sessionDate: null, value: equity });

  return { points, base: points[0].value, since: window[0] };
}
