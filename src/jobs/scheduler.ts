import { CronJob } from 'cron';
import { memexCollector } from '../services/memex-collector';
import { scoreCalculator } from '../services/score-calculator';
import { epochSubmitter, type TokenRanking } from '../services/epoch-submitter';
import { graphqlClient } from '../services/graphql-client';
import { db, schema } from '../db/client';
import { and, gte, lte } from 'drizzle-orm';
import type { Address } from 'viem';
import type { AggregatedMetrics } from '../types/memex';

// =============================================================================
// JOB INSTANCES
// =============================================================================

let scoreCollectionJob: CronJob | null = null;
let epochSubmissionJob: CronJob | null = null;
let cacheCleanupJob: CronJob | null = null;
let hourlySnapshotJob: CronJob | null = null;
let dailyAggregationJob: CronJob | null = null;
let metricsRefreshJob: CronJob | null = null;
let tokenImageRefreshJob: CronJob | null = null;

// =============================================================================
// STATE
// =============================================================================

let backfillCompleted = false;
let backfillInProgress = false;

// In-memory token scores
const latestTokenScores = new Map<string, number>();

// Latest metrics for snapshots
let latestAggregatedMetrics: AggregatedMetrics[] = [];

// =============================================================================
// SCORE COLLECTION (Every 10 seconds)
// =============================================================================

async function processScoreCollection(): Promise<void> {
  console.log('[Scheduler] Starting score collection...');

  try {
    const aggregatedMetrics = await memexCollector.collectAndAggregate();

    if (aggregatedMetrics.length === 0) {
      console.log('[Scheduler] No new metrics to process');
      return;
    }

    const scores = scoreCalculator.calculateBatch(aggregatedMetrics);

    for (const [tokenSymbol, score] of scores) {
      latestTokenScores.set(tokenSymbol, score);
      console.log(`[Scheduler] ${tokenSymbol}: score=${score}, tier=${scoreCalculator.getScoreTier(score)}`);
    }

    latestAggregatedMetrics = aggregatedMetrics;
    console.log(`[Scheduler] Score collection complete. ${scores.size} tokens updated`);
  } catch (error) {
    console.error('[Scheduler] Score collection failed:', error);
  }
}

// =============================================================================
// EPOCH SUBMISSION (Every hour)
// =============================================================================

async function processEpochSubmission(): Promise<void> {
  console.log('[Scheduler] Starting epoch submission...');

  try {
    if (!epochSubmitter.isReady()) {
      console.log('[Scheduler] Epoch submitter not configured (missing SIGNER_PRIVATE_KEY)');
      return;
    }

    const { canSubmit, currentEpoch, lastEpoch } = await epochSubmitter.canSubmitNewEpoch();
    if (!canSubmit) {
      console.log(`[Scheduler] Cannot submit new epoch. Current=${currentEpoch}, Last=${lastEpoch}`);
      return;
    }

    if (latestTokenScores.size === 0) {
      console.log('[Scheduler] No token scores available for epoch submission');
      return;
    }

    // Build token rankings from GraphQL TVL data + viral scores
    const rankings = await buildTokenRankings();

    if (rankings.length === 0) {
      console.log('[Scheduler] No token rankings available for submission');
      return;
    }

    console.log(`[Scheduler] Top 3 token rankings:`);
    rankings.slice(0, 3).forEach((r, i) => {
      console.log(`  ${i + 1}. ${r.tokenAddress.slice(0, 10)}... score=${r.score}, binSteps=[${r.binSteps.join(',')}]`);
    });

    // Build viral pairs from top 3 rankings
    const viralPairs = epochSubmitter.buildViralPairs(rankings.slice(0, 3));

    if (viralPairs.length === 0) {
      console.log('[Scheduler] No viral pairs to submit');
      return;
    }

    console.log(`[Scheduler] Submitting ${viralPairs.length} pairs for epoch ${currentEpoch}`);

    const result = await epochSubmitter.submitEpoch(currentEpoch, viralPairs);
    console.log(`[Scheduler] Epoch ${result.epoch} submitted successfully! txHash=${result.txHash}`);
  } catch (error) {
    console.error('[Scheduler] Epoch submission failed:', error);
  }
}

/**
 * Build token rankings from GraphQL TVL data + viral scores
 */
