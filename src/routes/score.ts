import { Hono } from 'hono';
import { db, schema } from '../db/client';
import { eq, desc } from 'drizzle-orm';
import { ScoreSigner } from '../services/signer';
import { scoreCalculator } from '../services/score-calculator';
import { getLatestTokenScores, getPairScore, signPairScore } from '../jobs/scheduler';

export const scoreRoutes = new Hono();

/**
 * GET /api/score/signer
 * Get the signer address for verification
 */
scoreRoutes.get('/signer', async (c) => {
  try {
    const { scoreSigner } = await import('../services/signer');
    return c.json({
      signerAddress: scoreSigner.getSignerAddress(),
    });
  } catch (error) {
    console.error('[ScoreRoute] Error getting signer:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * GET /api/score/tokens
 * Get all current token scores (in-memory, not signed)
 */
scoreRoutes.get('/tokens', async (c) => {
  try {
    const tokenScores = getLatestTokenScores();
    const tokens = Array.from(tokenScores.entries())
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
 * Get top scoring tokens
 */
scoreRoutes.get('/tokens/leaderboard', async (c) => {
  const limit = parseInt(c.req.query('limit') || '20');

  try {
    const tokenScores = getLatestTokenScores();
    const leaderboard = Array.from(tokenScores.entries())
      .map(([symbol, score], index) => ({
        tokenSymbol: symbol,
        score,
        tier: scoreCalculator.getScoreTier(score),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.min(limit, 50))
      .map((item, index) => ({ rank: index + 1, ...item }));

    return c.json({
      count: leaderboard.length,
      leaderboard,
    });
  } catch (error) {
    console.error('[ScoreRoute] Error fetching leaderboard:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// =============================================================================
// PAIR POOL ENDPOINTS (for LB DEX)
// =============================================================================

/**
 * GET /api/score/pair/:tokenX/:tokenY
 * Get the pair score for a token pair
 */
scoreRoutes.get('/pair/:tokenX/:tokenY', async (c) => {
  const tokenX = c.req.param('tokenX').toUpperCase();
  const tokenY = c.req.param('tokenY').toUpperCase();

  try {
    const pairResult = getPairScore(tokenX, tokenY);

    if (!pairResult) {
      return c.json(
        {
          error: 'Score not found for one or both tokens',
          tokenX,
          tokenY,
        },
        404
      );
    }

    const poolId = ScoreSigner.generatePairPoolId(tokenX, tokenY);

    return c.json({
      poolId,
      tokenX,
      tokenY,
      tokenXScore: pairResult.tokenXScore,
      tokenYScore: pairResult.tokenYScore,
      pairScore: pairResult.pairScore,
      tier: scoreCalculator.getScoreTier(pairResult.pairScore),
    });
  } catch (error) {
    console.error('[ScoreRoute] Error getting pair score:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * POST /api/score/pair/:tokenX/:tokenY/sign
 * Sign and store a pair score for on-chain use
 */
scoreRoutes.post('/pair/:tokenX/:tokenY/sign', async (c) => {
  const tokenX = c.req.param('tokenX').toUpperCase();
  const tokenY = c.req.param('tokenY').toUpperCase();

  try {
    const signedResult = await signPairScore(tokenX, tokenY);

    if (!signedResult) {
      return c.json(
        {
          error: 'Score not found for one or both tokens',
          tokenX,
          tokenY,
        },
        404
      );
    }

    return c.json({
      poolId: signedResult.poolId,
      tokenX,
      tokenY,
      tokenXScore: signedResult.tokenXScore,
      tokenYScore: signedResult.tokenYScore,
      pairScore: signedResult.pairScore,
      tier: scoreCalculator.getScoreTier(signedResult.pairScore),
      signature: signedResult.signature,
    });
  } catch (error) {
    console.error('[ScoreRoute] Error signing pair score:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * GET /api/score/pair/:tokenX/:tokenY/history
 * Get pair score history
 */
scoreRoutes.get('/pair/:tokenX/:tokenY/history', async (c) => {
  const tokenX = c.req.param('tokenX').toUpperCase();
  const tokenY = c.req.param('tokenY').toUpperCase();
  const limit = parseInt(c.req.query('limit') || '24');
  const offset = parseInt(c.req.query('offset') || '0');

  // Sort tokens for consistent lookup
  const [sortedX, sortedY] = [tokenX, tokenY].sort();
  const poolId = ScoreSigner.generatePairPoolId(sortedX, sortedY);

  try {
    const history = await db.query.pairScores.findMany({
      where: eq(schema.pairScores.poolId, poolId),
      orderBy: [desc(schema.pairScores.timestamp)],
      limit: Math.min(limit, 100),
      offset,
    });

    return c.json({
      poolId,
      tokenX: sortedX,
      tokenY: sortedY,
      count: history.length,
      history: history.map((s) => ({
        tokenXScore: s.tokenXScore,
        tokenYScore: s.tokenYScore,
        pairScore: s.pairScore,
        timestamp: s.timestamp,
        nonce: s.nonce,
        signature: s.signature,
        tier: scoreCalculator.getScoreTier(s.pairScore),
        createdAt: s.createdAt,
      })),
    });
  } catch (error) {
    console.error('[ScoreRoute] Error fetching pair history:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * GET /api/score/pair/:poolId
 * Get the latest signed score for a pair pool by poolId
 */
scoreRoutes.get('/pair/id/:poolId', async (c) => {
  const poolId = c.req.param('poolId');

  if (!poolId || !poolId.startsWith('0x')) {
    return c.json({ error: 'Invalid poolId format' }, 400);
  }

  try {
    const latestScore = await db.query.pairScores.findFirst({
      where: eq(schema.pairScores.poolId, poolId),
      orderBy: [desc(schema.pairScores.timestamp)],
    });

    if (!latestScore) {
      return c.json({ error: 'Score not found for this pool' }, 404);
    }

    return c.json({
      poolId: latestScore.poolId,
      tokenX: latestScore.tokenXSymbol,
      tokenY: latestScore.tokenYSymbol,
      tokenXScore: latestScore.tokenXScore,
      tokenYScore: latestScore.tokenYScore,
      pairScore: latestScore.pairScore,
      timestamp: latestScore.timestamp,
      nonce: latestScore.nonce,
      signature: latestScore.signature,
      tier: scoreCalculator.getScoreTier(latestScore.pairScore),
      createdAt: latestScore.createdAt,
    });
  } catch (error) {
    console.error('[ScoreRoute] Error fetching pair score:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * POST /api/score/pair/register
 * Register a new pair pool for tracking
 */
scoreRoutes.post('/pair/register', async (c) => {
  try {
    const body = await c.req.json();
    const { tokenXSymbol, tokenYSymbol, tokenXAddress, tokenYAddress } = body;

    if (!tokenXSymbol || !tokenYSymbol) {
      return c.json({ error: 'tokenXSymbol and tokenYSymbol are required' }, 400);
    }

    // Sort tokens for consistent ID
    const [sortedX, sortedY] = [tokenXSymbol.toUpperCase(), tokenYSymbol.toUpperCase()].sort();
    const poolId = ScoreSigner.generatePairPoolId(sortedX, sortedY);

    // Check if already exists
    const existing = await db.query.pairPools.findFirst({
      where: eq(schema.pairPools.poolId, poolId),
    });

    if (existing) {
      return c.json({
        message: 'Pair pool already registered',
        poolId,
        tokenX: existing.tokenXSymbol,
        tokenY: existing.tokenYSymbol,
      });
    }

    // Insert new pair pool
    await db.insert(schema.pairPools).values({
      poolId,
      tokenXSymbol: sortedX,
      tokenYSymbol: sortedY,
      tokenXAddress,
      tokenYAddress,
    });

    return c.json({
      message: 'Pair pool registered successfully',
      poolId,
      tokenX: sortedX,
      tokenY: sortedY,
    });
  } catch (error) {
    console.error('[ScoreRoute] Error registering pair pool:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * GET /api/score/pairs
 * Get all registered pair pools
 */
scoreRoutes.get('/pairs', async (c) => {
  const limit = parseInt(c.req.query('limit') || '50');
  const offset = parseInt(c.req.query('offset') || '0');

  try {
    const pairs = await db.query.pairPools.findMany({
      orderBy: [desc(schema.pairPools.createdAt)],
      limit: Math.min(limit, 100),
      offset,
    });

    return c.json({
      count: pairs.length,
      pairs: pairs.map((p) => ({
        poolId: p.poolId,
        tokenX: p.tokenXSymbol,
        tokenY: p.tokenYSymbol,
        createdAt: p.createdAt,
      })),
    });
  } catch (error) {
    console.error('[ScoreRoute] Error fetching pairs:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});
