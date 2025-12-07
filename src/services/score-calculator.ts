import type { AggregatedMetrics } from '../types/memex';
import type { ScoreWeights, EnhancedScoreMultipliers } from '../types/score';

/**
 * Default scoring weights
 * Adjust these to tune the viral score algorithm
 */
const DEFAULT_WEIGHTS: ScoreWeights = {
  posts: 100, // Each post is worth 100 points
  views: 1, // Each view is worth 1 point
  likes: 20, // Each like is worth 20 points
  reposts: 50, // Each repost is worth 50 points (high viral indicator)
  replies: 30, // Each reply is worth 30 points (engagement)
  uniqueUsers: 200, // Each unique user is worth 200 points (reach)
};

/**
 * Enhanced multipliers based on 50-page Memex data analysis
 * Key findings:
 * - Graduated (100% bonding) posts have 2.25x higher engagement (1286 vs 572)
 * - Posts with images have 1.28x higher engagement (715 vs 558)
 * - Price volatility indicates active trading
 */
const DEFAULT_MULTIPLIERS: EnhancedScoreMultipliers = {
  graduatedTokenBonus: 1.5, // 50% bonus for fully graduated tokens
  imagePostBonus: 1.2, // 20% bonus for image-rich content
  priceVolatilityBonus: 1.1, // 10% bonus for price movement (capped)
  preOrderedUserWeight: 1.0, // Neutral weight (analysis showed 0.96x ratio)
};

/**
 * Score calculation constants
 */
const MAX_SCORE = 10000; // Maximum score in basis points
const MIN_SCORE = 0;
const SCORE_NORMALIZER = 10000; // Normalizer to bring raw scores to 0-10000 range

// Time decay constants
const TIME_DECAY_HALF_LIFE_HOURS = 24; // Score halves every 24 hours
const MAX_AGE_HOURS = 168; // 7 days - posts older than this get minimal weight

// Enhanced scoring thresholds
const GRADUATED_THRESHOLD = 0.3; // 30% of posts from graduated tokens = bonus
const IMAGE_THRESHOLD = 0.5; // 50% posts with images = bonus
const VOLATILITY_THRESHOLD = 1.0; // 1% avg price change = bonus

/**
 * Viral Score Calculator
 * Calculates viral scores based on social media engagement metrics
 * Enhanced with multipliers based on 50-page Memex data analysis
 */
export class ScoreCalculator {
  private weights: ScoreWeights;
  private multipliers: EnhancedScoreMultipliers;

  constructor(weights: ScoreWeights = DEFAULT_WEIGHTS, multipliers: EnhancedScoreMultipliers = DEFAULT_MULTIPLIERS) {
    this.weights = weights;
    this.multipliers = multipliers;
  }

  /**
   * Calculate raw score from metrics
   */
  calculateRawScore(metrics: AggregatedMetrics): number {
    return (
      metrics.posts * this.weights.posts +
      metrics.views * this.weights.views +
      metrics.likes * this.weights.likes +
      metrics.reposts * this.weights.reposts +
      metrics.replies * this.weights.replies +
      metrics.uniqueUserCount * this.weights.uniqueUsers
    );
  }

  /**
   * Calculate enhanced multiplier based on token metrics
   * Based on 50-page analysis findings
   */
  calculateEnhancedMultiplier(metrics: AggregatedMetrics): { multiplier: number; factors: string[] } {
    let multiplier = 1.0;
    const factors: string[] = [];

    // Graduated token bonus (100% bonding curve)
    // Analysis showed 2.25x engagement for graduated tokens
    if (metrics.graduatedPostRatio >= GRADUATED_THRESHOLD) {
      const bonus = 1 + (this.multipliers.graduatedTokenBonus - 1) * Math.min(metrics.graduatedPostRatio / 0.5, 1);
      multiplier *= bonus;
      factors.push(`graduated:${(bonus * 100 - 100).toFixed(0)}%`);
    }

    // Image post bonus
    // Analysis showed 1.28x engagement for posts with images
    if (metrics.imagePostRatio >= IMAGE_THRESHOLD) {
      const bonus = 1 + (this.multipliers.imagePostBonus - 1) * Math.min(metrics.imagePostRatio, 1);
      multiplier *= bonus;
      factors.push(`image:${(bonus * 100 - 100).toFixed(0)}%`);
    }

    // Price volatility bonus (indicates active trading)
    if (metrics.avgPriceFluctuation >= VOLATILITY_THRESHOLD) {
      const volatilityFactor = Math.min(metrics.avgPriceFluctuation / 5, 1); // Cap at 5%
      const bonus = 1 + (this.multipliers.priceVolatilityBonus - 1) * volatilityFactor;
      multiplier *= bonus;
      factors.push(`volatility:${(bonus * 100 - 100).toFixed(0)}%`);
    }

    return { multiplier, factors };
  }

