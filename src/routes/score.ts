import { Hono } from 'hono';
import { scoreCalculator } from '../services/score-calculator';
import { memexCollector } from '../services/memex-collector';
import { getLatestTokenScores, triggerBackfill, getSchedulerStatus, triggerTokenImageRefresh, triggerEpochSubmission, getEpochStatus } from '../jobs/scheduler';
import { isBlacklisted } from '../constants/token-blacklist';

export const scoreRoutes = new Hono();

// =============================================================================
// TOKEN SCORE ENDPOINTS
// =============================================================================

/**
 * GET /api/score/tokens
 * Get all current token scores (in-memory, excluding blacklisted)
 */
scoreRoutes.get('/tokens', async (c) => {
  try {
    const tokenScores = getLatestTokenScores();
    const tokens = Array.from(tokenScores.entries())
      .filter(([symbol]) => !isBlacklisted(symbol))
      .map(([symbol, score]) => ({
        tokenSymbol: symbol,
        score,
        tier: scoreCalculator.getScoreTier(score),
      }))
      .sort((a, b) => b.score - a.score);

    return c.json({
      count: tokens.length,
      tokens,
    });
  } catch (error) {
    console.error('[ScoreRoute] Error fetching tokens:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * GET /api/score/tokens/leaderboard
 * Get top scoring tokens with detailed stats
 */
scoreRoutes.get('/tokens/leaderboard', async (c) => {
  const limit = parseInt(c.req.query('limit') || '20');

  try {
    const tokenScores = getLatestTokenScores();
    const allStats = await memexCollector.getAllTokenStats();
    const imageCacheStatus = memexCollector.getTokenImageCacheStatus();

    const leaderboard = Array.from(tokenScores.entries())
      .filter(([symbol]) => !isBlacklisted(symbol))
      .map(([symbol, score]) => {
        const stats = allStats.get(symbol) || {
          posts: { '1h': 0, '1d': 0, '7d': 0 },
          views: { '1h': 0, '1d': 0, '7d': 0 },
          likes: { '1h': 0, '1d': 0, '7d': 0 },
        };

        const imageInfo = memexCollector.getTokenImageInfo(symbol);
        const pulseScore = Math.round(score / 100);

        return {
          tokenSymbol: symbol,
          imageSrc: imageInfo?.imageSrc ?? null,
          tokenName: imageInfo?.tokenName ?? null,
          posts: stats.posts,
          views: stats.views,
          likes: stats.likes,
          pulseScore,
        };
      })
      .sort((a, b) => b.pulseScore - a.pulseScore)
      .slice(0, Math.min(limit, 100))
      .map((item, index) => ({ rank: index + 1, ...item }));

    return c.json({
      count: leaderboard.length,
      updatedAt: new Date().toISOString(),
      imageCacheUpdatedAt: imageCacheStatus.updatedAt?.toISOString() ?? null,
      leaderboard,
    });
  } catch (error) {
    console.error('[ScoreRoute] Error fetching leaderboard:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// =============================================================================
// EPOCH SUBMISSION ENDPOINTS (On-chain ViralScoreReporter)
// =============================================================================

/**
 * GET /api/score/epoch/status
 * Get current epoch status from ViralScoreReporter contract
 */
scoreRoutes.get('/epoch/status', async (c) => {
  try {
    const status = await getEpochStatus();
    return c.json(status);
  } catch (error) {
    console.error('[ScoreRoute] Error getting epoch status:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * POST /api/score/epoch/submit
 * Manually trigger epoch submission to ViralScoreReporter contract
 */
scoreRoutes.post('/epoch/submit', async (c) => {
  try {
    const result = await triggerEpochSubmission();
    return c.json(result);
  } catch (error) {
    console.error('[ScoreRoute] Error submitting epoch:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// =============================================================================
// TOKEN IMAGE ENDPOINTS
// =============================================================================

/**
 * GET /api/score/images/status
 * Get token image cache status
 */
scoreRoutes.get('/images/status', async (c) => {
  try {
    const cacheStatus = memexCollector.getTokenImageCacheStatus();
    
    return c.json({
      cacheCount: cacheStatus.count,
      cacheUpdatedAt: cacheStatus.updatedAt?.toISOString() ?? null,
    });
  } catch (error) {
    console.error('[ScoreRoute] Error getting image cache status:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * POST /api/score/images/refresh
 * Manually refresh token image cache
 */
scoreRoutes.post('/images/refresh', async (c) => {
  try {
    const result = await triggerTokenImageRefresh();
    const cacheStatus = memexCollector.getTokenImageCacheStatus();
    
    return c.json({
      ...result,
      cacheCount: cacheStatus.count,
      cacheUpdatedAt: cacheStatus.updatedAt?.toISOString() ?? null,
    });
  } catch (error) {
    console.error('[ScoreRoute] Error refreshing token images:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * GET /api/score/images/:tokenSymbol
 * Get token image info for a specific token
 */
scoreRoutes.get('/images/:tokenSymbol', async (c) => {
  const tokenSymbol = c.req.param('tokenSymbol').toUpperCase();
  
  try {
    const imageInfo = memexCollector.getTokenImageInfo(tokenSymbol);
    
    if (!imageInfo) {
      return c.json({ error: 'Token image not found', tokenSymbol }, 404);
    }
    
    return c.json({
      tokenSymbol: imageInfo.tokenSymbol,
      tokenName: imageInfo.tokenName,
      tokenAddress: imageInfo.tokenAddress,
      imageSrc: imageInfo.imageSrc,
      bondingCurveProgress: imageInfo.bondingCurveProgress,
      tokenPriceUsd: imageInfo.tokenPriceUsd,
      updatedAt: imageInfo.updatedAt.toISOString(),
    });
  } catch (error) {
    console.error('[ScoreRoute] Error getting token image:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// =============================================================================
// BACKFILL ENDPOINT
// =============================================================================

/**
 * POST /api/score/backfill
 * Trigger historical data backfill (runs in background)
 */
scoreRoutes.post('/backfill', async (c) => {
  try {
    const result = triggerBackfill();
    const status = getSchedulerStatus();

    return c.json({
      ...result,
      backfillCompleted: status.backfillCompleted,
      backfillInProgress: status.backfillInProgress,
    });
  } catch (error) {
    console.error('[ScoreRoute] Error triggering backfill:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * GET /api/score/backfill/status
 * Get backfill status
 */
scoreRoutes.get('/backfill/status', async (c) => {
  try {
    const status = getSchedulerStatus();
    return c.json({
      backfillCompleted: status.backfillCompleted,
      backfillInProgress: status.backfillInProgress,
      tokenScoresCount: status.tokenScoresCount,
    });
  } catch (error) {
    console.error('[ScoreRoute] Error getting backfill status:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});
