import { Hono } from 'hono';
import { db, schema } from '../db/client';
import { desc, eq } from 'drizzle-orm';
import { merkleBuilder } from '../services/merkle-builder';
import type { Hex } from 'viem';

export const merkleRoutes = new Hono();

/**
 * GET /api/merkle/root
 * Get the current merkle root
 */
merkleRoutes.get('/root', async (c) => {
  try {
    const latestCheckpoint = await db.query.merkleCheckpoints.findFirst({
      orderBy: [desc(schema.merkleCheckpoints.epoch)],
    });

    if (!latestCheckpoint) {
      return c.json({ error: 'No merkle checkpoint available' }, 404);
    }

    return c.json({
      root: latestCheckpoint.root,
      epoch: latestCheckpoint.epoch,
      poolCount: latestCheckpoint.poolCount,
      createdAt: latestCheckpoint.createdAt,
    });
  } catch (error) {
    console.error('[MerkleRoute] Error fetching root:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * GET /api/merkle/proof/:poolId
 * Get merkle proof for a specific pool
 */
merkleRoutes.get('/proof/:poolId', async (c) => {
  const poolId = c.req.param('poolId') as Hex;
  const epoch = c.req.query('epoch');

  if (!poolId || !poolId.startsWith('0x')) {
    return c.json({ error: 'Invalid poolId format' }, 400);
  }

  try {
    const proof = await merkleBuilder.getProofFromCheckpoint(poolId, epoch ? parseInt(epoch) : undefined);

    if (!proof) {
      return c.json({ error: 'Proof not found for this pool' }, 404);
    }

    return c.json({
      poolId: proof.poolId,
      score: proof.score,
      epoch: proof.epoch,
      proof: proof.proof,
      root: proof.root,
    });
  } catch (error) {
    console.error('[MerkleRoute] Error fetching proof:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * GET /api/merkle/verify
 * Verify a merkle proof
 */
merkleRoutes.post('/verify', async (c) => {
  try {
    const body = await c.req.json();
    const { poolId, score, epoch, proof, root } = body;

    if (!poolId || score === undefined || !epoch || !proof || !root) {
      return c.json({ error: 'Missing required fields: poolId, score, epoch, proof, root' }, 400);
    }

    const isValid = merkleBuilder.verifyProof({
      poolId,
      score,
      epoch,
      proof,
      root,
    });

    return c.json({
      valid: isValid,
      poolId,
      score,
      epoch,
    });
  } catch (error) {
    console.error('[MerkleRoute] Error verifying proof:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * GET /api/merkle/checkpoints
 * Get list of merkle checkpoints
 */
merkleRoutes.get('/checkpoints', async (c) => {
  const limit = parseInt(c.req.query('limit') || '10');

  try {
    const checkpoints = await db.query.merkleCheckpoints.findMany({
      orderBy: [desc(schema.merkleCheckpoints.epoch)],
      limit: Math.min(limit, 50),
      columns: {
        id: true,
        root: true,
        epoch: true,
        poolCount: true,
        createdAt: true,
        // Exclude treeData as it's large
      },
    });

    return c.json({
      count: checkpoints.length,
      checkpoints,
    });
  } catch (error) {
    console.error('[MerkleRoute] Error fetching checkpoints:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * GET /api/merkle/checkpoint/:epoch
 * Get a specific checkpoint by epoch
 */
merkleRoutes.get('/checkpoint/:epoch', async (c) => {
  const epoch = parseInt(c.req.param('epoch'));

  if (isNaN(epoch)) {
    return c.json({ error: 'Invalid epoch format' }, 400);
  }

  try {
    const checkpoint = await db.query.merkleCheckpoints.findFirst({
      where: eq(schema.merkleCheckpoints.epoch, epoch),
    });

    if (!checkpoint) {
      return c.json({ error: 'Checkpoint not found' }, 404);
    }

    // Parse tree data to get pool list
    const treeData = JSON.parse(checkpoint.treeData);
    const pools = treeData.leaves.map((l: { poolId: string; score: string }) => ({
      poolId: l.poolId,
      score: parseInt(l.score),
    }));

    return c.json({
      root: checkpoint.root,
      epoch: checkpoint.epoch,
      poolCount: checkpoint.poolCount,
      createdAt: checkpoint.createdAt,
      pools,
    });
  } catch (error) {
    console.error('[MerkleRoute] Error fetching checkpoint:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});