async function buildTokenRankings(): Promise<TokenRanking[]> {
  try {
    const memeTokensWithPools = await graphqlClient.getMemeTokensWithPools();

    if (memeTokensWithPools.length === 0) {
      console.log('[Scheduler] No meme token pools found from GraphQL');
      return [];
    }

    const rankings: TokenRanking[] = [];

    for (const tokenData of memeTokensWithPools) {
      const score = latestTokenScores.get(tokenData.tokenSymbol.toUpperCase()) ?? 0;

      if (score <= 0) {
        continue;
      }

      // binSteps already sorted by TVL (highest first) from GraphQL
      const binSteps = tokenData.pools.map((p) => p.binStep);

      rankings.push({
        tokenAddress: tokenData.tokenAddress,
        quoteTokenAddress: tokenData.quoteTokenAddress,
        score,
        binSteps,
      });

      console.log(
        `[Scheduler] ${tokenData.tokenSymbol}: score=${score}, TVL=$${tokenData.totalTvlUSD.toFixed(2)}, ` +
          `binSteps=[${tokenData.pools.map((p) => `${p.binStep}($${p.tvlUSD.toFixed(2)})`).join(', ')}]`
      );
    }

    // Sort by viral score (highest first)
    rankings.sort((a, b) => b.score - a.score);
    console.log(`[Scheduler] Built ${rankings.length} token rankings`);

    return rankings;
  } catch (error) {
    console.error('[Scheduler] Failed to build token rankings:', error);
    return [];
  }
}

// =============================================================================
// CACHE CLEANUP (Every 5 minutes)
// =============================================================================

async function processCacheCleanup(): Promise<void> {
  try {
    if (latestTokenScores.size > 100) {
      const sorted = Array.from(latestTokenScores.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 100);
      latestTokenScores.clear();
      for (const [symbol, score] of sorted) {
        latestTokenScores.set(symbol, score);
      }
      console.log('[Scheduler] Cache cleanup: trimmed to top 100 tokens');
    }
  } catch (error) {
    console.error('[Scheduler] Cache cleanup failed:', error);
  }
}

// =============================================================================
// METRICS REFRESH (Every 5 minutes)
// =============================================================================

async function processMetricsRefresh(): Promise<void> {
  try {
    const REFRESH_PAGES = parseInt(process.env.METRICS_REFRESH_PAGES || '10');
    const result = await memexCollector.refreshRecentPostsMetrics(REFRESH_PAGES);
    console.log(`[Scheduler] Metrics refresh: ${result.updated} posts updated`);
  } catch (error) {
    console.error('[Scheduler] Metrics refresh failed:', error);
  }
}

// =============================================================================
// TOKEN IMAGE REFRESH (Every 10 minutes)
// =============================================================================

async function processTokenImageRefresh(): Promise<void> {
  try {
    const count = await memexCollector.refreshTokenImageCache();
    console.log(`[Scheduler] Token image refresh: ${count} tokens cached`);
  } catch (error) {
    console.error('[Scheduler] Token image refresh failed:', error);
  }
}

// =============================================================================
// HOURLY SNAPSHOT
// =============================================================================

async function processHourlySnapshot(): Promise<void> {
  try {
    if (latestTokenScores.size === 0) {
      console.log('[Scheduler] No token scores to snapshot');
      return;
    }

    const snapshotHour = new Date();
    snapshotHour.setMinutes(0, 0, 0);

    const metricsMap = new Map<string, AggregatedMetrics>();
    for (const m of latestAggregatedMetrics) {
      metricsMap.set(m.tokenSymbol, m);
    }

    const snapshots = Array.from(latestTokenScores.entries()).map(([tokenSymbol, score]) => {
      const metrics = metricsMap.get(tokenSymbol);
      return {
        tokenSymbol,
        score,
        snapshotHour,
        rawPosts: metrics?.posts ?? 0,
        rawViews: metrics?.views ?? 0,
        rawLikes: metrics?.likes ?? 0,
        rawReposts: metrics?.reposts ?? 0,
        rawReplies: metrics?.replies ?? 0,
        rawUniqueUsers: metrics?.uniqueUserCount ?? 0,
        avgBondingCurve: metrics?.avgBondingCurveProgress ?? 0,
        graduatedRatio: metrics?.graduatedPostRatio ?? 0,
        imageRatio: metrics?.imagePostRatio ?? 0,
      };
    });

    for (const snapshot of snapshots) {
      await db
        .insert(schema.tokenScoreSnapshots)
        .values(snapshot)
        .onConflictDoUpdate({
          target: [schema.tokenScoreSnapshots.tokenSymbol, schema.tokenScoreSnapshots.snapshotHour],
          set: {
            score: snapshot.score,
            rawPosts: snapshot.rawPosts,
            rawViews: snapshot.rawViews,
            rawLikes: snapshot.rawLikes,
            rawReposts: snapshot.rawReposts,
            rawReplies: snapshot.rawReplies,
            rawUniqueUsers: snapshot.rawUniqueUsers,
            avgBondingCurve: snapshot.avgBondingCurve,
            graduatedRatio: snapshot.graduatedRatio,
            imageRatio: snapshot.imageRatio,
          },
        });
    }

    console.log(`[Scheduler] Hourly snapshot: ${snapshots.length} tokens at ${snapshotHour.toISOString()}`);
  } catch (error) {
    console.error('[Scheduler] Hourly snapshot failed:', error);
  }
}

