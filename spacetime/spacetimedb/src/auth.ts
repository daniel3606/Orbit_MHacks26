import { SenderError, type InferSchema, type ReducerCtx } from 'spacetimedb/server';
import type { Identity } from 'spacetimedb';
import spacetimedb from './schema';

export type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;

type ReadCtx = {
  db: { serviceIdentity: { identity: { find(identity: Identity): unknown } } };
};

export function isService(ctx: ReadCtx, identity: Identity): boolean {
  return ctx.db.serviceIdentity.identity.find(identity) != null;
}

/** Worker reducers: the caller must be on the server-configured allowlist. */
export function requireService(ctx: Ctx): void {
  if (!isService(ctx, ctx.sender)) throw new SenderError('not_authorized_service');
}

export function requireAdmin(ctx: Ctx): void {
  if (ctx.db.moduleAdmin.identity.find(ctx.sender) == null) {
    throw new SenderError('not_authorized_admin');
  }
}

/** Services act on behalf of the system; they never own consumer records. */
export function requireConsumer(ctx: Ctx): void {
  if (isService(ctx, ctx.sender)) throw new SenderError('service_cannot_own_profile');
}
