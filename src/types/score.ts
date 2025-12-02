/**
 * Score-related Type Definitions
 */

export interface SignedScore {
  poolId: `0x${string}`;
  score: bigint;
  timestamp: bigint;
  nonce: bigint;
  signature: `0x${string}`;
}

export interface ScoreRecord {
  id: number;
  poolId: string;
  tokenSymbol: string;
  score: number;
  timestamp: Date;
  nonce: number;
  signature: string;
  createdAt: Date;
}

export interface MerkleCheckpoint {
  id: number;
  root: string;
  epoch: number;
  poolCount: number;
  createdAt: Date;
}

export interface MerkleProof {
  poolId: string;
  score: number;
  epoch: number;
  proof: string[];
  root: string;
}

export interface ScoreWeights {
  posts: number;
  views: number;
  likes: number;
  reposts: number;
  replies: number;
  uniqueUsers: number;
}

/**
 * Enhanced scoring multipliers based on 50-page Memex data analysis
 * These are applied as multipliers to the base score
 */
export interface EnhancedScoreMultipliers {
  graduatedTokenBonus: number;      // Bonus for tokens with 100% bonding curve
  imagePostBonus: number;           // Bonus for posts with images (1.28x engagement)
  priceVolatilityBonus: number;     // Bonus for price movement (indicates trading activity)
  preOrderedUserWeight: number;     // Weight for pre-ordered user posts
}

export interface PoolInfo {
  poolId: string;
  tokenSymbol: string;
  tokenAddress?: string;
  createdAt: Date;
}

export interface WebSocketMessage {
  type: 'subscribe' | 'unsubscribe' | 'scoreUpdate' | 'error';
  poolIds?: string[];
  data?: SignedScore;
  error?: string;
}
