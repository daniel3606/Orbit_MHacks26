import { SenderError, t } from 'spacetimedb/server';
import type { Identity } from 'spacetimedb';
import spacetimedb from './schema';
import { requireConsumer, type Ctx } from './auth';

const MAX_TITLE = 80;
const MAX_BODY = 240;
const MAX_HREF = 64;
const MAX_DEDUPE = 96;
const INBOX_LIMIT = 50;

export const NOTIFICATION_KIND = {
  welcome: 'welcome',
  orderFilled: 'order_filled',
  orderPartial: 'order_partially_filled',
  orderRejected: 'order_rejected',
  orderCanceled: 'order_canceled',
  dailyBriefReady: 'daily_brief_ready',
  dailyDiscoveryReady: 'daily_discovery_ready',
} as const;

type PushInput = {
  kind: string;
  title: string;
  body: string;
  ticker?: string;
  href?: string;
  dedupeKey: string;
};

function pruneInbox(ctx: Ctx, owner: Identity) {
  const rows = [...ctx.db.notification.by_owner.filter(owner)].sort((a, b) =>
    Number(b.createdAt.microsSinceUnixEpoch - a.createdAt.microsSinceUnixEpoch)
  );
  for (const old of rows.slice(INBOX_LIMIT)) {
    ctx.db.notification.id.delete(old.id);
  }
}

/** Inserts one inbox row unless `dedupeKey` already exists for the owner. */
export function pushNotification(ctx: Ctx, owner: Identity, input: PushInput): void {
  if (input.title.length === 0 || input.title.length > MAX_TITLE) throw new SenderError('invalid_notification');
  if (input.body.length === 0 || input.body.length > MAX_BODY) throw new SenderError('invalid_notification');
  if (input.dedupeKey.length === 0 || input.dedupeKey.length > MAX_DEDUPE) {
    throw new SenderError('invalid_notification');
  }
  if (input.href !== undefined && (input.href.length === 0 || input.href.length > MAX_HREF)) {
    throw new SenderError('invalid_notification');
  }
  for (const _existing of ctx.db.notification.by_owner_dedupe.filter([owner, input.dedupeKey])) return;

  ctx.db.notification.insert({
    id: 0n,
    owner,
    kind: input.kind,
    title: input.title,
    body: input.body,
    ticker: input.ticker,
    href: input.href,
    dedupeKey: input.dedupeKey,
    readAt: undefined,
    createdAt: ctx.timestamp,
  });
  pruneInbox(ctx, owner);
}

function formatShares(quantityMicros: bigint): string {
  const whole = quantityMicros / 1_000_000n;
  const frac = quantityMicros % 1_000_000n;
  if (frac === 0n) return whole.toString();
  const fracText = frac.toString().padStart(6, '0').replace(/0+$/, '');
  return `${whole}.${fracText}`;
}

function formatUsd(priceMicros: bigint): string {
  const dollars = priceMicros / 1_000_000n;
  const cents = (priceMicros % 1_000_000n) / 10_000n;
  return `$${dollars.toString()}.${cents.toString().padStart(2, '0')}`;
}

/**
 * Brokerage apps notify on fill / partial / reject / cancel. Called when a
 * paper order's status changes into one of those states.
 */