// =============================================================================
// DAILY AGGREGATION
// =============================================================================

async function processDailyAggregation(): Promise<void> {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    const hourlySnapshots = await db.query.tokenScoreSnapshots.findMany({
      where: and(gte(schema.tokenScoreSnapshots.snapshotHour, yesterday), lte(schema.tokenScoreSnapshots.snapshotHour, today)),
    });

    if (hourlySnapshots.length === 0) {
      console.log('[Scheduler] No hourly snapshots to aggregate');
      return;
    }

    const tokenDailyStats = new Map<
      string,
      {
        scores: number[];
        totalPosts: number;
        totalViews: number;
        totalLikes: number;
        totalReposts: number;
      }
    >();

    for (const snapshot of hourlySnapshots) {
      const existing = tokenDailyStats.get(snapshot.tokenSymbol) || {
        scores: [],
        totalPosts: 0,
        totalViews: 0,
        totalLikes: 0,
        totalReposts: 0,
      };

      existing.scores.push(snapshot.score);
      existing.totalPosts = Math.max(existing.totalPosts, snapshot.rawPosts ?? 0);
      existing.totalViews = Math.max(existing.totalViews, snapshot.rawViews ?? 0);
      existing.totalLikes = Math.max(existing.totalLikes, snapshot.rawLikes ?? 0);
      existing.totalReposts = Math.max(existing.totalReposts, snapshot.rawReposts ?? 0);

      tokenDailyStats.set(snapshot.tokenSymbol, existing);
    }

    for (const [tokenSymbol, stats] of tokenDailyStats.entries()) {
      const avgScore = Math.round(stats.scores.reduce((a, b) => a + b, 0) / stats.scores.length);
      const maxScore = Math.max(...stats.scores);
      const minScore = Math.min(...stats.scores);

      await db
        .insert(schema.tokenScoreDaily)
        .values({
          tokenSymbol,
          avgScore,
          maxScore,
          minScore,
          snapshotDate: yesterday,
          totalPosts: stats.totalPosts,
          totalViews: stats.totalViews,
          totalLikes: stats.totalLikes,
          totalReposts: stats.totalReposts,
        })
        .onConflictDoUpdate({
          target: [schema.tokenScoreDaily.tokenSymbol, schema.tokenScoreDaily.snapshotDate],
          set: {
            avgScore,
            maxScore,
            minScore,
            totalPosts: stats.totalPosts,
            totalViews: stats.totalViews,
            totalLikes: stats.totalLikes,
            totalReposts: stats.totalReposts,
          },
        });
    }

    console.log(`[Scheduler] Daily aggregation: ${tokenDailyStats.size} tokens for ${yesterday.toISOString().split('T')[0]}`);
  } catch (error) {
    console.error('[Scheduler] Daily aggregation failed:', error);
  }
}

// =============================================================================
// BACKFILL
// =============================================================================

async function performInitialBackfill(): Promise<void> {
  if (backfillCompleted || backfillInProgress) return;

  backfillInProgress = true;
  console.log('[Scheduler] Performing initial backfill...');

  try {
    const BACKFILL_PAGES = parseInt(process.env.BACKFILL_PAGES || '50');
    const result = await memexCollector.initialBackfill(BACKFILL_PAGES);

    console.log(`[Scheduler] Backfill complete: ${result.totalPosts} posts, ${result.uniqueTokens} tokens`);
    backfillCompleted = true;

    await processScoreCollection();
  } catch (error) {
    console.error('[Scheduler] Backfill failed:', error);
  } finally {
    backfillInProgress = false;
  }
}

// =============================================================================
// SCHEDULER CONTROL
// =============================================================================

export function startScheduler(): void {
  console.log('[Scheduler] Starting jobs...');

  // Score collection - every 10 seconds
  scoreCollectionJob = new CronJob('*/10 * * * * *', processScoreCollection, null, true, 'UTC');

  // Epoch submission - every hour at :00
  epochSubmissionJob = new CronJob('0 * * * *', processEpochSubmission, null, true, 'UTC');

  // Cache cleanup - every 5 minutes
  cacheCleanupJob = new CronJob('*/5 * * * *', processCacheCleanup, null, true, 'UTC');

  // Metrics refresh - every 5 minutes
  metricsRefreshJob = new CronJob('*/5 * * * *', processMetricsRefresh, null, true, 'UTC');

  // Token image refresh - every 10 minutes
  tokenImageRefreshJob = new CronJob('*/10 * * * *', processTokenImageRefresh, null, true, 'UTC');

  // Hourly snapshot - every hour at :05
  hourlySnapshotJob = new CronJob('5 * * * *', processHourlySnapshot, null, true, 'UTC');

  // Daily aggregation - every day at 00:10 UTC
  dailyAggregationJob = new CronJob('10 0 * * *', processDailyAggregation, null, true, 'UTC');

  // Initial token image load
  processTokenImageRefresh().catch(console.error);

  console.log('[Scheduler] Jobs started:');
  console.log('  - Score collection: every 10 seconds');
  console.log('  - Epoch submission: every hour at :00');
  console.log('  - Metrics refresh: every 5 minutes');
  console.log('  - Token image refresh: every 10 minutes');
  console.log('  - Hourly snapshot: every hour at :05');
  console.log('  - Daily aggregation: every day at 00:10 UTC');
}

