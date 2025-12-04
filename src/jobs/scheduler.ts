import { CronJob } from 'cron';
import { memexCollector } from '../services/memex-collector';
import { scoreCalculator } from '../services/score-calculator';
import { epochSubmitter, type TokenRanking } from '../services/epoch-submitter';
import { graphqlClient } from '../services/graphql-client';
import { db, schema } from '../db/client';
import { and, gte, lte, eq } from 'drizzle-orm';
import type { Address } from 'viem';
import type { AggregatedMetrics } from '../types/memex';

// =============================================================================
// JOB INSTANCES
// =============================================================================

let scoreCollectionJob: CronJob | null = null;
let epochSubmissionJob: CronJob | null = null;
let epochCheckJob: CronJob | null = null; // Check for missing epochs periodically
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

/**
 * Calculate epoch timestamp from epoch number
 * EPOCH_DURATION = 1 hour (3600 seconds)
 * Contract calculates: epoch = block.timestamp / EPOCH_DURATION
 */
function getEpochStartTimestamp(epoch: bigint): Date {
  const EPOCH_DURATION_SECONDS = 3600; // 1 hour
  const timestamp = Number(epoch) * EPOCH_DURATION_SECONDS;
  return new Date(timestamp * 1000);
}

/**
 * Get token scores for a specific epoch from snapshot
 * Note: Snapshots are saved at :05, but epoch submission happens at :00
 * For current epoch, we use the previous epoch's snapshot (most recent available)
 * For past epochs, we use the epoch's own snapshot
 */
async function getEpochScores(
  epoch: bigint
): Promise<{ scores: Map<string, number>; fromSnapshot: boolean; snapshotHour: Date | null; note: string }> {
  const epochStartTime = getEpochStartTimestamp(epoch);
  const now = new Date();
  const isCurrentEpoch = epochStartTime.getTime() <= now.getTime() && now.getTime() < epochStartTime.getTime() + 3600000;

  // For current epoch, use previous epoch's snapshot (since current snapshot may not exist yet)
  // For past epochs, use the epoch's own snapshot
  let snapshotHour = new Date(epochStartTime);
  snapshotHour.setMinutes(0, 0, 0);

  if (isCurrentEpoch) {
    // Use previous epoch's snapshot (1 hour before)
    snapshotHour = new Date(snapshotHour.getTime() - 3600000);
  }

  try {
    const snapshots = await db.query.tokenScoreSnapshots.findMany({
      where: eq(schema.tokenScoreSnapshots.snapshotHour, snapshotHour),
    });

    if (snapshots.length === 0) {
      const note = isCurrentEpoch
        ? `Current epoch - snapshot not yet available (will be saved at :05), using latest scores`
        : `No snapshot found for epoch ${epoch}`;

      return {
        scores: latestTokenScores,
        fromSnapshot: false,
        snapshotHour: null,
        note,
      };
    }

    const scoreMap = new Map<string, number>();
    for (const snapshot of snapshots) {
      scoreMap.set(snapshot.tokenSymbol.toUpperCase(), snapshot.score);
    }

    const note = isCurrentEpoch
      ? `Using previous epoch's snapshot (epoch ${epoch - 1n}) as current epoch snapshot not yet available`
      : `Using snapshot data from epoch ${epoch}`;

    return {
      scores: scoreMap,
      fromSnapshot: true,
      snapshotHour,
      note,
    };
  } catch (error) {
    console.error(`[Scheduler] Failed to load snapshot for epoch ${epoch}:`, error);
    return {
      scores: latestTokenScores,
      fromSnapshot: false,
      snapshotHour: null,
      note: `Error loading snapshot: ${error}`,
    };
  }
}

/**
 * Validate epoch data before submission
 * Checks if snapshot exists and logs warnings if using current data
 */