  /**
   * Calculate time decay factor
   * Newer posts get higher weight, older posts decay exponentially
   * Posts older than 7 days get 100% decay (score = 0)
   */
  calculateTimeDecay(latestPostTime: Date): number {
    const now = Date.now();
    const postTime = latestPostTime.getTime();
    const ageHours = (now - postTime) / (1000 * 60 * 60);

    // If post is too old (> 7 days), return 0 (100% decay)
    if (ageHours > MAX_AGE_HOURS) {
      return 0;
    }

    // Exponential decay: e^(-t / halfLife)
    const decayFactor = Math.exp((-ageHours * Math.LN2) / TIME_DECAY_HALF_LIFE_HOURS);

    return decayFactor; // No minimum - can decay to 0
  }

  /**
   * Apply anti-gaming adjustments
   * Detects suspicious patterns and reduces score accordingly
   */
  applyAntiGaming(metrics: AggregatedMetrics, rawScore: number): { score: number; penalty: number } {
    let penalty = 0;

    // Check for suspicious view-to-engagement ratio
    // If views are very high but engagement is low, it might be botted
    if (metrics.views > 1000) {
      const engagementRate = (metrics.likes + metrics.reposts + metrics.replies) / metrics.views;

      if (engagementRate < 0.001) {
        // Less than 0.1% engagement
        penalty += 0.3; // 30% penalty
      }
    }

    // Check for suspicious single-user dominance
    // If most posts are from few users, reduce score
    if (metrics.posts > 10 && metrics.uniqueUserCount < 3) {
      penalty += 0.2; // 20% penalty
    }

    // Check for spam-like behavior (too many posts in short time)
    // This would need historical data, simplified here
    if (metrics.posts > 50) {
      penalty += 0.1; // 10% penalty for potential spam
    }

    const adjustedScore = rawScore * (1 - Math.min(penalty, 0.5)); // Max 50% penalty
    return { score: adjustedScore, penalty };
  }

  /**
   * Normalize score to 0-10000 range (basis points)
   */
  normalizeScore(rawScore: number): number {
    // Apply sigmoid-like normalization for smooth curve
    // This prevents extreme scores and provides good distribution
    const normalized = (rawScore / (rawScore + SCORE_NORMALIZER)) * MAX_SCORE;
    return Math.round(Math.min(MAX_SCORE, Math.max(MIN_SCORE, normalized)));
  }

  /**
   * Calculate final viral score with enhanced multipliers
   */
  calculate(metrics: AggregatedMetrics): number {
    // 1. Calculate raw score
    let rawScore = this.calculateRawScore(metrics);

    // 2. Apply time decay
    const timeDecay = this.calculateTimeDecay(metrics.latestPostTime);
    rawScore *= timeDecay;

    // 3. Apply anti-gaming adjustments
    const { score: adjustedScore, penalty } = this.applyAntiGaming(metrics, rawScore);

    if (penalty > 0) {
      console.log(`[ScoreCalculator] Applied ${(penalty * 100).toFixed(0)}% penalty to ${metrics.tokenSymbol}`);
    }

    // 4. Apply enhanced multipliers (new!)
    const { multiplier, factors } = this.calculateEnhancedMultiplier(metrics);
    const enhancedScore = adjustedScore * multiplier;

    if (factors.length > 0) {
      console.log(`[ScoreCalculator] ${metrics.tokenSymbol} bonuses: ${factors.join(', ')}`);
    }

    // 5. Normalize to 0-10000
    const finalScore = this.normalizeScore(enhancedScore);

    console.log(
      `[ScoreCalculator] ${metrics.tokenSymbol}: raw=${rawScore.toFixed(0)}, ` +
        `decay=${timeDecay.toFixed(2)}, mult=${multiplier.toFixed(2)}, final=${finalScore}`
    );

    return finalScore;
  }

