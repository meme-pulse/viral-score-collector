import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import type { Hex } from "viem";
import { keccak256, encodePacked } from "viem";
import { db, schema } from "../db/client";
import { desc, eq } from "drizzle-orm";
import type { MerkleProof } from "../types/score";

/**
 * Merkle Tree Builder
 * Creates merkle trees for batch score verification
 */
export class MerkleBuilder {
  private currentTree: StandardMerkleTree<[string, bigint, bigint]> | null = null;
  private currentEpoch: number = 0;
  private scoreMap: Map<string, { score: bigint; index: number }> = new Map();

  /**
   * Get current epoch from database
   */
  async getCurrentEpoch(): Promise<number> {
    const lastCheckpoint = await db.query.merkleCheckpoints.findFirst({
      orderBy: [desc(schema.merkleCheckpoints.epoch)],
    });

    return lastCheckpoint ? lastCheckpoint.epoch + 1 : 1;
  }

  /**
   * Build merkle tree from current scores
   */
  async buildTree(
    scores: Map<string, { poolId: Hex; score: number }>
  ): Promise<{ root: Hex; epoch: number; poolCount: number }> {
    this.currentEpoch = await this.getCurrentEpoch();
    const epochBigInt = BigInt(this.currentEpoch);

    // Convert scores to leaf format: [poolId, score, epoch]
    const leaves: [string, bigint, bigint][] = [];
    this.scoreMap.clear();

    let index = 0;
    for (const [tokenSymbol, data] of scores) {
      const leaf: [string, bigint, bigint] = [
        data.poolId,
        BigInt(data.score),
        epochBigInt,
      ];
      leaves.push(leaf);
      this.scoreMap.set(data.poolId, { score: BigInt(data.score), index });
      index++;
    }

    if (leaves.length === 0) {
      throw new Error("Cannot build merkle tree with no scores");
    }

    // Build the tree
    this.currentTree = StandardMerkleTree.of(leaves, [
      "bytes32",
      "uint256",
      "uint256",
    ]);

    const root = this.currentTree.root as Hex;
    const poolCount = leaves.length;

    // Save checkpoint to database
    await this.saveCheckpoint(root, this.currentEpoch, poolCount, leaves);

    console.log(
      `[MerkleBuilder] Built tree: epoch=${this.currentEpoch}, pools=${poolCount}, root=${root.slice(0, 18)}...`
    );

    return { root, epoch: this.currentEpoch, poolCount };
  }

  /**
   * Save merkle checkpoint to database
   */
  private async saveCheckpoint(
    root: Hex,
    epoch: number,
    poolCount: number,
    leaves: [string, bigint, bigint][]
  ): Promise<void> {
    // Serialize tree data for proof generation later
    const treeData = JSON.stringify({
      leaves: leaves.map(([poolId, score, ep]) => ({
        poolId,
        score: score.toString(),
        epoch: ep.toString(),
      })),
      root,
    });

    await db.insert(schema.merkleCheckpoints).values({
      root,
      epoch,
      poolCount,
      treeData,
    });
  }

  /**
   * Get proof for a specific pool
   */
  getProof(poolId: Hex): MerkleProof | null {
    if (!this.currentTree) {
      console.error("[MerkleBuilder] No tree available");
      return null;
    }

    const scoreData = this.scoreMap.get(poolId);
    if (!scoreData) {
      console.error(`[MerkleBuilder] Pool not found in tree: ${poolId}`);
      return null;
    }

    try {
      // Find the leaf index and get proof
      for (const [index, leaf] of this.currentTree.entries()) {
        if (leaf[0] === poolId) {
          const proof = this.currentTree.getProof(index);
          return {
            poolId,
            score: Number(scoreData.score),
            epoch: this.currentEpoch,
            proof: proof as string[],
            root: this.currentTree.root,
          };
        }
      }

      return null;
    } catch (error) {
      console.error(`[MerkleBuilder] Failed to get proof for ${poolId}:`, error);
      return null;
    }
  }

  /**
   * Get proof from database checkpoint
   */
  async getProofFromCheckpoint(
    poolId: Hex,
    epoch?: number
  ): Promise<MerkleProof | null> {
    // Get checkpoint from database
    const checkpoint = epoch
      ? await db.query.merkleCheckpoints.findFirst({
          where: eq(schema.merkleCheckpoints.epoch, epoch),
        })
      : await db.query.merkleCheckpoints.findFirst({
          orderBy: [desc(schema.merkleCheckpoints.epoch)],
        });

    if (!checkpoint) {
      return null;
    }

    try {
      const treeData = JSON.parse(checkpoint.treeData);
      const leaves: [string, bigint, bigint][] = treeData.leaves.map(
        (l: { poolId: string; score: string; epoch: string }) => [
          l.poolId,
          BigInt(l.score),
          BigInt(l.epoch),
        ]
      );

      // Rebuild tree
      const tree = StandardMerkleTree.of(leaves, [
        "bytes32",
        "uint256",
        "uint256",
      ]);

      // Find and return proof
      for (const [index, leaf] of tree.entries()) {
        if (leaf[0] === poolId) {
          const proof = tree.getProof(index);
          return {
            poolId,
            score: Number(leaf[1]),
            epoch: checkpoint.epoch,
            proof: proof as string[],
            root: tree.root,
          };
        }
      }

      return null;
    } catch (error) {
      console.error("[MerkleBuilder] Failed to get proof from checkpoint:", error);
      return null;
    }
  }

  /**
   * Get current tree root
   */
  getCurrentRoot(): Hex | null {
    return this.currentTree ? (this.currentTree.root as Hex) : null;
  }

  /**
   * Get current epoch
   */
  getEpoch(): number {
    return this.currentEpoch;
  }

  /**
   * Verify a proof locally (for testing)
   */
  verifyProof(proof: MerkleProof): boolean {
    try {
      const leaf: [string, bigint, bigint] = [
        proof.poolId,
        BigInt(proof.score),
        BigInt(proof.epoch),
      ];

      return StandardMerkleTree.verify(
        proof.root,
        ["bytes32", "uint256", "uint256"],
        leaf,
        proof.proof
      );
    } catch (error) {
      console.error("[MerkleBuilder] Proof verification failed:", error);
      return false;
    }
  }
}

// Singleton instance
export const merkleBuilder = new MerkleBuilder();