async function validateEpochData(epoch: bigint): Promise<{ valid: boolean; warnings: string[]; info: string[] }> {
  const warnings: string[] = [];
  const info: string[] = [];
  const epochStartTime = getEpochStartTimestamp(epoch);
  const now = new Date();
  const isCurrentEpoch = epochStartTime.getTime() <= now.getTime() && now.getTime() < epochStartTime.getTime() + 3600000;

  const { fromSnapshot, snapshotHour, note } = await getEpochScores(epoch);

  if (fromSnapshot && snapshotHour) {
    info.push(`✅ Using snapshot data from ${snapshotHour.toISOString()} for epoch ${epoch}`);
    info.push(`   Note: ${note}`);
  } else {
    warnings.push(`⚠️  ${note}`);
    warnings.push(`   Epoch start time: ${epochStartTime.toISOString()}`);
    warnings.push(`   Using current scores - data may not accurately reflect epoch ${epoch}`);
  }

  return { valid: true, warnings, info };
}

/**
 * Build token rankings from GraphQL TVL data + viral scores
 * @param scoreMap Token scores map to use (from snapshot or current)
 */
/**
 * Match a pool token with viral scores using symbol and name
 * Returns the best matching score or 0 if no match
 */
function findTokenScore(
  tokenData: { tokenSymbol: string; tokenName: string },
  scoreMap: Map<string, number>
): { score: number; matchedBy: string } {
  const symbol = tokenData.tokenSymbol.toUpperCase();
  const name = tokenData.tokenName.toUpperCase();

  // Try symbol match first (exact)
  const symbolScore = scoreMap.get(symbol);
  if (symbolScore && symbolScore > 0) {
    return { score: symbolScore, matchedBy: `symbol:${symbol}` };
  }

  // Try name match (exact)
  const nameScore = scoreMap.get(name);
  if (nameScore && nameScore > 0) {
    return { score: nameScore, matchedBy: `name:${name}` };
  }

  // Try partial name match (e.g., "Memetern" matches "MEMETERN" in scores)
  // Also check if any score key contains the name or vice versa
  for (const [scoreKey, score] of scoreMap.entries()) {
    if (score <= 0) continue;
    const upperKey = scoreKey.toUpperCase();

    // Check if score key matches token name (e.g., MEMETERN matches "Memetern")
    if (upperKey === name || name.includes(upperKey) || upperKey.includes(name)) {
      return { score, matchedBy: `name-partial:${scoreKey}→${name}` };
    }
  }

  return { score: 0, matchedBy: 'none' };
}

async function buildTokenRankings(scoreMap: Map<string, number>): Promise<TokenRanking[]> {
  try {
    const memeTokensWithPools = await graphqlClient.getMemeTokensWithPools();

    if (memeTokensWithPools.length === 0) {
      console.log('[Scheduler] No meme token pools found from GraphQL');
      return [];
    }

    const rankings: TokenRanking[] = [];

    // Create sets for matching check (both symbol and name)
    const poolIdentifiers = new Set<string>();
    for (const t of memeTokensWithPools) {
      poolIdentifiers.add(t.tokenSymbol.toUpperCase());
      poolIdentifiers.add(t.tokenName.toUpperCase());
    }

    // Check for top scored tokens that don't have pools
    const topScoredTokens = Array.from(scoreMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    const tokensWithoutPools: string[] = [];
    for (const [symbol, score] of topScoredTokens) {
      if (!poolIdentifiers.has(symbol.toUpperCase()) && score > 0) {
        tokensWithoutPools.push(`${symbol}(${score})`);
      }
    }

    if (tokensWithoutPools.length > 0) {
      console.warn(`[Scheduler] ⚠️  Top tokens WITHOUT pools: ${tokensWithoutPools.join(', ')}`);
      console.warn(`[Scheduler]    These tokens have high scores but no LBPair with quote token`);
    }

    for (const tokenData of memeTokensWithPools) {
      // Try to match by symbol first, then by name
      const { score, matchedBy } = findTokenScore(tokenData, scoreMap);

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
        `[Scheduler] ${tokenData.tokenSymbol} (${tokenData.tokenName}): score=${score} [${matchedBy}], ` +
          `TVL=$${tokenData.totalTvlUSD.toFixed(2)}, binSteps=[${tokenData.pools
            .map((p) => `${p.binStep}($${p.tvlUSD.toFixed(2)})`)
            .join(', ')}]`
      );
    }

    // Sort by viral score (highest first)
    rankings.sort((a, b) => b.score - a.score);
    console.log(`[Scheduler] Built ${rankings.length} token rankings from ${memeTokensWithPools.length} pools`);

    // Show which tokens will be submitted
    if (rankings.length > 0) {
      console.log(`[Scheduler] Top 3 tokens for epoch submission:`);
      rankings.slice(0, 3).forEach((r, i) => {
        const tokenData = memeTokensWithPools.find((t) => t.tokenAddress.toLowerCase() === r.tokenAddress.toLowerCase());
        console.log(
          `  ${i + 1}. ${tokenData?.tokenSymbol || 'Unknown'} (${tokenData?.tokenName || '?'}): score=${
            r.score
          }, binSteps=[${r.binSteps.join(',')}]`
        );
      });
    }

    return rankings;
  } catch (error) {
    console.error('[Scheduler] Failed to build token rankings:', error);
    return [];
  }
}

