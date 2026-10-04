import { SenderError, t } from 'spacetimedb/server';
import spacetimedb from './schema';
import { requireConsumer, type Ctx } from './auth';
import { enqueueRecommendationRefresh } from './jobs';
import { repointQueuedDiscovery } from './discovery';
import { PROFILE_SCHEMA_VERSION } from './preferences';
import { validatePreferences, validateZodiac, type PreferenceInput } from './validation';

const preferenceArgs = {
  riskTolerance: t.string(),
  investmentHorizon: t.string(),
  investmentStyle: t.string(),
  sectorInterests: t.array(t.string()),
  experienceLevel: t.string(),
  primaryGoal: t.string(),
  zodiacSign: t.option(t.string()),
};

type PreferenceArgs = PreferenceInput & { zodiacSign?: string };

function saveBranding(ctx: Ctx, zodiacSign: string | undefined) {
  const sign = validateZodiac(zodiacSign);
  const existing = ctx.db.profileBranding.owner.find(ctx.sender);
  const row = { owner: ctx.sender, zodiacSign: sign, updatedAt: ctx.timestamp };
  if (existing) ctx.db.profileBranding.owner.update(row);
  else ctx.db.profileBranding.insert(row);
  repointQueuedDiscovery(ctx, ctx.sender, sign);
}

function split(args: PreferenceArgs): [PreferenceInput, string | undefined] {
  const { zodiacSign, ...prefs } = args;
  return [validatePreferences(prefs), zodiacSign];
}

/** Creates the caller's profile. Ownership is `ctx.sender`; no user id is accepted. */
export const completeOnboarding = spacetimedb.reducer(preferenceArgs, (ctx, args) => {
  requireConsumer(ctx);
  const [prefs, zodiacSign] = split(args);
  if (ctx.db.investmentProfile.owner.find(ctx.sender)) {
    throw new SenderError('profile_already_exists');
  }
  ctx.db.investmentProfile.insert({
    owner: ctx.sender,
    schemaVersion: PROFILE_SCHEMA_VERSION,
    profileVersion: 1,
    ...prefs,
    createdAt: ctx.timestamp,
    updatedAt: ctx.timestamp,
  });
  saveBranding(ctx, zodiacSign);
  enqueueRecommendationRefresh(ctx, ctx.sender, 1);
});

/**
 * Updates the caller's profile with optimistic concurrency: `expectedVersion`
 * must match the stored version, so edits made from a stale screen are rejected.
 */
export const updatePreferences = spacetimedb.reducer(
  { expectedVersion: t.u32(), ...preferenceArgs },
  (ctx, { expectedVersion, ...args }) => {
    requireConsumer(ctx);
    const [prefs, zodiacSign] = split(args);
    const existing = ctx.db.investmentProfile.owner.find(ctx.sender);
    if (!existing) throw new SenderError('profile_not_found');
    if (existing.profileVersion !== expectedVersion) throw new SenderError('profile_version_conflict');

    // Branding-only edits must not invalidate rankings or enqueue work.
    const prefsChanged =
      existing.riskTolerance !== prefs.riskTolerance ||
      existing.investmentHorizon !== prefs.investmentHorizon ||
      existing.investmentStyle !== prefs.investmentStyle ||
      existing.experienceLevel !== prefs.experienceLevel ||
      existing.primaryGoal !== prefs.primaryGoal ||
      existing.sectorInterests.join(',') !== prefs.sectorInterests.join(',');

    if (prefsChanged) {
      const profileVersion = existing.profileVersion + 1;
      ctx.db.investmentProfile.owner.update({
        ...existing,
        ...prefs,
        schemaVersion: PROFILE_SCHEMA_VERSION,
        profileVersion,
        updatedAt: ctx.timestamp,
      });
      enqueueRecommendationRefresh(ctx, ctx.sender, profileVersion);
    }
    saveBranding(ctx, zodiacSign);
  }
);
