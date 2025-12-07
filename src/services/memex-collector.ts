import type {
  MemexApiResponse,
  MemexPost,
  TokenMetrics,
  AggregatedMetrics,
  ExtractedTokens,
  MemexLeaderboardResponse,
  TokenImageInfo,
} from '../types/memex';
import { db, schema } from '../db/client';
import { eq, gte, desc } from 'drizzle-orm';
import type { MemexPost as DBMemexPost } from '../db/schema';

const MEMEX_API_BASE = process.env.MEMEX_API_BASE || 'https://app.memex.xyz/api/service/public';
const MEMEX_LEADERBOARD_API = 'https://app.memex.xyz/api/leaderboard/public/rank/v2.1/getRank';

/**
 * Memex Data Collector
 * Fetches and processes social media data from Memex API
 * Now uses DB-based aggregation for accurate real-time metrics
 */
export class MemexCollector {
  private lastCursor: number | null = null;

  // In-memory cache for token images
  private tokenImageCache: Map<string, TokenImageInfo> = new Map();
  private tokenImageCacheUpdatedAt: Date | null = null;

  /**
   * Fetch latest posts from Memex API
   */
  async fetchLatestPosts(): Promise<MemexPost[]> {
    const url = `${MEMEX_API_BASE}/post/v2/latest`;

    try {
      const response = await fetch(url, {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'ViralScoreBot/1.0',
        },
      });

      if (!response.ok) {
        throw new Error(`Memex API error: ${response.status}`);
      }

      const data = (await response.json()) as MemexApiResponse;
      this.lastCursor = data.nextCursor;

      return data.contents;
    } catch (error) {
      console.error('[MemexCollector] Failed to fetch posts:', error);
      return [];
    }
  }

  /**
   * Fetch posts with pagination
   */
  async fetchPostsWithCursor(cursor?: number): Promise<MemexApiResponse> {
    const url = cursor ? `${MEMEX_API_BASE}/post/v2/latest?cursor=${cursor}` : `${MEMEX_API_BASE}/post/v2/latest`;

    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'ViralScoreBot/1.0',
      },
    });

    if (!response.ok) {
      throw new Error(`Memex API error: ${response.status}`);
    }

    return (await response.json()) as MemexApiResponse;
  }

  /**
   * Extract mentioned tokens from a post (legacy method for compatibility)
   */
  extractMentionedTokens(post: MemexPost): string[] {
    const extracted = this.extractTokensEnhanced(post);
    return extracted.all;
  }

  /**
   * Enhanced token extraction with source tracking
   * Based on 50-page analysis findings:
   * - Mentions (@) are most reliable for token identification
   * - $TICKER patterns need filtering (exclude pure numbers)
   * - Hashtags provide moderate signal
   */
  extractTokensEnhanced(post: MemexPost): ExtractedTokens {
    const mentions: string[] = [];
    const hashtags: string[] = [];
    const tickers: string[] = [];

    // Extract @mentions from body (MOST RELIABLE per analysis)
    for (const item of post.body) {
      if (item.type === 'mention' && item.value) {
        mentions.push(item.value.toUpperCase());
      }
      if (item.type === 'hashtag' && item.value) {
        hashtags.push(item.value.toUpperCase());
      }
    }

    // Also check hashTags array
    for (const tag of post.hashTags) {
      hashtags.push(tag.toUpperCase());
    }

    // Extract $TICKER patterns from text content
    // Pattern: $ followed by letter, then alphanumeric (1-9 more chars)
    // This filters out $88, $1061M style false positives
    const tickerPattern = /\$([A-Za-z][A-Za-z0-9]{0,9})\b/g;
    const textContent = post.value || '';
    const matches = textContent.matchAll(tickerPattern);
    for (const match of matches) {
      tickers.push(match[1].toUpperCase());
    }

    // Combine all unique tokens
    const all = [...new Set([...mentions, ...tickers, ...hashtags])];

    return {
      mentions: [...new Set(mentions)],
      tickers: [...new Set(tickers)],
      hashtags: [...new Set(hashtags)],
      all,
    };
  }

  /**
   * Aggregate metrics by token from API posts
   * Used for immediate processing before DB save
   */
  aggregateByToken(posts: MemexPost[]): Map<string, TokenMetrics> {
    const metrics = new Map<string, TokenMetrics>();
    let processedCount = 0;
    let totalTokensExtracted = 0;

    for (const post of posts) {
      const tokens = this.extractMentionedTokens(post);
      totalTokensExtracted += tokens.length;

      for (const token of tokens) {
        const existing = metrics.get(token) || {
          tokenSymbol: token,
          posts: 0,
          views: 0,
          likes: 0,
          reposts: 0,
          replies: 0,
          uniqueUsers: new Set<number>(),
          latestPostTime: new Date(0),
          avgBondingCurveProgress: 0,
          graduatedPostCount: 0,
          postsWithImages: 0,
          totalPriceFluctuation: 0,
          preOrderedUserPosts: 0,
        };

        existing.posts += 1;
        existing.views += post.viewCount;
        existing.likes += post.likeCount;
        existing.reposts += post.repostCount;
        existing.replies += post.replyCount;
        existing.uniqueUsers.add(post.user.id);

        existing.avgBondingCurveProgress += post.bondingCurveProgress;
        if (post.bondingCurveProgress === 100) {
          existing.graduatedPostCount += 1;
        }
        if (post.imageSrc && post.imageSrc.length > 0) {
          existing.postsWithImages += 1;
        }
        existing.totalPriceFluctuation += Math.abs(post.priceFluctuationRange);
        if (post.user.isPreOrdered) {
          existing.preOrderedUserPosts += 1;
        }

        const postTime = new Date(post.createdAt);
        if (postTime > existing.latestPostTime) {
          existing.latestPostTime = postTime;
        }

        metrics.set(token, existing);
      }

      processedCount++;
    }

    console.log(
      `[MemexCollector] Aggregation: ${processedCount} posts processed, ${totalTokensExtracted} tokens extracted, ${metrics.size} unique tokens found`
    );

    return metrics;
  }

  /**
   * Aggregate metrics from DB posts (7 days window)
   * This uses the latest metrics from DB, reflecting real-time updates
   */
  async aggregateFromDB(): Promise<AggregatedMetrics[]> {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    console.log('[MemexCollector] Fetching posts from DB (last 7 days)...');

    // Fetch all posts from the last 7 days from DB
    const dbPosts = await db.query.memexPosts.findMany({
      where: gte(schema.memexPosts.postCreatedAt, sevenDaysAgo),
    });

    console.log(`[MemexCollector] Found ${dbPosts.length} posts in DB from last 7 days`);

    if (dbPosts.length === 0) {
      return [];
    }

    // Aggregate metrics by token from DB posts
    const metrics = new Map<string, TokenMetrics>();
    const usersByToken = new Map<string, Set<number>>();

    for (const post of dbPosts) {
      // Parse stored token arrays and normalize to uppercase for consistency
      const mentions: string[] = post.mentionedTokens ? JSON.parse(post.mentionedTokens).map((t: string) => t.toUpperCase()) : [];
      const tickers: string[] = post.extractedTickers ? JSON.parse(post.extractedTickers).map((t: string) => t.toUpperCase()) : [];
      const hashtags: string[] = post.extractedHashtags ? JSON.parse(post.extractedHashtags).map((t: string) => t.toUpperCase()) : [];
      const allTokens = [...new Set([...mentions, ...tickers, ...hashtags])];

      for (const token of allTokens) {
        const existing = metrics.get(token) || {
          tokenSymbol: token,
          posts: 0,
          views: 0,
          likes: 0,
          reposts: 0,
          replies: 0,
          uniqueUsers: new Set<number>(),
          latestPostTime: new Date(0),
          avgBondingCurveProgress: 0,
          graduatedPostCount: 0,
          postsWithImages: 0,
          totalPriceFluctuation: 0,
          preOrderedUserPosts: 0,
        };

        // Get or create user set for this token
        if (!usersByToken.has(token)) {
          usersByToken.set(token, new Set<number>());
        }
        usersByToken.get(token)!.add(post.userId);

        existing.posts += 1;
        existing.views += post.viewCount ?? 0;
        existing.likes += post.likeCount ?? 0;
        existing.reposts += post.repostCount ?? 0;
        existing.replies += post.replyCount ?? 0;

        existing.avgBondingCurveProgress += post.bondingCurveProgress ?? 0;
        if (post.bondingCurveProgress === 100) {
          existing.graduatedPostCount += 1;
        }
        if (post.hasImage) {
          existing.postsWithImages += 1;
        }
        existing.totalPriceFluctuation += Math.abs(post.priceFluctuationRange ?? 0);
        if (post.userIsPreOrdered) {
          existing.preOrderedUserPosts += 1;
        }

        const postTime = post.postCreatedAt;
        if (postTime > existing.latestPostTime) {
          existing.latestPostTime = postTime;
        }

        metrics.set(token, existing);
      }
    }

    // Convert to AggregatedMetrics with correct uniqueUserCount
    const aggregated: AggregatedMetrics[] = [];
    for (const [token, m] of metrics.entries()) {
      const uniqueUserCount = usersByToken.get(token)?.size ?? 0;
      aggregated.push({
        tokenSymbol: m.tokenSymbol.toUpperCase(), // Normalize to uppercase for consistent matching
        posts: m.posts,
        views: m.views,
        likes: m.likes,
        reposts: m.reposts,
        replies: m.replies,
        uniqueUserCount,
        latestPostTime: m.latestPostTime,
        avgBondingCurveProgress: m.posts > 0 ? m.avgBondingCurveProgress / m.posts : 0,
        graduatedPostRatio: m.posts > 0 ? m.graduatedPostCount / m.posts : 0,
        imagePostRatio: m.posts > 0 ? m.postsWithImages / m.posts : 0,
        avgPriceFluctuation: m.posts > 0 ? m.totalPriceFluctuation / m.posts : 0,
        preOrderedUserRatio: m.posts > 0 ? m.preOrderedUserPosts / m.posts : 0,
      });
    }

    console.log(`[MemexCollector] DB aggregation complete: ${aggregated.length} tokens`);
    return aggregated;
  }

  /**
   * Convert TokenMetrics to AggregatedMetrics (serializable)
   * Includes enhanced metrics for improved scoring
   */
  toAggregatedMetrics(metrics: Map<string, TokenMetrics>): AggregatedMetrics[] {
    return Array.from(metrics.values()).map((m) => ({
      tokenSymbol: m.tokenSymbol.toUpperCase(), // Normalize to uppercase for consistent matching
      posts: m.posts,
      views: m.views,
      likes: m.likes,
      reposts: m.reposts,
      replies: m.replies,
      uniqueUserCount: m.uniqueUsers.size,
      latestPostTime: m.latestPostTime,
      // Enhanced metrics (computed ratios)
      avgBondingCurveProgress: m.posts > 0 ? m.avgBondingCurveProgress / m.posts : 0,
      graduatedPostRatio: m.posts > 0 ? m.graduatedPostCount / m.posts : 0,
      imagePostRatio: m.posts > 0 ? m.postsWithImages / m.posts : 0,
      avgPriceFluctuation: m.posts > 0 ? m.totalPriceFluctuation / m.posts : 0,
      preOrderedUserRatio: m.posts > 0 ? m.preOrderedUserPosts / m.posts : 0,
    }));
  }

  /**
   * Save processed posts to database for auditing (optimized with concurrency)
   * Now includes enhanced metrics for analysis
   */
  async saveProcessedPosts(posts: MemexPost[]): Promise<void> {
    if (posts.length === 0) return;

    const CONCURRENT_SAVES = parseInt(process.env.DB_CONCURRENT_SAVES || '10');
    let savedCount = 0;
    let errorCount = 0;

    // Process posts in concurrent batches
    for (let i = 0; i < posts.length; i += CONCURRENT_SAVES) {
      const batch = posts.slice(i, i + CONCURRENT_SAVES);

      // Process batch concurrently
      const results = await Promise.allSettled(
        batch.map(async (post) => {
          const extracted = this.extractTokensEnhanced(post);

          await db
            .insert(schema.memexPosts)
            .values({
              memexPostId: post.id,
              userId: post.user.id,
              userName: post.user.userName,
              userIsPreOrdered: post.user.isPreOrdered,
              contentType: post.contentType,
              viewCount: post.viewCount,
              likeCount: post.likeCount,
              repostCount: post.repostCount,
              replyCount: post.replyCount,
              // Enhanced token extraction
              mentionedTokens: JSON.stringify(extracted.mentions),
              extractedTickers: JSON.stringify(extracted.tickers),
              extractedHashtags: JSON.stringify(extracted.hashtags),
              // Token-related metrics
              bondingCurveProgress: post.bondingCurveProgress,
              priceFluctuationRange: post.priceFluctuationRange,
              tokenCexListed: post.tokenCexListed,
              // Content analysis
              hasImage: post.imageSrc && post.imageSrc.length > 0,
              postCreatedAt: new Date(post.createdAt),
            })
            .onConflictDoUpdate({
              target: schema.memexPosts.memexPostId,
              set: {
                viewCount: post.viewCount,
                likeCount: post.likeCount,
                repostCount: post.repostCount,
                replyCount: post.replyCount,
                bondingCurveProgress: post.bondingCurveProgress,
                priceFluctuationRange: post.priceFluctuationRange,
                processedAt: new Date(),
              },
            });
        })
      );

      // Count results
      for (const result of results) {
        if (result.status === 'fulfilled') {
          savedCount++;
        } else {
          const error = result.reason;
          // Ignore duplicate errors (onConflictDoUpdate handles this)
          if (!(error instanceof Error && error.message.includes('duplicate'))) {
            errorCount++;
            if (errorCount <= 5) {
              // Only log first 5 errors to avoid spam
              console.error('[MemexCollector] Failed to save post:', error);
            }
          } else {
            savedCount++; // Count duplicates as successful updates
          }
        }
      }
    }

    if (posts.length > 0) {
      console.log(`[MemexCollector] Database save: ${savedCount} posts saved/updated, ${errorCount} errors (total: ${posts.length} posts)`);
    }
  }

  /**
   * Fetch latest posts from API and save to DB
   * Uses incremental collection to ensure no posts are missed
   * Returns count of new posts saved
   */
  async collectLatestPosts(): Promise<number> {
    console.log('[MemexCollector] Collecting posts incrementally...');

    // Use incremental collection to handle burst of posts between cron intervals
    const posts = await this.collectIncrementalPosts();

    if (posts.length === 0) {
      console.log('[MemexCollector] No new posts to process');
      return 0;
    }

    // Save to database (inserts new, updates existing with latest metrics)
    await this.saveProcessedPosts(posts);

    return posts.length;
  }

  /**
   * Fetch and aggregate - collects new posts and returns DB-based aggregation
   * This ensures we always use the latest metrics from DB
   */
  async collectAndAggregate(): Promise<AggregatedMetrics[]> {
    // Step 1: Fetch and save new posts to DB
    await this.collectLatestPosts();

    // Step 2: Aggregate from DB (uses latest metrics including updates)
    const aggregated = await this.aggregateFromDB();

    if (aggregated.length > 0) {
      const totalViews = aggregated.reduce((sum, m) => sum + m.views, 0);
      const totalLikes = aggregated.reduce((sum, m) => sum + m.likes, 0);
      const totalReposts = aggregated.reduce((sum, m) => sum + m.reposts, 0);

      console.log(
        `[MemexCollector] Collection complete: ${aggregated.length} tokens (${totalViews} views, ${totalLikes} likes, ${totalReposts} reposts)`
      );
    }

    return aggregated;
  }

  /**
   * Refresh metrics for recent posts (last N pages from API)
   * This updates views/likes for existing posts in DB
   * Should be called periodically (e.g., every 5-10 minutes)
   */
  async refreshRecentPostsMetrics(pages: number = 10): Promise<{ updated: number; total: number }> {
    console.log(`[MemexCollector] Refreshing metrics for recent ${pages} pages...`);

    const RATE_LIMIT_DELAY = 100; // ms between requests
    let cursor: number | null = null;
    let totalPosts = 0;
    let updatedPosts = 0;
    const postsToUpdate: MemexPost[] = [];

    // Fetch N pages of recent posts (these include posts we may already have)
    for (let i = 0; i < pages; i++) {
      try {
        const data = await this.fetchPostsWithCursor(cursor ?? undefined);

        if (!data.contents || data.contents.length === 0) {
          break;
        }

        postsToUpdate.push(...data.contents);
        totalPosts += data.contents.length;

        cursor = data.nextCursor;
        if (!cursor) break;

        // Rate limiting
        if (i < pages - 1) {
          await new Promise((r) => setTimeout(r, RATE_LIMIT_DELAY));
        }
      } catch (error) {
        console.error(`[MemexCollector] Refresh error at page ${i + 1}:`, error);
        break;
      }
    }

    // Save all posts (onConflictDoUpdate will update existing posts' metrics)
    if (postsToUpdate.length > 0) {
      await this.saveProcessedPosts(postsToUpdate);
      updatedPosts = postsToUpdate.length;
    }

    console.log(`[MemexCollector] Metrics refresh complete: ${updatedPosts} posts updated from ${pages} pages`);

    return { updated: updatedPosts, total: totalPosts };
  }

  /**
   * Initial backfill - fetch historical data on server startup
   * Fetches multiple pages to build initial dataset with optimized concurrent processing
   * Only processes posts from the last 7 days
   */
  async initialBackfill(pages: number = 50): Promise<{
    totalPosts: number;
    uniqueTokens: number;
  }> {
    console.log(`[MemexCollector] Starting initial backfill (${pages} pages, last 7 days only, optimized)...`);

    // Calculate 7 days ago timestamp
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const sevenDaysAgoTimestamp = sevenDaysAgo.getTime();

    // Configuration
    const RATE_LIMIT_DELAY = parseInt(process.env.BACKFILL_RATE_LIMIT_DELAY || '50'); // Reduced from 200ms
    const DB_BATCH_SIZE = 100; // Batch size for database operations

    let cursor: number | null = null;
    let totalPosts = 0;
    let skippedOldPosts = 0;
    const allMetrics = new Map<string, TokenMetrics>();
    let shouldStop = false;
    const postsToSave: MemexPost[] = []; // Batch posts for database

    // Helper to aggregate metrics from posts
    const aggregatePostsMetrics = (posts: MemexPost[]): void => {
      for (const post of posts) {
        const tokens = this.extractMentionedTokens(post);

        for (const token of tokens) {
          const existing = allMetrics.get(token) || {
            tokenSymbol: token,
            posts: 0,
            views: 0,
            likes: 0,
            reposts: 0,
            replies: 0,
            uniqueUsers: new Set<number>(),
            latestPostTime: new Date(0),
            avgBondingCurveProgress: 0,
            graduatedPostCount: 0,
            postsWithImages: 0,
            totalPriceFluctuation: 0,
            preOrderedUserPosts: 0,
          };

          existing.posts += 1;
          existing.views += post.viewCount;
          existing.likes += post.likeCount;
          existing.reposts += post.repostCount;
          existing.replies += post.replyCount;
          existing.uniqueUsers.add(post.user.id);
          existing.avgBondingCurveProgress += post.bondingCurveProgress;
          if (post.bondingCurveProgress === 100) existing.graduatedPostCount += 1;
          if (post.imageSrc?.length > 0) existing.postsWithImages += 1;
          existing.totalPriceFluctuation += Math.abs(post.priceFluctuationRange);
          if (post.user.isPreOrdered) existing.preOrderedUserPosts += 1;

          const postTime = new Date(post.createdAt);
          if (postTime > existing.latestPostTime) {
            existing.latestPostTime = postTime;
          }

          allMetrics.set(token, existing);
        }
      }
    };

    for (let i = 0; i < pages && !shouldStop; i++) {
      try {
        const startTime = Date.now();
        const data = await this.fetchPostsWithCursor(cursor ?? undefined);

        if (!data.contents || data.contents.length === 0) {
          console.log(`[MemexCollector] No more posts at page ${i + 1}`);
          break;
        }

        // Filter posts from last 7 days only
        const recentPosts = data.contents.filter((post) => {
          const postTime = new Date(post.createdAt).getTime();
          return postTime >= sevenDaysAgoTimestamp;
        });

        const oldPostsCount = data.contents.length - recentPosts.length;
        skippedOldPosts += oldPostsCount;

        // If all posts in this page are older than 7 days, stop backfilling
        if (recentPosts.length === 0) {
          console.log(`[MemexCollector] All posts at page ${i + 1} are older than 7 days, stopping backfill`);
          shouldStop = true;
          break;
        }

        // Aggregate metrics immediately (in-memory, fast)
        aggregatePostsMetrics(recentPosts);

        // Add to batch for database save
        postsToSave.push(...recentPosts);
        totalPosts += recentPosts.length;

        // Save to database in batches (non-blocking for speed)
        if (postsToSave.length >= DB_BATCH_SIZE) {
          const batchToSave = postsToSave.splice(0, DB_BATCH_SIZE);
          // Save asynchronously without blocking main loop
          // Errors are logged but don't stop the backfill process
          this.saveProcessedPosts(batchToSave).catch((err) => {
            console.error('[MemexCollector] Batch save error:', err);
          });
        }

        cursor = data.nextCursor;
        if (!cursor) break;

        const fetchTime = Date.now() - startTime;

        // Progress log every 10 pages or on last page
        if ((i + 1) % 10 === 0 || shouldStop || i === pages - 1) {
          const totalViews = Array.from(allMetrics.values()).reduce((sum, m) => sum + m.views, 0);
          const totalLikes = Array.from(allMetrics.values()).reduce((sum, m) => sum + m.likes, 0);
          const tokensExtracted = recentPosts.reduce((sum, p) => sum + this.extractMentionedTokens(p).length, 0);
          console.log(
            `[MemexCollector] Backfill progress: page ${
              i + 1
            }/${pages} (${fetchTime}ms), ${totalPosts} posts processed (${skippedOldPosts} old skipped), ${tokensExtracted} tokens this page, ${
              allMetrics.size
            } unique tokens total (${totalViews} views, ${totalLikes} likes)`
          );
        }

        // Reduced rate limiting
        if (i < pages - 1 && !shouldStop) {
          await new Promise((r) => setTimeout(r, RATE_LIMIT_DELAY));
        }
      } catch (error) {
        console.error(`[MemexCollector] Backfill error at page ${i + 1}:`, error);
        break;
      }
    }

    // Save remaining posts
    if (postsToSave.length > 0) {
      await this.saveProcessedPosts(postsToSave);
    }

    console.log(
      `[MemexCollector] Backfill complete: ${totalPosts} posts (${skippedOldPosts} old posts skipped), ${allMetrics.size} unique tokens`
    );

    return {
      totalPosts,
      uniqueTokens: allMetrics.size,
    };
  }

  /**
   * Get last cursor for pagination
   */
  getLastCursor(): number | null {
    return this.lastCursor;
  }

  /**
   * Get the last saved post ID from DB
   * Used for incremental data collection
   */
  async getLastSavedPostId(): Promise<number | null> {
    const latest = await db.query.memexPosts.findFirst({
      orderBy: [desc(schema.memexPosts.memexPostId)],
    });
    return latest?.memexPostId ?? null;
  }

  /**
   * Collect posts incrementally from last saved ID
   * Handles pagination to fetch all posts since last saved
   * This ensures no posts are missed between cron intervals
   */
  async collectIncrementalPosts(): Promise<MemexPost[]> {
    const lastSavedId = await this.getLastSavedPostId();
    console.log(`[MemexCollector] Incremental collection from postId > ${lastSavedId ?? 'none'}`);

    const allNewPosts: MemexPost[] = [];
    let cursor: number | null = null;
    let pageCount = 0;
    const MAX_PAGES = 20; // Safety limit to prevent infinite loops
    const RATE_LIMIT_DELAY = 100; // ms between requests

    while (pageCount < MAX_PAGES) {
      try {
        const data = await this.fetchPostsWithCursor(cursor ?? undefined);
        pageCount++;

        if (!data.contents || data.contents.length === 0) {
          console.log(`[MemexCollector] No more posts at page ${pageCount}`);
          break;
        }

        // Filter to only new posts (ID > lastSavedId)
        const newPosts = lastSavedId ? data.contents.filter((p) => p.id > lastSavedId) : data.contents;

        allNewPosts.push(...newPosts);

        // If we found posts older than lastSavedId, we've caught up
        if (lastSavedId && data.contents.some((p) => p.id <= lastSavedId)) {
          console.log(`[MemexCollector] Reached last saved post at page ${pageCount}`);
          break;
        }

        // If no cursor or all posts are new, continue to next page
        cursor = data.nextCursor;
        if (!cursor) {
          console.log(`[MemexCollector] No more pages (page ${pageCount})`);
          break;
        }

        // Rate limiting
        await new Promise((r) => setTimeout(r, RATE_LIMIT_DELAY));
      } catch (error) {
        console.error(`[MemexCollector] Error at page ${pageCount}:`, error);
        break;
      }
    }

    console.log(`[MemexCollector] Incremental collection: ${allNewPosts.length} new posts from ${pageCount} pages`);
    return allNewPosts;
  }

  /**
   * Get post statistics by time period for a specific token
   * Used for individual token lookup
   */
  async getTokenStats(tokenSymbol: string): Promise<{
    posts: { '1h': number; '1d': number; '7d': number };
    views: { '1h': number; '1d': number; '7d': number };
    likes: { '1h': number; '1d': number; '7d': number };
  }> {
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    // Fetch all posts in the last 7 days
    const posts = await db.query.memexPosts.findMany({
      where: gte(schema.memexPosts.postCreatedAt, sevenDaysAgo),
    });

    const result = {
      posts: { '1h': 0, '1d': 0, '7d': 0 },
      views: { '1h': 0, '1d': 0, '7d': 0 },
      likes: { '1h': 0, '1d': 0, '7d': 0 },
    };

    for (const post of posts) {
      // Check if this post mentions the token
      const mentions: string[] = post.mentionedTokens ? JSON.parse(post.mentionedTokens) : [];
      const tickers: string[] = post.extractedTickers ? JSON.parse(post.extractedTickers) : [];
      const hashtags: string[] = post.extractedHashtags ? JSON.parse(post.extractedHashtags) : [];
      const allTokens = [...mentions, ...tickers, ...hashtags].map((t) => t.toUpperCase());

      if (!allTokens.includes(tokenSymbol.toUpperCase())) {
        continue;
      }

      const viewCount = post.viewCount ?? 0;
      const likeCount = post.likeCount ?? 0;

      // 7d
      result.posts['7d']++;
      result.views['7d'] += viewCount;
      result.likes['7d'] += likeCount;

      // 1d
      if (post.postCreatedAt >= oneDayAgo) {
        result.posts['1d']++;
        result.views['1d'] += viewCount;
        result.likes['1d'] += likeCount;
      }

      // 1h
      if (post.postCreatedAt >= oneHourAgo) {
        result.posts['1h']++;
        result.views['1h'] += viewCount;
        result.likes['1h'] += likeCount;
      }
    }

    return result;
  }

  /**
   * Get all token stats in batch (optimized for leaderboard)
   * Returns stats broken down by time period (1h, 1d, 7d)
   */
  async getAllTokenStats(): Promise<
    Map<
      string,
      {
        posts: { '1h': number; '1d': number; '7d': number };
        views: { '1h': number; '1d': number; '7d': number };
        likes: { '1h': number; '1d': number; '7d': number };
      }
    >
  > {
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    // Fetch all posts in the last 7 days
    const posts = await db.query.memexPosts.findMany({
      where: gte(schema.memexPosts.postCreatedAt, sevenDaysAgo),
    });

    const statsMap = new Map<
      string,
      {
        posts: { '1h': number; '1d': number; '7d': number };
        views: { '1h': number; '1d': number; '7d': number };
        likes: { '1h': number; '1d': number; '7d': number };
      }
    >();

    for (const post of posts) {
      // Parse all tokens from this post
      const mentions: string[] = post.mentionedTokens ? JSON.parse(post.mentionedTokens) : [];
      const tickers: string[] = post.extractedTickers ? JSON.parse(post.extractedTickers) : [];
      const hashtags: string[] = post.extractedHashtags ? JSON.parse(post.extractedHashtags) : [];
      const allTokens = [...new Set([...mentions, ...tickers, ...hashtags])].map((t) => t.toUpperCase());

      const viewCount = post.viewCount ?? 0;
      const likeCount = post.likeCount ?? 0;
      const isWithin1h = post.postCreatedAt >= oneHourAgo;
      const isWithin1d = post.postCreatedAt >= oneDayAgo;

      for (const token of allTokens) {
        const existing = statsMap.get(token) || {
          posts: { '1h': 0, '1d': 0, '7d': 0 },
          views: { '1h': 0, '1d': 0, '7d': 0 },
          likes: { '1h': 0, '1d': 0, '7d': 0 },
        };

        // 7d (always, since we only fetch 7d data)
        existing.posts['7d']++;
        existing.views['7d'] += viewCount;
        existing.likes['7d'] += likeCount;

        // 1d
        if (isWithin1d) {
          existing.posts['1d']++;
          existing.views['1d'] += viewCount;
          existing.likes['1d'] += likeCount;
        }

        // 1h
        if (isWithin1h) {
          existing.posts['1h']++;
          existing.views['1h'] += viewCount;
          existing.likes['1h'] += likeCount;
        }

        statsMap.set(token, existing);
      }
    }

    return statsMap;
  }
  /**
   * Fetch leaderboard data from Memex API
   * This includes token images and additional market data
   */
  async fetchLeaderboard(options?: {
    sortBy?: 'tokenPriceNow' | 'bondingCurveProgress' | 'volume' | 'holder';
    order?: 'asc' | 'desc';
    limit?: number;
  }): Promise<MemexLeaderboardResponse | null> {
    const { sortBy = 'tokenPriceNow', order = 'desc', limit = 200 } = options || {};

    const url = `${MEMEX_LEADERBOARD_API}?sortBy=${sortBy}&order=${order}&limit=${limit}`;

    try {
      const response = await fetch(url, {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'ViralScoreBot/1.0',
        },
      });

      if (!response.ok) {
        throw new Error(`Memex Leaderboard API error: ${response.status}`);
      }

      return (await response.json()) as MemexLeaderboardResponse;
    } catch (error) {
      console.error('[MemexCollector] Failed to fetch leaderboard:', error);
      return null;
    }
  }

  /**
   * Refresh token image cache from leaderboard API
   * Should be called periodically to keep images up-to-date
   *
   * Note: We store multiple keys for each token to handle different naming conventions:
   * - tokenSymbol (e.g., "MXT")
   * - tokenName (e.g., "MEMETERN")
   * - userName (e.g., "MEMETERN")
   * This allows matching regardless of how the token is referenced in posts.
   */
  async refreshTokenImageCache(): Promise<number> {
    console.log('[MemexCollector] Refreshing token image cache...');

    const leaderboard = await this.fetchLeaderboard({ limit: 500 });

    if (!leaderboard || !leaderboard.data) {
      console.error('[MemexCollector] Failed to refresh token image cache');
      return 0;
    }

    let newCount = 0;
    let updatedCount = 0;

    for (const token of leaderboard.data) {
      const symbol = token.tokenSymbol.toUpperCase();
      const tokenName = token.tokenName.toUpperCase();
      const userName = token.user.userName.toUpperCase();

      const imageInfo: TokenImageInfo = {
        tokenSymbol: symbol,
        tokenName: token.tokenName,
        tokenAddress: token.tokenAddress,
        imageSrc: token.user.tokenImageUrl,
        bondingCurveProgress: token.bondingCurveProgress,
        tokenPriceUsd: token.tokenUsdPriceNow,
        updatedAt: new Date(),
      };

      const existing = this.tokenImageCache.get(symbol);
      if (!existing) {
        newCount++;
      } else if (existing.imageSrc !== imageInfo.imageSrc) {
        updatedCount++;
      }

      // Store with multiple keys for better matching
      // Primary key: tokenSymbol (e.g., "MXT")
      this.tokenImageCache.set(symbol, imageInfo);

      // Secondary key: tokenName (e.g., "MEMETERN") - if different from symbol
      if (tokenName !== symbol) {
        this.tokenImageCache.set(tokenName, imageInfo);
      }

      // Tertiary key: userName (e.g., "MEMETERN") - if different from both
      if (userName !== symbol && userName !== tokenName) {
        this.tokenImageCache.set(userName, imageInfo);
      }
    }

    this.tokenImageCacheUpdatedAt = new Date();

    console.log(
      `[MemexCollector] Token image cache refreshed: ${leaderboard.data.length} tokens (${newCount} new, ${updatedCount} updated), ${this.tokenImageCache.size} cache entries`
    );

    return leaderboard.data.length;
  }

  /**
   * Get token image info from cache
   */
  getTokenImageInfo(tokenSymbol: string): TokenImageInfo | undefined {
    return this.tokenImageCache.get(tokenSymbol.toUpperCase());
  }

  /**
   * Get all token image info from cache
   */
  getAllTokenImageInfo(): Map<string, TokenImageInfo> {
    return this.tokenImageCache;
  }

  /**
   * Get token image cache status
   */
  getTokenImageCacheStatus(): { count: number; updatedAt: Date | null } {
    return {
      count: this.tokenImageCache.size,
      updatedAt: this.tokenImageCacheUpdatedAt,
    };
  }

  /**
   * Get image URL for a token symbol
   */
  getTokenImageSrc(tokenSymbol: string): string | null {
    const info = this.tokenImageCache.get(tokenSymbol.toUpperCase());
    return info?.imageSrc ?? null;
  }

  /**
   * Batch get image URLs for multiple token symbols
   */
  getTokenImageSrcBatch(tokenSymbols: string[]): Map<string, string | null> {
    const result = new Map<string, string | null>();
    for (const symbol of tokenSymbols) {
      result.set(symbol.toUpperCase(), this.getTokenImageSrc(symbol));
    }
    return result;
  }
}

// Singleton instance
export const memexCollector = new MemexCollector();
