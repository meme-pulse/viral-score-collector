import { CronJob } from 'cron';
import { memexCollector } from '../services/memex-collector';
import { scoreCalculator } from '../services/score-calculator';
import { scoreSigner, ScoreSigner } from '../services/signer';
import { merkleBuilder } from '../services/merkle-builder';
import { broadcastMerkleUpdate } from '../ws/stream';
import type { Hex } from 'viem';

/**
 * Score collection job - Runs every 10 seconds
 */
let scoreCollectionJob: CronJob | null = null;

/**
 * Merkle checkpoint job - Runs every hour
 */
let merkleCheckpointJob: CronJob | null = null;

/**
 * Cache cleanup job - Runs every 5 minutes
 */
let cacheCleanupJob: CronJob | null = null;

// Track if initial backfill has been done
let backfillCompleted = false;

// Store latest token scores (individual, in-memory only)
const latestTokenScores = new Map<string, number>();

/**
 * Process score collection - calculates individual token scores
 */
async function processScoreCollection(): Promise<void> {
  console.log('[Scheduler] Starting score collection...');

  try {
    // 1. Collect data from Memex
    const aggregatedMetrics = await memexCollector.collectAndAggregate();

    if (aggregatedMetrics.length === 0) {
      console.log('[Scheduler] No new metrics to process');
      return;
    }

    // 2. Calculate individual token scores
    const scores = scoreCalculator.calculateBatch(aggregatedMetrics);

    // 3. Update latest token scores map (in-memory, no signing for individual tokens)
    for (const [tokenSymbol, score] of scores) {
      latestTokenScores.set(tokenSymbol, score);
      console.log(`[Scheduler] ${tokenSymbol}: score=${score}, tier=${scoreCalculator.getScoreTier(score)}`);
    }

    console.log(`[Scheduler] Score collection complete. ${scores.size} tokens updated`);
  } catch (error) {
    console.error('[Scheduler] Score collection failed:', error);
  }
}

/**
 * Process merkle checkpoint - builds merkle tree from pair scores
 */
async function processMerkleCheckpoint(): Promise<void> {
  console.log('[Scheduler] Starting merkle checkpoint...');

  try {
    if (latestTokenScores.size === 0) {
      console.log('[Scheduler] No token scores available for merkle tree');
      return;
    }

    // Build merkle tree from token scores (for pair calculations)
    const pairScoresMap = new Map<string, { poolId: Hex; score: number }>();

    // Generate pair pool IDs for merkle tree
    const tokens = Array.from(latestTokenScores.keys());
    for (let i = 0; i < tokens.length; i++) {
      for (let j = i + 1; j < tokens.length; j++) {
        const tokenX = tokens[i];
        const tokenY = tokens[j];
        const pairResult = scoreCalculator.getPairScore(latestTokenScores, tokenX, tokenY);
        if (pairResult) {
          const poolId = ScoreSigner.generatePairPoolId(tokenX, tokenY);
          const [sortedX, sortedY] = [tokenX, tokenY].sort();
          pairScoresMap.set(`${sortedX}/${sortedY}`, { poolId, score: pairResult.pairScore });
        }
      }
    }

    if (pairScoresMap.size === 0) {
      console.log('[Scheduler] No pairs available for merkle tree');
      return;
    }

    const { root, epoch, poolCount } = await merkleBuilder.buildTree(pairScoresMap);
    broadcastMerkleUpdate(root, epoch, poolCount);

    console.log(`[Scheduler] Merkle checkpoint complete. Epoch=${epoch}, pairs=${poolCount}`);
  } catch (error) {
    console.error('[Scheduler] Merkle checkpoint failed:', error);
  }
}

/**
 * Process cache cleanup
 */
function processCacheCleanup(): void {
  console.log('[Scheduler] Cleaning up caches...');

  try {
    memexCollector.clearProcessedCache();

    // Keep only top 100 token scores in memory
    if (latestTokenScores.size > 100) {
      const sorted = Array.from(latestTokenScores.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 100);
      latestTokenScores.clear();
      for (const [symbol, score] of sorted) {
        latestTokenScores.set(symbol, score);
      }
    }

    console.log('[Scheduler] Cache cleanup complete');
  } catch (error) {
    console.error('[Scheduler] Cache cleanup failed:', error);
  }
}

/**
 * Perform initial backfill of historical data
 */