export function notifyOrderStatusChange(
  ctx: Ctx,
  owner: Identity,
  order: {
    clientOrderKey: string;
    ticker: string;
    side: string;
    status: string;
    filledQuantityMicros: bigint;
    filledAvgPriceMicros?: bigint;
    rejectReason?: string;
  }
): void {
  const sideLabel = order.side === 'sell' ? 'Sell' : 'Buy';
  const shares =
    order.filledQuantityMicros > 0n ? formatShares(order.filledQuantityMicros) : null;
  const price =
    order.filledAvgPriceMicros !== undefined ? formatUsd(order.filledAvgPriceMicros) : null;

  if (order.status === 'filled') {
    pushNotification(ctx, owner, {
      kind: NOTIFICATION_KIND.orderFilled,
      title: `${order.ticker} order filled`,
      body:
        shares && price
          ? `${sideLabel} ${shares} share${shares === '1' ? '' : 's'} of ${order.ticker} at ${price}.`
          : `Your ${sideLabel.toLowerCase()} order for ${order.ticker} filled.`,
      ticker: order.ticker,
      href: '/portfolio',
      dedupeKey: `order:${order.clientOrderKey}:filled`,
    });
    return;
  }
  if (order.status === 'partially_filled') {
    pushNotification(ctx, owner, {
      kind: NOTIFICATION_KIND.orderPartial,
      title: `${order.ticker} partially filled`,
      body:
        shares && price
          ? `${sideLabel} ${shares} share${shares === '1' ? '' : 's'} of ${order.ticker} filled so far at ${price}.`
          : `Your ${sideLabel.toLowerCase()} order for ${order.ticker} is partially filled.`,
      ticker: order.ticker,
      href: '/portfolio',
      dedupeKey: `order:${order.clientOrderKey}:partially_filled`,
    });
    return;
  }
  if (order.status === 'rejected') {
    const reason = order.rejectReason?.trim();
    pushNotification(ctx, owner, {
      kind: NOTIFICATION_KIND.orderRejected,
      title: `${order.ticker} order rejected`,
      body: reason
        ? `Your ${sideLabel.toLowerCase()} order for ${order.ticker} was rejected: ${reason}`.slice(0, MAX_BODY)
        : `Your ${sideLabel.toLowerCase()} order for ${order.ticker} was rejected.`,
      ticker: order.ticker,
      href: '/portfolio',
      dedupeKey: `order:${order.clientOrderKey}:rejected`,
    });
    return;
  }
  if (order.status === 'canceled') {
    pushNotification(ctx, owner, {
      kind: NOTIFICATION_KIND.orderCanceled,
      title: `${order.ticker} order canceled`,
      body: `Your ${sideLabel.toLowerCase()} order for ${order.ticker} was canceled.`,
      ticker: order.ticker,
      href: '/portfolio',
      dedupeKey: `order:${order.clientOrderKey}:canceled`,
    });
  }
}

export function notifyDailyBriefReady(ctx: Ctx, owner: Identity, clientKey: string): void {
  pushNotification(ctx, owner, {
    kind: NOTIFICATION_KIND.dailyBriefReady,
    title: 'Today’s brief is ready',
    body: 'Orbit prepared a short note for your home screen.',
    href: '/',
    dedupeKey: `brief:${clientKey}`,
  });
}

export function notifyDailyDiscoveryReady(
  ctx: Ctx,
  owner: Identity,
  discoveryDate: string,
  title: string,
  itemCount: number
): void {
  pushNotification(ctx, owner, {
    kind: NOTIFICATION_KIND.dailyDiscoveryReady,
    title: 'Daily Discovery is ready',
    body: `${title} — ${itemCount} compan${itemCount === 1 ? 'y' : 'ies'} to explore today.`,
    href: '/discover',
    dedupeKey: `discovery:${discoveryDate}`,
  });
}

export function notifyWelcome(ctx: Ctx, owner: Identity): void {
  pushNotification(ctx, owner, {
    kind: NOTIFICATION_KIND.welcome,
    title: 'Welcome to Orbit',
    body: 'Discover companies, ask Orbit questions, and practice with virtual money.',
    href: '/',
    dedupeKey: 'welcome',
  });
}

/** Marks one of the caller's notifications as read. */
export const markNotificationRead = spacetimedb.reducer(
  { notificationId: t.u64() },
  (ctx, { notificationId }) => {
    requireConsumer(ctx);
    const row = ctx.db.notification.id.find(notificationId);
    if (!row || !row.owner.isEqual(ctx.sender)) throw new SenderError('notification_not_found');
    if (row.readAt !== undefined) return;
    ctx.db.notification.id.update({ ...row, readAt: ctx.timestamp });
  }
);

/** Marks every unread notification for the caller as read. */
export const markAllNotificationsRead = spacetimedb.reducer({}, ctx => {
  requireConsumer(ctx);
  for (const row of ctx.db.notification.by_owner.filter(ctx.sender)) {
    if (row.readAt !== undefined) continue;
    ctx.db.notification.id.update({ ...row, readAt: ctx.timestamp });
  }
});
