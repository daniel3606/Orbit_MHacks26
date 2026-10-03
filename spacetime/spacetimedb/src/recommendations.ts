import { SenderError, t } from 'spacetimedb/server';
import spacetimedb, { FitComponent } from './schema';
import { requireService, type Ctx } from './auth';
import { JOB_KIND, JOB_STATUS, requireLease } from './jobs';
import { MARKET_SCOPE } from './market';

/** fit-v1.0.0: horizon and style are recorded but not scored. */
export const FIT_ALGORITHM_VERSION = 'fit-v1.0.0';
const COMPONENT_WEIGHTS: Record<string, number> = {
  risk_match: 0.4,
  horizon_match: 0.3,
  style_match: 0.2,
  sector_preference: 0.1,
};
const COMPONENT_ORDER = ['risk_match', 'horizon_match', 'style_match', 'sector_preference'];
const UNSCORED = new Set(['horizon_match', 'style_match']);
const STATUSES = ['ready', 'no_eligible', 'insufficient_market'];
const REQUIRED_LIMITATIONS = ['horizon_not_scored', 'style_not_classified', 'price_volume_only'];
const TREND_BLEND = 0.6;
const FIT_BLEND = 0.4;
const MAX_PUBLISHED = 3;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SOURCE_PATTERN = /^[a-z0-9_]{1,32}$/;
const TICKER_PATTERN = /^[A-Z][A-Z0-9.]{0,9}$/;

const RecommendationInput = t.object('RecommendationInput', {
  ticker: t.string(),
  displayRank: t.u16(),
  trendScore: t.f64(),
  fitScore: t.f64(),
  recommendationRank: t.f64(),
  fitCoverage: t.f64(),
  components: t.array(FitComponent),
  realizedVol: t.option(t.f64()),
  maxDrawdown: t.option(t.f64()),
  volSessions: t.u32(),
  drawdownSessions: t.u32(),
  sector: t.string(),
  benchmark: t.string(),
  sessionDate: t.string(),
  historySource: t.string(),
  matchReason: t.string(),
  marketActivity: t.string(),
  riskObservation: t.string(),
  learningNote: t.string(),
  limitations: t.array(t.string()),
});

type Component = {
  name: string;
  available: boolean;
  value?: number;
  weight: number;
  reason?: string;
};
type Item = {
  ticker: string;
  displayRank: number;
  trendScore: number;
  fitScore: number;
  recommendationRank: number;
  fitCoverage: number;
  components: Component[];
  realizedVol?: number;
  maxDrawdown?: number;
  volSessions: number;
  drawdownSessions: number;
  sector: string;
  benchmark: string;
  sessionDate: string;
  historySource: string;
  matchReason: string;
  marketActivity: string;
  riskObservation: string;
  learningNote: string;
  limitations: string[];
};

function finite(v: number | undefined): boolean {
  return v === undefined || Number.isFinite(v);
}

function near(a: number, b: number, tol = 1e-4): boolean {
  return Math.abs(a - b) <= tol;
}

function requireText(value: string, max: number, code: string) {
  if (value.length === 0 || value.length > max) throw new SenderError(code);
}

/**
 * Publishes one complete recommendation generation and completes the refresh
 * job in the same transaction. A stale profile or market generation is
 * rejected with nothing written, so the previous generation stays visible.
 */