async function processEpochSubmission(): Promise<void> {
  console.log('[Scheduler] ========================================');
  console.log('[Scheduler] Starting epoch submission...');
  console.log('[Scheduler] ========================================');

  try {
    console.log(`[Scheduler] Step 1: Checking epoch submitter readiness...`);
    if (!epochSubmitter.isReady()) {
      console.error('[Scheduler] ❌ Epoch submitter not configured (missing SIGNER_PRIVATE_KEY)');
      console.error('[Scheduler] Please set SIGNER_PRIVATE_KEY environment variable');
      return;
    }
    console.log(`[Scheduler] ✅ Epoch submitter ready. Signer: ${epochSubmitter.getSignerAddress()}`);

    console.log(`[Scheduler] Step 2: Checking if epoch can be submitted...`);
    const { canSubmit, currentEpoch, lastEpoch } = await epochSubmitter.canSubmitNewEpoch();
    console.log(`[Scheduler] Current epoch: ${currentEpoch}, Last epoch: ${lastEpoch}, Can submit: ${canSubmit}`);

    if (!canSubmit) {
      console.warn(`[Scheduler] ⚠️  Cannot submit new epoch. Current=${currentEpoch}, Last=${lastEpoch}`);
      console.warn(`[Scheduler] This means currentEpoch <= lastEpoch (epoch already submitted or invalid)`);
      return;
    }
    console.log(`[Scheduler] ✅ Can submit epoch ${currentEpoch}`);

    console.log(`[Scheduler] Step 3: Validating epoch data...`);
    const validation = await validateEpochData(currentEpoch);

    console.log(`[Scheduler] ===== Epoch ${currentEpoch} Data Validation =====`);
    for (const info of validation.info) {
      console.log(`[Scheduler] ${info}`);
    }
    for (const warning of validation.warnings) {
      console.warn(`[Scheduler] ${warning}`);
    }
    console.log(`[Scheduler] ===============================================`);

    console.log(`[Scheduler] Step 4: Getting token scores for epoch...`);
    const { scores: epochScores, fromSnapshot, snapshotHour, note } = await getEpochScores(currentEpoch);

    if (epochScores.size === 0) {
      console.error('[Scheduler] ❌ No token scores available for epoch submission');
      console.error(`[Scheduler] Latest token scores count: ${latestTokenScores.size}`);
      return;
    }
    console.log(`[Scheduler] ✅ Found ${epochScores.size} token scores`);
    console.log(`[Scheduler] Data source: ${fromSnapshot ? `Snapshot (${snapshotHour?.toISOString()})` : 'Current scores'}`);
    console.log(`[Scheduler] Note: ${note}`);

    console.log(`[Scheduler] Step 5: Building token rankings from GraphQL TVL data...`);
    const rankings = await buildTokenRankings(epochScores);

    if (rankings.length === 0) {
      console.error('[Scheduler] ❌ No token rankings available for submission');
      console.error(`[Scheduler] This could mean:`);
      console.error(`[Scheduler]   - No meme tokens found in GraphQL`);
      console.error(`[Scheduler]   - No tokens with positive scores`);
      console.error(`[Scheduler]   - GraphQL query failed`);
      return;
    }
    console.log(`[Scheduler] ✅ Built ${rankings.length} token rankings`);

    console.log(`[Scheduler] Step 6: Top 3 token rankings:`);
    rankings.slice(0, 3).forEach((r, i) => {
      console.log(`  ${i + 1}. ${r.tokenAddress.slice(0, 10)}... score=${r.score}, binSteps=[${r.binSteps.join(',')}]`);
    });

    console.log(`[Scheduler] Step 7: Building viral pairs from top 3 rankings...`);
    const viralPairs = epochSubmitter.buildViralPairs(rankings.slice(0, 3));

    if (viralPairs.length === 0) {
      console.error('[Scheduler] ❌ No viral pairs to submit');
      console.error(`[Scheduler] This should not happen if we have rankings. Check buildViralPairs logic.`);
      return;
    }
    console.log(`[Scheduler] ✅ Built ${viralPairs.length} viral pairs`);

    console.log(`[Scheduler] Step 8: Submitting epoch to contract...`);
    console.log(`[Scheduler] Submitting ${viralPairs.length} pairs for epoch ${currentEpoch}`);
    console.log(
      `[Scheduler] Pairs:`,
      viralPairs.map((p) => ({
        tokenX: p.tokenX.slice(0, 10) + '...',
        tokenY: p.tokenY.slice(0, 10) + '...',
        binStep: p.binStep,
        rank: p.rank,
      }))
    );

    const result = await epochSubmitter.submitEpoch(currentEpoch, viralPairs);
    console.log(`[Scheduler] ========================================`);
    console.log(`[Scheduler] ✅ Epoch ${result.epoch} submitted successfully!`);
    console.log(`[Scheduler] Transaction hash: ${result.txHash}`);
    console.log(`[Scheduler] Pairs count: ${result.pairsCount}`);
    console.log(`[Scheduler] ========================================`);
  } catch (error) {
    console.error('[Scheduler] ========================================');
    console.error('[Scheduler] ❌ Epoch submission failed:', error);
    console.error('[Scheduler] Error details:', error instanceof Error ? error.stack : String(error));
    console.error('[Scheduler] ========================================');
  }
}

