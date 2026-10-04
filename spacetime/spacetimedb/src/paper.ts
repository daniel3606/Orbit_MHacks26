import { SenderError, t } from 'spacetimedb/server';
import type { Identity } from 'spacetimedb';
import spacetimedb from './schema';
import { requireAdmin, requireConsumer, requireService, type Ctx } from './auth';
import { enqueuePaperReconcile, enqueuePaperSubmit, JOB_KIND, JOB_STATUS, requireLease } from './jobs';
import { notifyOrderStatusChange } from './notifications';

export const PAPER_SLOT = 'demo';
const ORDER_STATUSES = [
  'queued',
  'submitting',
  'submitted',
  'pending',
  'partially_filled',
  'filled',
  'rejected',
  'canceled',
  'reconciling',
] as const;
const TERMINAL = new Set(['filled', 'rejected', 'canceled']);
const SIDES = ['buy', 'sell'];
const KEY_PATTERN = /^orbit-[A-Za-z0-9]{8,40}$/;
const TICKER_PATTERN = /^[A-Z][A-Z0-9.]{0,9}$/;
const MAX_MICROS = 1_000_000_000_000_000n;
const OPEN_POLL_SECONDS = 15;
const CLOSED_POLL_SECONDS = 60;

const PositionInput = t.object('PaperPositionInput', {
  ticker: t.string(),
  quantityMicros: t.i64(),
  avgEntryMicros: t.i64(),
  marketValueMicros: t.option(t.i64()),
  unrealizedPlMicros: t.option(t.i64()),
});

const OrderUpdate = t.object('PaperOrderUpdate', {
  clientOrderKey: t.string(),
  status: t.string(),
  providerOrderId: t.option(t.string()),
  filledQuantityMicros: t.i64(),
  filledAvgPriceMicros: t.option(t.i64()),
  rejectReason: t.option(t.string()),
});

type PositionIn = {
  ticker: string;
  quantityMicros: bigint;
  avgEntryMicros: bigint;
  marketValueMicros?: bigint;
  unrealizedPlMicros?: bigint;
};
type OrderIn = {
  clientOrderKey: string;
  status: string;
  providerOrderId?: string;
  filledQuantityMicros: bigint;
  filledAvgPriceMicros?: bigint;
  rejectReason?: string;
};

export function paperDemoOwner(ctx: Ctx): Identity | undefined {
  return ctx.db.paperBinding.slot.find(PAPER_SLOT)?.owner;
}

function requireDemo(ctx: Ctx) {
  const owner = paperDemoOwner(ctx);
  if (!owner || !owner.isEqual(ctx.sender)) throw new SenderError('paper_not_enabled');
  return owner;
}

/** Admin binds one identity. A different identity is refused so the account is not silently shared. */
export const bindPaperDemo = spacetimedb.reducer({ identity: t.identity() }, (ctx, { identity }) => {
  requireAdmin(ctx);
  if (ctx.db.serviceIdentity.identity.find(identity)) throw new SenderError('service_cannot_own_profile');
  const existing = ctx.db.paperBinding.slot.find(PAPER_SLOT);
  if (existing && !existing.owner.isEqual(identity)) throw new SenderError('paper_demo_already_bound');
  const row = {
    slot: PAPER_SLOT,
    owner: identity,
    providerAccountId: existing?.providerAccountId ?? '',
    boundAt: existing?.boundAt ?? ctx.timestamp,
  };
  if (existing) ctx.db.paperBinding.slot.update(row);
  else ctx.db.paperBinding.insert(row);
});

const PAPER_JOB_KINDS = new Set<string>([JOB_KIND.submitPaperOrder, JOB_KIND.reconcilePaperAccount]);

/**
 * Admin moves the existing demo binding to another guest.
 * The provider account id is kept. Queued and leased paper jobs for the previous
 * owner are failed in this same transaction so they cannot submit or publish afterward.
 * Profiles and sessions are not touched. First-time binding stays on `bind_paper_demo`.
 */