export const publishRecommendations = spacetimedb.reducer(
  {
    jobId: t.u64(),
    attempt: t.u32(),
    generation: t.u64(),
    profileVersion: t.u32(),
    marketGeneration: t.u64(),
    signalAlgorithmVersion: t.string(),
    fitAlgorithmVersion: t.string(),
    signalSessionDate: t.string(),
    status: t.string(),
    consideredCount: t.u16(),
    eligibleCount: t.u16(),
    summary: t.string(),
    limitations: t.array(t.string()),
    items: t.array(RecommendationInput),
  },
  (ctx, args) => {
    requireService(ctx);
    const { row: job, holdsLease } = requireLease(ctx, args.jobId, args.attempt);
    if (job.kind !== JOB_KIND.refreshRecommendations) throw new SenderError('wrong_job_kind');
    if (!holdsLease) throw new SenderError('lease_mismatch');
    const current = ctx.db.recommendationGeneration.owner.find(job.owner);
    if (job.status === JOB_STATUS.succeeded) {
      if (current && current.generation === args.generation && current.jobId === args.jobId) return;
      throw new SenderError('job_not_running');
    }
    if (job.status !== JOB_STATUS.running) throw new SenderError('job_not_running');
    const now = ctx.timestamp.microsSinceUnixEpoch;
    if (job.leaseUntil === undefined || job.leaseUntil.microsSinceUnixEpoch < now) {
      throw new SenderError('lease_expired');
    }

    const profile = ctx.db.investmentProfile.owner.find(job.owner);
    if (!profile) throw new SenderError('profile_not_found');
    if (profile.profileVersion !== args.profileVersion || profile.profileVersion !== job.inputVersion) {
      throw new SenderError('stale_profile_version');
    }
    if (!STATUSES.includes(args.status)) throw new SenderError('invalid_status');
    if (args.fitAlgorithmVersion !== FIT_ALGORITHM_VERSION) throw new SenderError('unknown_fit_algorithm');
    if (args.signalAlgorithmVersion.length > 64) throw new SenderError('invalid_algorithm_version');
    if (args.status !== 'insufficient_market' && args.signalAlgorithmVersion.length === 0) {
      throw new SenderError('invalid_algorithm_version');
    }
    if (!DATE_PATTERN.test(args.signalSessionDate) && args.status !== 'insufficient_market') {
      throw new SenderError('invalid_session_date');
    }
    if (args.status === 'insufficient_market' && args.signalSessionDate !== '' && !DATE_PATTERN.test(args.signalSessionDate)) {
      throw new SenderError('invalid_session_date');
    }
    requireText(args.summary, 400, 'invalid_summary');
    if (args.limitations.length === 0 || args.limitations.length > 8) throw new SenderError('invalid_limitations');
    for (const code of REQUIRED_LIMITATIONS) {
      if (!args.limitations.includes(code)) throw new SenderError('missing_limitation');
    }
    for (const code of args.limitations) {
      if (code.length === 0 || code.length > 80) throw new SenderError('invalid_limitations');
    }
    if (args.consideredCount < args.eligibleCount || args.eligibleCount < args.items.length) {
      throw new SenderError('invalid_counts');
    }
    if (args.status === 'ready') {
      if (args.items.length < 1 || args.items.length > MAX_PUBLISHED) throw new SenderError('invalid_recommendation_count');
    } else if (args.items.length !== 0) {
      throw new SenderError('invalid_recommendation_count');
    }

    const market = ctx.db.marketGeneration.scope.find(MARKET_SCOPE);
    if (args.status === 'insufficient_market') {
      if (market) {
        if (args.marketGeneration !== market.generation) throw new SenderError('stale_market_generation');
      } else if (args.marketGeneration !== 0n) {
        throw new SenderError('stale_market_generation');
      }
    } else {
      if (!market || args.marketGeneration !== market.generation) throw new SenderError('stale_market_generation');
    }
    if (current && args.generation <= current.generation) throw new SenderError('stale_generation');

    const seen = new Set<string>();
    const ranks = new Set<number>();
    for (const item of args.items as Item[]) validateItem(ctx, item, args.signalSessionDate, seen, ranks);
    for (let rank = 1; rank <= args.items.length; rank++) {
      if (!ranks.has(rank)) throw new SenderError('invalid_rank');
    }

    // Writes begin only after every check above has passed.
    for (const item of args.items as Item[]) {
      ctx.db.recommendation.insert({
        id: 0n,
        owner: job.owner,
        generation: args.generation,
        ticker: item.ticker,
        displayRank: item.displayRank,
        trendScore: item.trendScore,
        fitScore: item.fitScore,
        recommendationRank: item.recommendationRank,
        fitCoverage: item.fitCoverage,
        components: item.components.map(component => ({
          name: component.name,
          available: component.available,
          value: component.value,
          weight: component.weight,
          reason: component.reason,
        })),
        realizedVol: item.realizedVol,
        maxDrawdown: item.maxDrawdown,
        volSessions: item.volSessions,
        drawdownSessions: item.drawdownSessions,
        sector: item.sector,
        benchmark: item.benchmark,
        sessionDate: item.sessionDate,
        historySource: item.historySource,
        matchReason: item.matchReason,
        marketActivity: item.marketActivity,
        riskObservation: item.riskObservation,
        learningNote: item.learningNote,
        limitations: item.limitations,
      });
    }
    const pointer = {
      owner: job.owner,
      generation: args.generation,
      jobId: args.jobId,
      status: args.status,
      profileVersion: profile.profileVersion,
      profileSchemaVersion: profile.schemaVersion,
      marketGeneration: args.marketGeneration,
      signalAlgorithmVersion: args.signalAlgorithmVersion,
      fitAlgorithmVersion: args.fitAlgorithmVersion,
      signalSessionDate: args.signalSessionDate,
      consideredCount: args.consideredCount,
      eligibleCount: args.eligibleCount,
      publishedCount: args.items.length,
      summary: args.summary,
      limitations: args.limitations,
      publishedAt: ctx.timestamp,
    };
    if (current) ctx.db.recommendationGeneration.owner.update(pointer);
    else ctx.db.recommendationGeneration.insert(pointer);

    if (current) {
      for (const row of ctx.db.recommendation.owner.filter(job.owner)) {
        if (row.generation !== args.generation) ctx.db.recommendation.id.delete(row.id);
      }
    }

    ctx.db.job.jobId.update({
      ...job,
      status: JOB_STATUS.succeeded,
      resultRef: `generation=${args.generation};status=${args.status};count=${args.items.length}`,
      errorCode: undefined,
      leaseUntil: undefined,
      updatedAt: ctx.timestamp,
    });
  }
);

