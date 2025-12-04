/**
 * Score-related Type Definitions
 */

export interface ScoreRecord {
  id: number;
  tokenSymbol: string;
  score: number;
  timestamp: Date;
  createdAt: Date;
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
 * Enhanced scoring multipliers based on Memex data analysis
 */
export interface EnhancedScoreMultipliers {
  graduatedTokenBonus: number;
  imagePostBonus: number;
  priceVolatilityBonus: number;
  preOrderedUserWeight: number;
}