export const rebindPaperDemo = spacetimedb.reducer({ identity: t.identity() }, (ctx, { identity }) => {
  requireAdmin(ctx);
  if (ctx.db.serviceIdentity.identity.find(identity)) throw new SenderError('service_cannot_own_profile');
  const existing = ctx.db.paperBinding.slot.find(PAPER_SLOT);
  if (!existing) throw new SenderError('paper_not_bound');
  if (existing.owner.isEqual(identity)) return;

  const previous = existing.owner;
  ctx.db.paperBinding.slot.update({
    ...existing,
    owner: identity,
    providerAccountId: existing.providerAccountId,
    boundAt: ctx.timestamp,
  });
  for (const row of ctx.db.job.owner.filter(previous)) {
    if (!PAPER_JOB_KINDS.has(row.kind)) continue;
    if (row.status !== JOB_STATUS.queued && row.status !== JOB_STATUS.running && row.status !== JOB_STATUS.retryWait) {
      continue;
    }
    ctx.db.job.jobId.update({
      ...row,
      status: JOB_STATUS.failed,
      errorCode: 'binding_rebound',
      leaseOwner: undefined,
      leaseUntil: undefined,
      updatedAt: ctx.timestamp,
    });
  }
});

/** Confirmed order intent. Does not submit to Alpaca and is not a fill. */
export const createPaperOrderIntent = spacetimedb.reducer(
  {
    ticker: t.string(),
    side: t.string(),
    quantityMicros: t.option(t.i64()),
    notionalMicros: t.option(t.i64()),
    clientOrderKey: t.string(),
    quoteMicros: t.i64(),
    quoteTime: t.timestamp(),
  },
  (ctx, args) => {
    requireConsumer(ctx);
    requireDemo(ctx);
    if (!TICKER_PATTERN.test(args.ticker)) throw new SenderError('unknown_ticker');
    const stock = ctx.db.stock.ticker.find(args.ticker);
    if (!stock || !stock.active || stock.kind !== 'equity') throw new SenderError('unknown_ticker');
    if (!SIDES.includes(args.side)) throw new SenderError('invalid_side');
    if (!KEY_PATTERN.test(args.clientOrderKey)) throw new SenderError('invalid_request_key');
    const hasQty = args.quantityMicros !== undefined;
    const hasNotional = args.notionalMicros !== undefined;
    if (hasQty === hasNotional) throw new SenderError('invalid_order_amount');
    const amount = args.quantityMicros ?? args.notionalMicros;
    if (amount === undefined || amount <= 0n || amount > MAX_MICROS) throw new SenderError('invalid_order_amount');
    if (args.quoteMicros <= 0n || args.quoteMicros > MAX_MICROS) throw new SenderError('invalid_price');
    if (args.quoteTime.microsSinceUnixEpoch > ctx.timestamp.microsSinceUnixEpoch + 60_000_000n) {
      throw new SenderError('future_timestamp');
    }
    for (const row of ctx.db.paperOrder.by_owner_key.filter([ctx.sender, args.clientOrderKey])) {
      return; // same confirmation retried
    }

    let active = 0;
    for (const row of ctx.db.job.owner.filter(ctx.sender)) {
      if (row.kind === JOB_KIND.submitPaperOrder && (row.status === JOB_STATUS.queued || row.status === JOB_STATUS.running || row.status === JOB_STATUS.retryWait)) {
        active++;
      }
    }
    if (active >= 3) throw new SenderError('rate_limited');

    ctx.db.paperOrder.insert({
      orderId: 0n,
      owner: ctx.sender,
      clientOrderKey: args.clientOrderKey,
      ticker: args.ticker,
      side: args.side,
      quantityMicros: args.quantityMicros,
      notionalMicros: args.notionalMicros,
      quoteMicros: args.quoteMicros,
      quoteTime: args.quoteTime,
      status: 'queued',
      providerOrderId: undefined,
      filledQuantityMicros: 0n,
      filledAvgPriceMicros: undefined,
      rejectReason: undefined,
      revision: 0n,
      createdAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
    });
    enqueuePaperSubmit(ctx, ctx.sender, args.clientOrderKey);
  }
);

