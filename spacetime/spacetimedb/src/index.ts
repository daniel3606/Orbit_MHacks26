import { SenderError, t } from 'spacetimedb/server';
import spacetimedb from './schema';
import { requireAdmin } from './auth';
import { scheduleMarketIngest } from './market';

export default spacetimedb;

export { completeOnboarding, updatePreferences } from './profile';
export {
  requestBackendCheck,
  requestRecommendations,
  claimJob,
  completeJob,
  failJob,
  registerWorker,
  requestMarketIngest,
} from './jobs';
export { publishRecommendations } from './recommendations';
export { requestDailyDiscovery, publishDailyDiscovery } from './discovery';
export { enqueueAssistantMessage, requestHomeBrief, clearAssistantChat, publishAssistantReply } from './assistant';
export { bindPaperDemo, rebindPaperDemo, createPaperOrderIntent, requestPaperSync, requestPaperReconcile, applyPaperSnapshot } from './paper';
export { markNotificationRead, markAllNotificationsRead } from './notifications';
export { recordNewsClassifications } from './news';
export {
  marketTick,
  configureMarketSchedule,
  setServiceFlag,
  upsertStocks,
  publishProviderCapabilities,
  publishMarketSnapshot,
} from './market';
export {
  myAccount,
  myProfile,
  myBranding,
  myJobs,
  myRecommendationGeneration,
  myRecommendations,
  myPaperAccess,
  myPaperAccount,
  myPaperPositions,
  myPaperOrders,
  myNotifications,
  myServiceGrant,
  workerJobs,
  marketCloses,
  workerDailyBars,
  workerJobProfiles,
  workerPaperOrders,
  workerPaperAccount,
  myAssistantMessages,
  workerAssistantPositions,
  workerAssistantMessages,
  workerAssistantRecommendations,
  myDailyDiscovery,
  myDiscoveryItems,
  workerDiscoveryHistory,
  workerDiscoveryItems,
  workerNewsClassifications,
} from './views';

const DEFAULT_MARKET_INTERVAL_SECONDS = 300;

/** The publishing identity becomes the first module admin; market ingestion is scheduled. */
export const init = spacetimedb.init(ctx => {
  ctx.db.moduleAdmin.insert({ identity: ctx.sender, addedAt: ctx.timestamp });
  scheduleMarketIngest(ctx, DEFAULT_MARKET_INTERVAL_SECONDS);
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