// =============================================================================
// EPOCH CHECK (Every 5 minutes - check for missing epochs and validate data)
// =============================================================================

async function processEpochCheck(): Promise<void> {
  try {
    console.log('[Scheduler] === Epoch Check Debug ===');
    console.log(`[Scheduler] Epoch submitter ready: ${epochSubmitter.isReady()}`);
    console.log(`[Scheduler] Signer address: ${epochSubmitter.getSignerAddress() || 'NOT SET'}`);

    if (!epochSubmitter.isReady()) {
      console.warn('[Scheduler] ⚠️  Epoch submitter not ready - SIGNER_PRIVATE_KEY may be missing');
      return; // Skip if not configured
    }

    const { canSubmit, currentEpoch, lastEpoch } = await epochSubmitter.canSubmitNewEpoch();
    console.log(`[Scheduler] Current epoch: ${currentEpoch}, Last epoch: ${lastEpoch}, Can submit: ${canSubmit}`);

    if (canSubmit) {
      const missingEpochs = Number(currentEpoch) - Number(lastEpoch);
      if (missingEpochs > 0) {
        console.log(`[Scheduler] ⚠️  Found ${missingEpochs} missing epoch(s). Current=${currentEpoch}, Last=${lastEpoch}`);

        // Check why submission might be failing
        console.log(`[Scheduler] Checking submission prerequisites...`);
        console.log(`[Scheduler] - Token scores count: ${latestTokenScores.size}`);

        if (latestTokenScores.size === 0) {
          console.warn(`[Scheduler] ⚠️  No token scores available - epoch submission will fail`);
        } else {
          console.log(`[Scheduler] ✅ Token scores available: ${latestTokenScores.size} tokens`);
          // Show top 3 scores
          const topScores = Array.from(latestTokenScores.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3);
          topScores.forEach(([symbol, score], i) => {
            console.log(`[Scheduler]   ${i + 1}. ${symbol}: ${score}`);
          });
        }

        // Validate data availability for the current epoch
        const validation = await validateEpochData(currentEpoch);
        console.log(`[Scheduler] === Epoch Data Validation ===`);
        for (const info of validation.info) {
          console.log(`[Scheduler] ${info}`);
        }
        for (const warning of validation.warnings) {
          console.warn(`[Scheduler] ${warning}`);
        }
        console.log(`[Scheduler] ============================`);

        // If we have token scores and can submit, try to submit the current epoch
        // This helps catch up if the scheduled submission missed
        if (latestTokenScores.size > 0 && missingEpochs === 1) {
          console.log(`[Scheduler] Attempting to submit current epoch ${currentEpoch}...`);
          try {
            await processEpochSubmission();
          } catch (error) {
            console.error(`[Scheduler] Failed to submit epoch during check:`, error);
          }
        } else if (missingEpochs > 1) {
          console.warn(
            `[Scheduler] ⚠️  Multiple epochs missing (${missingEpochs}). Manual submission recommended via POST /api/score/epoch/submit`
          );
        }
      } else {
        console.log(`[Scheduler] ✅ All epochs up to date`);
      }
    } else {
      console.log(`[Scheduler] Cannot submit: Current=${currentEpoch}, Last=${lastEpoch} (currentEpoch <= lastEpoch)`);
    }
    console.log('[Scheduler] === End Epoch Check ===');
  } catch (error) {
    console.error('[Scheduler] Epoch check failed:', error);
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

  // Epoch check - every 5 minutes (check for missing epochs and auto-submit)
  epochCheckJob = new CronJob('*/5 * * * *', processEpochCheck, null, true, 'UTC');

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
  console.log('  - Epoch check: every 5 minutes (validate data availability)');
  console.log('  - Metrics refresh: every 5 minutes');
  console.log('  - Token image refresh: every 10 minutes');
  console.log('  - Hourly snapshot: every hour at :05');
  console.log('  - Daily aggregation: every day at 00:10 UTC');

  // Check for missing epochs on startup
  setTimeout(async () => {
    console.log('[Scheduler] Checking epoch status on startup...');
    await processEpochCheck();
  }, 10000); // Wait 10 seconds for services to initialize
}

export function stopScheduler(): void {
  console.log('[Scheduler] Stopping jobs...');
  scoreCollectionJob?.stop();
  epochSubmissionJob?.stop();
  epochCheckJob?.stop();
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
    epochCheck: epochCheckJob?.running ?? false,
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
  warnings?: string[];
}> {
  try {
    if (!epochSubmitter.isReady()) {
      return { status: 'error', message: 'Epoch submitter not configured (missing SIGNER_PRIVATE_KEY)' };
    }

    const { canSubmit, currentEpoch, lastEpoch } = await epochSubmitter.canSubmitNewEpoch();
    if (!canSubmit) {
      return { status: 'skipped', message: `Cannot submit. Current=${currentEpoch}, Last=${lastEpoch}` };
    }

    // Validate epoch data
    const validation = await validateEpochData(currentEpoch);

    await processEpochSubmission();

    return {
      status: 'success',
      message: 'Epoch submission triggered',
      warnings: validation.warnings.length > 0 ? validation.warnings : undefined,
    };
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