/** Demo user asks for a fresh account snapshot. Coalesced. */
export const requestPaperSync = spacetimedb.reducer(ctx => {
  requireConsumer(ctx);
  requireDemo(ctx);
  enqueuePaperReconcile(ctx, ctx.sender, 0);
});

/** Worker startup: sync the bound account if one was explicitly configured. */
export const requestPaperReconcile = spacetimedb.reducer(ctx => {
  requireService(ctx);
  const owner = paperDemoOwner(ctx);
  if (!owner) return;
  enqueuePaperReconcile(ctx, owner, 0);
});

/**
 * Writes one coherent paper revision and completes the leased job.
 * An older revision is rejected with nothing written.
 */
export const applyPaperSnapshot = spacetimedb.reducer(
  {
    jobId: t.u64(),
    attempt: t.u32(),
    revision: t.u64(),
    providerAccountId: t.string(),
    cashMicros: t.i64(),
    equityMicros: t.i64(),
    buyingPowerMicros: t.i64(),
    currency: t.string(),
    providerTime: t.timestamp(),
    marketOpen: t.bool(),
    nextOpen: t.option(t.timestamp()),
    nextClose: t.option(t.timestamp()),
    positions: t.array(PositionInput),
    orders: t.array(OrderUpdate),
  },
  (ctx, args) => {
    requireService(ctx);
    const { row: job, holdsLease } = requireLease(ctx, args.jobId, args.attempt);
    if (job.kind !== JOB_KIND.submitPaperOrder && job.kind !== JOB_KIND.reconcilePaperAccount) {
      throw new SenderError('wrong_job_kind');
    }
    if (!holdsLease) throw new SenderError('lease_mismatch');
    const binding = ctx.db.paperBinding.slot.find(PAPER_SLOT);
    if (!binding || !binding.owner.isEqual(job.owner)) throw new SenderError('paper_not_enabled');
    const current = ctx.db.paperAccount.owner.find(job.owner);
    if (current && args.revision <= current.revision) {
      if (job.status === JOB_STATUS.succeeded && args.revision === current.revision) return;
      throw new SenderError('stale_revision');
    }
    if (args.revision === 0n) throw new SenderError('stale_revision');
    if (job.status !== JOB_STATUS.running) throw new SenderError('job_not_running');
    const now = ctx.timestamp.microsSinceUnixEpoch;
    if (job.leaseUntil === undefined || job.leaseUntil.microsSinceUnixEpoch < now) throw new SenderError('lease_expired');
    if (args.providerAccountId.length < 4 || args.providerAccountId.length > 64) throw new SenderError('invalid_account');
    if (binding.providerAccountId && binding.providerAccountId !== args.providerAccountId) {
      throw new SenderError('paper_account_mismatch');
    }
    if (args.currency !== 'USD') throw new SenderError('invalid_currency');
    if (args.providerTime.microsSinceUnixEpoch > now + 5n * 60n * 1_000_000n) throw new SenderError('future_timestamp');
    for (const value of [args.cashMicros, args.equityMicros, args.buyingPowerMicros]) {
      if (value < 0n || value > MAX_MICROS) throw new SenderError('invalid_money');
    }

    const seenPos = new Set<string>();
    for (const position of args.positions as PositionIn[]) {
      if (!TICKER_PATTERN.test(position.ticker) || seenPos.has(position.ticker)) throw new SenderError('invalid_position');
      seenPos.add(position.ticker);
      if (position.quantityMicros <= 0n || position.avgEntryMicros <= 0n) throw new SenderError('invalid_position');
      if (position.quantityMicros > MAX_MICROS || position.avgEntryMicros > MAX_MICROS) throw new SenderError('invalid_position');
    }
    const seenOrders = new Set<string>();
    for (const update of args.orders as OrderIn[]) {
      if (seenOrders.has(update.clientOrderKey)) throw new SenderError('duplicate_order');
      seenOrders.add(update.clientOrderKey);
      if (!ORDER_STATUSES.includes(update.status as (typeof ORDER_STATUSES)[number])) throw new SenderError('invalid_order_status');
      if (update.status === 'queued') throw new SenderError('invalid_order_status');
      let found = false;
      for (const _row of ctx.db.paperOrder.by_owner_key.filter([job.owner, update.clientOrderKey])) found = true;
      if (!found) throw new SenderError('order_not_found');
      if (update.filledQuantityMicros < 0n) throw new SenderError('invalid_order_amount');
      if (update.status === 'filled' && update.filledQuantityMicros <= 0n) throw new SenderError('fill_without_quantity');
    }

    const account = {
      owner: job.owner,
      providerAccountId: args.providerAccountId,
      cashMicros: args.cashMicros,
      equityMicros: args.equityMicros,
      buyingPowerMicros: args.buyingPowerMicros,
      currency: args.currency,
      revision: args.revision,
      providerTime: args.providerTime,
      syncedAt: ctx.timestamp,
      marketOpen: args.marketOpen,
      nextOpen: args.nextOpen,
      nextClose: args.nextClose,
    };
    if (current) ctx.db.paperAccount.owner.update(account);
    else ctx.db.paperAccount.insert(account);
    if (!binding.providerAccountId) {
      ctx.db.paperBinding.slot.update({ ...binding, providerAccountId: args.providerAccountId });
    }
    for (const old of [...ctx.db.paperPosition.by_owner.filter(job.owner)]) ctx.db.paperPosition.id.delete(old.id);
    for (const position of args.positions as PositionIn[]) {
      ctx.db.paperPosition.insert({
        id: 0n,
        owner: job.owner,
        ticker: position.ticker,
        quantityMicros: position.quantityMicros,
        avgEntryMicros: position.avgEntryMicros,
        marketValueMicros: position.marketValueMicros,
        unrealizedPlMicros: position.unrealizedPlMicros,
        revision: args.revision,
      });
    }
    let pending = false;
    for (const update of args.orders as OrderIn[]) {
      for (const row of ctx.db.paperOrder.by_owner_key.filter([job.owner, update.clientOrderKey])) {
        const previousStatus = row.status;
        ctx.db.paperOrder.orderId.update({
          ...row,
          status: update.status,
          providerOrderId: update.providerOrderId ?? row.providerOrderId,
          filledQuantityMicros: update.filledQuantityMicros,
          filledAvgPriceMicros: update.filledAvgPriceMicros,
          rejectReason: update.rejectReason,
          revision: args.revision,
          updatedAt: ctx.timestamp,
        });
        // Brokerage apps alert when an order fills, partially fills, rejects, or cancels.
        if (previousStatus !== update.status) {
          notifyOrderStatusChange(ctx, job.owner, {
            clientOrderKey: update.clientOrderKey,
            ticker: row.ticker,
            side: row.side,
            status: update.status,
            filledQuantityMicros: update.filledQuantityMicros,
            filledAvgPriceMicros: update.filledAvgPriceMicros,
            rejectReason: update.rejectReason,
          });
        }
      }
      if (!TERMINAL.has(update.status)) pending = true;
    }
    // Orders not mentioned keep their status. A still-open local order also needs another poll.
    for (const row of ctx.db.paperOrder.owner.filter(job.owner)) {
      if (!TERMINAL.has(row.status)) pending = true;
    }
    if (pending) enqueuePaperReconcile(ctx, job.owner, args.marketOpen ? OPEN_POLL_SECONDS : CLOSED_POLL_SECONDS);

    ctx.db.job.jobId.update({
      ...job,
      status: JOB_STATUS.succeeded,
      resultRef: `revision=${args.revision};orders=${args.orders.length}`,
      errorCode: undefined,
      leaseUntil: undefined,
      updatedAt: ctx.timestamp,
    });
  }
);
