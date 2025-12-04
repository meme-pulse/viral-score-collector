/**
 * Memex API Type Definitions
 * Based on: https://app.memex.xyz/api/service/public/post/v2/latest
 */

export interface MemexUser {
  id: number;
  displayName: string;
  profileImageUrl: string;
  userName: string;
  userNameTag: string;
  userType: 'GENERAL' | 'VERIFIED' | 'OFFICIAL';
  isPreOrdered: boolean;
}

export interface MemexBodyItem {
  type: 'text' | 'mention' | 'hashtag' | 'return';
  value: string;
  metadata?: {
    userNameTag: string;
  };
}

export interface MemexPost {
  id: number;
  user: MemexUser;
  tokenCexListed: boolean;
  bondingCurveProgress: number;
  priceFluctuationRange: number;
  prevId: number | null;
  parentId: number | null;
  nextId: number | null;
  contentType: 'POST' | 'REPLY' | 'REPOST';
  imageSrc: string[];
  createdAt: string;
  updatedAt: string;
  value: string;
  body: MemexBodyItem[];
  hashTags: string[];
  mentions: string[];
  viewCount: number;
  repostCount: number;
  replyCount: number;
  likeCount: number;
  isBlocked: boolean;
  liked: boolean;
  isFollow: boolean;
  rePoster: MemexUser | null;
  rePosted: boolean;
  isPined: boolean;
  threads: MemexPost[];
  totalThreadCount: number;
}

export interface MemexApiResponse {
  contents: MemexPost[];
  nextCursor: number | null;
  rePostCursor: number | null;
}

export interface TokenMetrics {
  tokenSymbol: string;
  posts: number;
  views: number;
  likes: number;
  reposts: number;
  replies: number;
  uniqueUsers: Set<number>;
  latestPostTime: Date;
  // Enhanced metrics from 50-page analysis
  avgBondingCurveProgress: number;
  graduatedPostCount: number; // posts with bondingCurveProgress = 100
  postsWithImages: number;
  totalPriceFluctuation: number;
  preOrderedUserPosts: number;
}

export interface AggregatedMetrics {
  tokenSymbol: string;
  posts: number;
  views: number;
  likes: number;
  reposts: number;
  replies: number;
  uniqueUserCount: number;
  latestPostTime: Date;
  // Enhanced metrics
  avgBondingCurveProgress: number;
  graduatedPostRatio: number; // 0-1, ratio of posts from graduated tokens
  imagePostRatio: number; // 0-1, ratio of posts with images
  avgPriceFluctuation: number;
  preOrderedUserRatio: number; // 0-1, ratio of posts from pre-ordered users
}

/**
 * Token extraction result with source tracking
 */
export interface ExtractedTokens {
  mentions: string[]; // @username mentions
  tickers: string[]; // $TICKER patterns
  hashtags: string[]; // #hashtag patterns
  all: string[]; // Combined unique tokens
}

/**
 * Memex Leaderboard API Types
 * Based on: https://app.memex.xyz/api/leaderboard/public/rank/v2.1/getRank
 */
export interface MemexLeaderboardUser {
  id: number;
  profileImageUrl: string;
  tokenImageUrl: string;
  userName: string;
  userNameTag: string;
  displayName: string;
}

export interface MemexLeaderboardToken {
  id: number;
  tokenAddress: string;
  tokenName: string;
  tokenSymbol: string;
  tokenPriceNow: string;
  tokenPrice24hChange: number;
  age: string;
  transactions: number;
  volume: number;
  holder: number;
  updatedAt: string;
  bondingCurveProgress: number;
  isTargetPriceReached: boolean;
  user: MemexLeaderboardUser;
  tokenUsdPriceNow: string;
  tokenUsdPrice24hChange: number;
  tokenUsdPrice24hChangePercent: number;
  isCexListed: boolean;
}

export interface MemexLeaderboardResponse {
  data: MemexLeaderboardToken[];
  hasNextPage: boolean;
  nextCursor: number | null;
  rankUpdatedAt: string;
  tokenUsdPriceUpdatedAt: string;
}

/**
 * Token image mapping cache
 */
export interface TokenImageInfo {
  tokenSymbol: string;
  tokenName: string;
  tokenAddress: string;
  imageSrc: string;
  bondingCurveProgress: number;
  tokenPriceUsd: string;
  updatedAt: Date;
}





