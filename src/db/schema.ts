import { pgTable, serial, varchar, integer, timestamp, text, bigint, index, uniqueIndex, boolean, real } from 'drizzle-orm/pg-core';

/**
 * Token Scores table - Stores individual token viral scores
 * These are the base scores used to calculate pair scores
 */
export const tokenScores = pgTable(
  'token_scores',
  {
    id: serial('id').primaryKey(),
    tokenSymbol: varchar('token_symbol', { length: 32 }).notNull(),
    score: integer('score').notNull(), // 0-10000 basis points
    // Raw metrics for debugging/auditing
    rawPosts: integer('raw_posts').default(0),
    rawViews: integer('raw_views').default(0),
    rawLikes: integer('raw_likes').default(0),
    rawReposts: integer('raw_reposts').default(0),
    rawReplies: integer('raw_replies').default(0),
    rawUniqueUsers: integer('raw_unique_users').default(0),
    // Enhanced metrics
    avgBondingCurve: real('avg_bonding_curve').default(0),
    graduatedRatio: real('graduated_ratio').default(0),
    imageRatio: real('image_ratio').default(0),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    tokenSymbolIdx: index('token_scores_symbol_idx').on(table.tokenSymbol),
    createdAtIdx: index('token_scores_created_at_idx').on(table.createdAt),
  })
);

/**
 * Pair Pools table - Tracks registered LB DEX pair pools
 * Pool ID is derived from sorted tokenX + tokenY (no binStep)
 */
export const pairPools = pgTable(
  'pair_pools',
  {
    id: serial('id').primaryKey(),
    poolId: varchar('pool_id', { length: 66 }).notNull().unique(),
    tokenXSymbol: varchar('token_x_symbol', { length: 32 }).notNull(),
    tokenYSymbol: varchar('token_y_symbol', { length: 32 }).notNull(),
    tokenXAddress: varchar('token_x_address', { length: 42 }),
    tokenYAddress: varchar('token_y_address', { length: 42 }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    poolIdIdx: uniqueIndex('pair_pool_id_idx').on(table.poolId),
    tokenPairIdx: index('pair_tokens_idx').on(table.tokenXSymbol, table.tokenYSymbol),
  })
);

/**
 * Pair Scores table - Stores signed viral scores for token pairs
 * Score is calculated from tokenX score + tokenY score
 */
export const pairScores = pgTable(
  'pair_scores',
  {
    id: serial('id').primaryKey(),
    poolId: varchar('pool_id', { length: 66 }).notNull(),

    tokenXSymbol: varchar('token_x_symbol', { length: 32 }).notNull(),
    tokenYSymbol: varchar('token_y_symbol', { length: 32 }).notNull(),
    // Individual token scores
    tokenXScore: integer('token_x_score').notNull(),
    tokenYScore: integer('token_y_score').notNull(),
    // Combined pair score
    pairScore: integer('pair_score').notNull(), // 0-10000 basis points
    // Signature data for on-chain verification
    timestamp: bigint('timestamp', { mode: 'number' }).notNull(),
    nonce: bigint('nonce', { mode: 'number' }).notNull(),
    signature: text('signature').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    poolIdIdx: index('pair_scores_pool_id_idx').on(table.poolId),
    timestampIdx: index('pair_scores_timestamp_idx').on(table.timestamp),
    poolTimestampIdx: index('pair_scores_pool_timestamp_idx').on(table.poolId, table.timestamp),
  })
);

/**
 * Merkle Checkpoints table - Stores periodic merkle tree roots
 */
export const merkleCheckpoints = pgTable(
  'merkle_checkpoints',
  {
    id: serial('id').primaryKey(),
    root: varchar('root', { length: 66 }).notNull(),
    epoch: integer('epoch').notNull().unique(),
    poolCount: integer('pool_count').notNull(),
    // Store the full tree data as JSON for proof generation
    treeData: text('tree_data').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    epochIdx: uniqueIndex('merkle_epoch_idx').on(table.epoch),
    rootIdx: index('merkle_root_idx').on(table.root),
  })
);

/**
 * Memex Posts table - Cache of processed Memex posts
 */
export const memexPosts = pgTable(
  'memex_posts',
  {
    id: serial('id').primaryKey(),
    memexPostId: integer('memex_post_id').notNull().unique(),
    userId: integer('user_id').notNull(),
    userName: varchar('user_name', { length: 64 }),
    userIsPreOrdered: boolean('user_is_pre_ordered').default(false),
    contentType: varchar('content_type', { length: 16 }).notNull(),
    viewCount: integer('view_count').default(0),
    likeCount: integer('like_count').default(0),
    repostCount: integer('repost_count').default(0),
    replyCount: integer('reply_count').default(0),
    // Token-related metrics
    bondingCurveProgress: real('bonding_curve_progress').default(0),
    priceFluctuationRange: real('price_fluctuation_range').default(0),
    tokenCexListed: boolean('token_cex_listed').default(false),
    // Content analysis
    hasImage: boolean('has_image').default(false),
    mentionedTokens: text('mentioned_tokens'), // JSON array of @mentions
    extractedTickers: text('extracted_tickers'), // JSON array of $TICKER patterns
    extractedHashtags: text('extracted_hashtags'), // JSON array of #hashtags
    postCreatedAt: timestamp('post_created_at').notNull(),
    processedAt: timestamp('processed_at').defaultNow().notNull(),
  },
  (table) => ({
    memexPostIdIdx: uniqueIndex('memex_post_id_idx').on(table.memexPostId),
    postCreatedAtIdx: index('memex_post_created_at_idx').on(table.postCreatedAt),
    bondingCurveIdx: index('memex_bonding_curve_idx').on(table.bondingCurveProgress),
  })
);

// Type exports for Drizzle
export type TokenScore = typeof tokenScores.$inferSelect;
export type NewTokenScore = typeof tokenScores.$inferInsert;
export type PairPool = typeof pairPools.$inferSelect;
export type NewPairPool = typeof pairPools.$inferInsert;
export type PairScore = typeof pairScores.$inferSelect;
export type NewPairScore = typeof pairScores.$inferInsert;
export type MerkleCheckpoint = typeof merkleCheckpoints.$inferSelect;
export type NewMerkleCheckpoint = typeof merkleCheckpoints.$inferInsert;
export type MemexPost = typeof memexPosts.$inferSelect;
export type NewMemexPost = typeof memexPosts.$inferInsert;