function validateItem(ctx: Ctx, item: Item, session: string, seen: Set<string>, ranks: Set<number>) {
  const stock = ctx.db.stock.ticker.find(item.ticker);
  if (!stock || !stock.active || stock.kind !== 'equity') throw new SenderError('unknown_ticker');
  if (!TICKER_PATTERN.test(item.ticker)) throw new SenderError('unknown_ticker');
  if (seen.has(item.ticker)) throw new SenderError('duplicate_ticker');
  seen.add(item.ticker);
  if (item.displayRank < 1 || item.displayRank > MAX_PUBLISHED || ranks.has(item.displayRank)) {
    throw new SenderError('invalid_rank');
  }
  ranks.add(item.displayRank);
  if (item.sector !== stock.sector || item.sector.length === 0) throw new SenderError('sector_mismatch');
  if (item.benchmark !== stock.benchmark) throw new SenderError('benchmark_mismatch');
  if (item.sessionDate !== session) throw new SenderError('session_mismatch');
  if (!SOURCE_PATTERN.test(item.historySource)) throw new SenderError('invalid_history_source');
  for (const value of [item.trendScore, item.fitScore, item.recommendationRank, item.realizedVol, item.maxDrawdown]) {
    if (!finite(value)) throw new SenderError('non_finite_value');
  }
  if (!(item.trendScore >= 0 && item.trendScore <= 100)) throw new SenderError('invalid_score');
  if (!(item.fitScore >= 0 && item.fitScore <= 100)) throw new SenderError('invalid_score');
  if (!(item.fitCoverage >= 0 && item.fitCoverage <= 1)) throw new SenderError('invalid_coverage');
  if (item.realizedVol !== undefined && item.realizedVol < 0) throw new SenderError('invalid_risk_metric');
  if (item.maxDrawdown !== undefined && (item.maxDrawdown > 0 || item.maxDrawdown < -1)) {
    throw new SenderError('invalid_risk_metric');
  }

  if (item.components.length !== COMPONENT_ORDER.length) throw new SenderError('invalid_components');
  let coverage = 0;
  let blended = 0;
  for (let i = 0; i < COMPONENT_ORDER.length; i++) {
    const component = item.components[i];
    const name = COMPONENT_ORDER[i];
    if (!component || component.name !== name) throw new SenderError('invalid_components');
    const expected = COMPONENT_WEIGHTS[name];
    if (!near(component.weight, expected, 1e-9) || !Number.isFinite(component.weight)) {
      throw new SenderError('invalid_component_weight');
    }
    if (!finite(component.value)) throw new SenderError('non_finite_value');
    if (UNSCORED.has(name) && component.available) throw new SenderError('unsupported_component');
    if (name === 'sector_preference' && !component.available) throw new SenderError('sector_component_required');
    if (component.available) {
      if (component.value === undefined || component.value < 0 || component.value > 1) {
        throw new SenderError('invalid_component_value');
      }
      coverage += component.weight;
      blended += component.weight * component.value;
    } else if (component.value !== undefined) {
      throw new SenderError('component_value_present');
    }
  }
  if (!near(item.fitCoverage, coverage, 1e-6)) throw new SenderError('coverage_mismatch');
  const expectedFit = coverage > 0 ? (100 * blended) / coverage : 0;
  if (!near(item.fitScore, expectedFit)) throw new SenderError('fit_score_mismatch');
  const expectedRank = TREND_BLEND * item.trendScore + FIT_BLEND * item.fitScore;
  if (!near(item.recommendationRank, expectedRank)) throw new SenderError('rank_mismatch');

  requireText(item.matchReason, 500, 'invalid_explanation');
  requireText(item.marketActivity, 800, 'invalid_explanation');
  requireText(item.riskObservation, 500, 'invalid_explanation');
  requireText(item.learningNote, 500, 'invalid_explanation');
  if (item.limitations.length === 0 || item.limitations.length > 8) throw new SenderError('invalid_limitations');
  for (const line of item.limitations) requireText(line, 240, 'invalid_limitations');
}