export function stopScheduler(): void {
  console.log('[Scheduler] Stopping jobs...');
  scoreCollectionJob?.stop();
  epochSubmissionJob?.stop();
  cacheCleanupJob?.stop();
  metricsRefreshJob?.stop();
  tokenImageRefreshJob?.stop();
  hourlySnapshotJob?.stop();
  dailyAggregationJob?.stop();
  console.log('[Scheduler] All jobs stopped');
}

// =============================================================================
// EXPORTS
// =============================================================================

export function triggerBackfill(): { status: string; message: string } {
  if (backfillCompleted) return { status: 'skipped', message: 'Backfill already completed' };
  if (backfillInProgress) return { status: 'skipped', message: 'Backfill already in progress' };

  performInitialBackfill().catch(console.error);
  return { status: 'started', message: 'Backfill started in background' };
}

export function getSchedulerStatus() {
  const imageCacheStatus = memexCollector.getTokenImageCacheStatus();

  return {
    scoreCollection: scoreCollectionJob?.running ?? false,
    epochSubmission: epochSubmissionJob?.running ?? false,
    metricsRefresh: metricsRefreshJob?.running ?? false,
    tokenImageRefresh: tokenImageRefreshJob?.running ?? false,
    cacheCleanup: cacheCleanupJob?.running ?? false,
    hourlySnapshot: hourlySnapshotJob?.running ?? false,
    dailyAggregation: dailyAggregationJob?.running ?? false,
    backfillCompleted,
    backfillInProgress,
    tokenScoresCount: latestTokenScores.size,
    tokenImageCacheCount: imageCacheStatus.count,
    epochSubmitter: {
      ready: epochSubmitter.isReady(),
      signerAddress: epochSubmitter.getSignerAddress(),
    },
  };
}

export function getLatestTokenScores(): Map<string, number> {
  return new Map(latestTokenScores);
}

export async function triggerTokenImageRefresh(): Promise<{ status: string; count: number }> {
  try {
    const count = await memexCollector.refreshTokenImageCache();
    return { status: 'success', count };
  } catch (error) {
    console.error('[Scheduler] Token image refresh failed:', error);
    return { status: 'error', count: 0 };
  }
}

export async function triggerEpochSubmission(): Promise<{
  status: string;
  message: string;
  txHash?: string;
  epoch?: string;
}> {
  try {
    if (!epochSubmitter.isReady()) {
      return { status: 'error', message: 'Epoch submitter not configured (missing SIGNER_PRIVATE_KEY)' };
    }

    const { canSubmit, currentEpoch, lastEpoch } = await epochSubmitter.canSubmitNewEpoch();
    if (!canSubmit) {
      return { status: 'skipped', message: `Cannot submit. Current=${currentEpoch}, Last=${lastEpoch}` };
    }

    await processEpochSubmission();
    return { status: 'success', message: 'Epoch submission triggered' };
  } catch (error) {
    console.error('[Scheduler] Manual epoch submission failed:', error);
    return { status: 'error', message: String(error) };
  }
}

export async function getEpochStatus(): Promise<{
  ready: boolean;
  signerAddress: string | null;
  currentEpoch: string;
  lastEpoch: string;
  canSubmit: boolean;
  activePairs: number;
}> {
  try {
    const ready = epochSubmitter.isReady();
    if (!ready) {
      return { ready: false, signerAddress: null, currentEpoch: '0', lastEpoch: '0', canSubmit: false, activePairs: 0 };
    }

    const { canSubmit, currentEpoch, lastEpoch } = await epochSubmitter.canSubmitNewEpoch();
    const activePairs = await epochSubmitter.getActiveViralPairs();

    return {
      ready,
      signerAddress: epochSubmitter.getSignerAddress(),
      currentEpoch: currentEpoch.toString(),
      lastEpoch: lastEpoch.toString(),
      canSubmit,
      activePairs: activePairs.length,
    };
  } catch (error) {
    console.error('[Scheduler] Failed to get epoch status:', error);
    return { ready: false, signerAddress: null, currentEpoch: '0', lastEpoch: '0', canSubmit: false, activePairs: 0 };
  }
}
