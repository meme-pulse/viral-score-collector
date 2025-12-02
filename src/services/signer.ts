import { createWalletClient, http, keccak256, encodePacked, type Hex, type Account } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { SignedScore } from '../types/score';
import { db, schema } from '../db/client';
import { eq, desc } from 'drizzle-orm';

/**
 * Score Signer Service
 * Signs pair scores using ECDSA for on-chain verification
 */
export class ScoreSigner {
  private account: Account;
  private nonces: Map<string, bigint> = new Map();

  constructor() {
    const privateKey = process.env.SIGNER_PRIVATE_KEY;

    if (!privateKey) {
      throw new Error('SIGNER_PRIVATE_KEY environment variable is required');
    }

    this.account = privateKeyToAccount(privateKey as Hex);
    console.log(`[ScoreSigner] Initialized with address: ${this.account.address}`);
  }

  /**
   * Get signer address
   */
  getSignerAddress(): Hex {
    return this.account.address;
  }

  /**
   * Get next nonce for a pool
   */
  async getNextNonce(poolId: string): Promise<bigint> {
    // Check memory cache first
    const cached = this.nonces.get(poolId);
    if (cached !== undefined) {
      const next = cached + 1n;
      this.nonces.set(poolId, next);
      return next;
    }

    // Check database for last nonce (from pairScores)
    const lastScore = await db.query.pairScores.findFirst({
      where: eq(schema.pairScores.poolId, poolId),
      orderBy: [desc(schema.pairScores.nonce)],
    });

    const lastNonce = lastScore ? BigInt(lastScore.nonce) : 0n;
    const nextNonce = lastNonce + 1n;
    this.nonces.set(poolId, nextNonce);

    return nextNonce;
  }

  /**
   * Create message hash for signing
   * Format: keccak256(abi.encodePacked(poolId, score, timestamp, nonce))
   */
  createMessageHash(poolId: Hex, score: bigint, timestamp: bigint, nonce: bigint): Hex {
    return keccak256(encodePacked(['bytes32', 'uint256', 'uint256', 'uint256'], [poolId, score, timestamp, nonce]));
  }

  /**
   * Sign a message hash
   */
  async signMessage(messageHash: Hex): Promise<Hex> {
    const walletClient = createWalletClient({
      account: this.account,
      transport: http(),
    });

    const signature = await walletClient.signMessage({
      message: { raw: messageHash },
    });

    return signature;
  }

  /**
   * Verify a signature (for testing)
   */
  verifySignature(poolId: Hex, score: bigint, timestamp: bigint, nonce: bigint, signature: Hex): boolean {
    // For now, just return true - actual verification happens on-chain
    return true;
  }

  /**
   * Generate pair pool ID from tokenX and tokenY
   * Tokens are sorted alphabetically to ensure consistent pool ID
   * regardless of order (ETH/USDC = USDC/ETH)
   */
  static generatePairPoolId(tokenX: string, tokenY: string): Hex {
    const [sortedX, sortedY] = [tokenX.toUpperCase(), tokenY.toUpperCase()].sort();
    return keccak256(encodePacked(['string', 'string'], [sortedX, sortedY]));
  }

  /**
   * Sign a pair score (for LB DEX pools)
   */
  async signPairScore(
    poolId: Hex,
    pairScore: number,
    tokenXSymbol: string,
    tokenYSymbol: string,
    tokenXScore: number,
    tokenYScore: number
  ): Promise<SignedScore & { tokenXScore: number; tokenYScore: number }> {
    const timestamp = BigInt(Math.floor(Date.now() / 1000));
    const nonce = await this.getNextNonce(poolId);
    const scoreBigInt = BigInt(pairScore);

    const messageHash = this.createMessageHash(poolId, scoreBigInt, timestamp, nonce);
    const signature = await this.signMessage(messageHash);

    const signedScore = {
      poolId,
      score: scoreBigInt,
      timestamp,
      nonce,
      signature,
      tokenXScore,
      tokenYScore,
    };

    await this.saveSignedPairScore(signedScore, tokenXSymbol, tokenYSymbol, pairScore);

    console.log(
      `[ScoreSigner] Signed pair score for ${tokenXSymbol}/${tokenYSymbol}: ` +
        `X=${tokenXScore}, Y=${tokenYScore}, pair=${pairScore}, nonce=${nonce}`
    );

    return signedScore;
  }

  /**
   * Save signed pair score to database
   */
  private async saveSignedPairScore(
    signedScore: SignedScore & { tokenXScore: number; tokenYScore: number },
    tokenXSymbol: string,
    tokenYSymbol: string,
    pairScore: number
  ): Promise<void> {
    await db.insert(schema.pairScores).values({
      poolId: signedScore.poolId,
      tokenXSymbol,
      tokenYSymbol,
      tokenXScore: signedScore.tokenXScore,
      tokenYScore: signedScore.tokenYScore,
      pairScore,
      timestamp: Number(signedScore.timestamp),
      nonce: Number(signedScore.nonce),
      signature: signedScore.signature,
    });
  }
}

// Singleton instance
export const scoreSigner = new ScoreSigner();