  /**
   * Calculate scores for multiple tokens
   */
  calculateBatch(metricsArray: AggregatedMetrics[]): Map<string, number> {
    const scores = new Map<string, number>();

    for (const metrics of metricsArray) {
      const score = this.calculate(metrics);
      scores.set(metrics.tokenSymbol, score);
    }

    return scores;
  }

  /**
   * Get score tier based on score value
   */
  getScoreTier(score: number): string {
    if (score >= 8000) return 'LEGENDARY';
    if (score >= 6000) return 'VIRAL';
    if (score >= 4000) return 'HOT';
    if (score >= 2000) return 'WARM';
    if (score >= 500) return 'ACTIVE';
    return 'COLD';
  }

  /**
   * Calculate protocol share reduction based on score
   * Higher viral score = lower protocol share (yield boost)
   */
  calculateProtocolShareReduction(score: number, baseProtocolShare: number): number {
    // Max 50% reduction at score 10000
    const maxReductionBps = 5000;
    const reductionBps = Math.floor((score * maxReductionBps) / MAX_SCORE);
    const adjustedShare = Math.floor((baseProtocolShare * (10000 - reductionBps)) / 10000);

    return Math.max(0, adjustedShare);
  }

  /**
   * Calculate pair score from two token scores
   * Uses average of both scores (can be changed to min, weighted, etc.)
   */
  calculatePairScore(tokenXScore: number, tokenYScore: number): number {
    // Average of both scores
    const avgScore = Math.round((tokenXScore + tokenYScore) / 2);
    return Math.min(MAX_SCORE, Math.max(MIN_SCORE, avgScore));
  }

  /**
   * Calculate pair scores for all possible pairs from token scores
   */
  calculateAllPairScores(
    tokenScores: Map<string, number>
  ): Map<string, { tokenX: string; tokenY: string; pairScore: number; tokenXScore: number; tokenYScore: number }> {
    const pairScores = new Map<string, { tokenX: string; tokenY: string; pairScore: number; tokenXScore: number; tokenYScore: number }>();

    const tokens = Array.from(tokenScores.keys());

    // Generate all unique pairs
    for (let i = 0; i < tokens.length; i++) {
      for (let j = i + 1; j < tokens.length; j++) {
        const tokenX = tokens[i];
        const tokenY = tokens[j];
        const tokenXScore = tokenScores.get(tokenX) || 0;
        const tokenYScore = tokenScores.get(tokenY) || 0;

        // Sort tokens for consistent pair ID
        const [sortedX, sortedY] = [tokenX, tokenY].sort();
        const pairKey = `${sortedX}/${sortedY}`;

        const pairScore = this.calculatePairScore(tokenXScore, tokenYScore);

        pairScores.set(pairKey, {
          tokenX: sortedX,
          tokenY: sortedY,
          pairScore,
          tokenXScore: sortedX === tokenX ? tokenXScore : tokenYScore,
          tokenYScore: sortedY === tokenY ? tokenYScore : tokenXScore,
        });
      }
    }

    return pairScores;
  }

  /**
   * Get pair score for a specific token pair
   */
  getPairScore(
    tokenScores: Map<string, number>,
    tokenX: string,
    tokenY: string
  ): { pairScore: number; tokenXScore: number; tokenYScore: number } | null {
    const tokenXScore = tokenScores.get(tokenX.toUpperCase());
    const tokenYScore = tokenScores.get(tokenY.toUpperCase());

    if (tokenXScore === undefined || tokenYScore === undefined) {
      return null;
    }

    return {
      pairScore: this.calculatePairScore(tokenXScore, tokenYScore),
      tokenXScore,
      tokenYScore,
    };
  }
}

// Singleton instance with default weights
export const scoreCalculator = new ScoreCalculator();