async function performInitialBackfill(): Promise<void> {
  if (backfillCompleted) {
    console.log('[Scheduler] Backfill already completed, skipping...');
    return;
  }

  console.log('[Scheduler] Performing initial backfill...');

  try {
    const BACKFILL_PAGES = parseInt(process.env.BACKFILL_PAGES || '50');
    const result = await memexCollector.initialBackfill(BACKFILL_PAGES);

    console.log(`[Scheduler] Initial backfill complete:`);
    console.log(`  - Total posts: ${result.totalPosts}`);
    console.log(`  - Unique tokens: ${result.uniqueTokens}`);

    backfillCompleted = true;

    // Immediately process scores after backfill
    await processScoreCollection();
  } catch (error) {
    console.error('[Scheduler] Initial backfill failed:', error);
  }
}

/**
 * Start all scheduler jobs
 */
export async function startScheduler(): Promise<void> {
  console.log('[Scheduler] Starting scheduler jobs...');

  // Perform initial backfill before starting regular jobs
  await performInitialBackfill();

  // Score collection - every 10 seconds
  scoreCollectionJob = new CronJob('*/10 * * * * *', processScoreCollection, null, true, 'UTC');

  // Merkle checkpoint - every hour at minute 0
  merkleCheckpointJob = new CronJob('0 * * * *', processMerkleCheckpoint, null, true, 'UTC');

  // Cache cleanup - every 5 minutes
  cacheCleanupJob = new CronJob('*/5 * * * *', processCacheCleanup, null, true, 'UTC');

  console.log('[Scheduler] All jobs started:');
  console.log('  - Score collection: every 10 seconds');
  console.log('  - Merkle checkpoint: every hour');
  console.log('  - Cache cleanup: every 5 minutes');
}

/**
 * Stop all scheduler jobs
 */
export function stopScheduler(): void {
  console.log('[Scheduler] Stopping scheduler jobs...');

  scoreCollectionJob?.stop();
  scoreCollectionJob = null;

  merkleCheckpointJob?.stop();
  merkleCheckpointJob = null;

  cacheCleanupJob?.stop();
  cacheCleanupJob = null;

  console.log('[Scheduler] All jobs stopped');
}

/**
 * Manually trigger score collection (for testing)
 */
export async function triggerScoreCollection(): Promise<void> {
  await processScoreCollection();
}

/**
 * Manually trigger merkle checkpoint (for testing)
 */
export async function triggerMerkleCheckpoint(): Promise<void> {
  await processMerkleCheckpoint();
}

/**
 * Get scheduler status
 */
export function getSchedulerStatus(): {
  scoreCollection: boolean;
  merkleCheckpoint: boolean;
  cacheCleanup: boolean;
  backfillCompleted: boolean;
  tokenScoresCount: number;
} {
  return {
    scoreCollection: scoreCollectionJob?.running ?? false,
    merkleCheckpoint: merkleCheckpointJob?.running ?? false,
    cacheCleanup: cacheCleanupJob?.running ?? false,
    backfillCompleted,
    tokenScoresCount: latestTokenScores.size,
  };
}

/**
 * Get current token scores map
 */
export function getLatestTokenScores(): Map<string, number> {
  return new Map(latestTokenScores);
}

/**
 * Get pair score for a specific token pair
 */
export function getPairScore(tokenX: string, tokenY: string): { pairScore: number; tokenXScore: number; tokenYScore: number } | null {
  return scoreCalculator.getPairScore(latestTokenScores, tokenX, tokenY);
}

/**
 * Sign and store a pair score
 */
export async function signPairScore(
  tokenX: string,
  tokenY: string
): Promise<{
  poolId: Hex;
  pairScore: number;
  tokenXScore: number;
  tokenYScore: number;
  signature: string;
} | null> {
  const pairResult = getPairScore(tokenX, tokenY);
  if (!pairResult) {
    return null;
  }

  const poolId = ScoreSigner.generatePairPoolId(tokenX, tokenY);

  const signedScore = await scoreSigner.signPairScore(
    poolId,
    pairResult.pairScore,
    tokenX.toUpperCase(),
    tokenY.toUpperCase(),
    pairResult.tokenXScore,
    pairResult.tokenYScore
  );

  return {
    poolId,
    pairScore: pairResult.pairScore,
    tokenXScore: pairResult.tokenXScore,
    tokenYScore: pairResult.tokenYScore,
    signature: signedScore.signature,
  };
}
