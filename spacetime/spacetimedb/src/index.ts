import { SenderError, t } from 'spacetimedb/server';
import spacetimedb from './schema';
import { requireAdmin } from './auth';

export default spacetimedb;

export { completeOnboarding, updatePreferences } from './profile';
export { requestBackendCheck, claimJob, completeJob, failJob } from './jobs';
export {
  myAccount,
  myProfile,
  myBranding,
  myJobs,
  myServiceGrant,
  workerJobs,
  workerJobProfiles,
} from './views';

/** The publishing identity becomes the first module admin. */
export const init = spacetimedb.init(ctx => {
  ctx.db.moduleAdmin.insert({ identity: ctx.sender, addedAt: ctx.timestamp });
});

/** Records the verified issuer/subject for each connecting identity. */
export const onConnect = spacetimedb.clientConnected(ctx => {
  const claims = ctx.senderAuth.jwt;
  const existing = ctx.db.userAccount.identity.find(ctx.sender);
  if (existing) {
    ctx.db.userAccount.identity.update({ ...existing, lastSeenAt: ctx.timestamp });
    return;
  }
  ctx.db.userAccount.insert({
    identity: ctx.sender,
    issuer: claims?.issuer ?? '',
    subject: claims?.subject ?? '',
    firstSeenAt: ctx.timestamp,
    lastSeenAt: ctx.timestamp,
  });
});

/** Admin-only: add a worker identity to the service allowlist. */
export const grantServiceIdentity = spacetimedb.reducer(
  { identity: t.identity(), label: t.string() },
  (ctx, { identity, label }) => {
    requireAdmin(ctx);
    if (label.length === 0 || label.length > 64) throw new SenderError('invalid_label');
    if (ctx.db.investmentProfile.owner.find(identity)) {
      throw new SenderError('identity_has_consumer_profile');
    }
    const row = { identity, label, addedAt: ctx.timestamp };
    if (ctx.db.serviceIdentity.identity.find(identity)) ctx.db.serviceIdentity.identity.update(row);
    else ctx.db.serviceIdentity.insert(row);
  }
);

export const revokeServiceIdentity = spacetimedb.reducer(
  { identity: t.identity() },
  (ctx, { identity }) => {
    requireAdmin(ctx);
    ctx.db.serviceIdentity.identity.delete(identity);
  }
);
