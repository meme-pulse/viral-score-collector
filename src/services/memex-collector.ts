import type { MemexApiResponse, MemexPost, TokenMetrics, AggregatedMetrics, ExtractedTokens } from '../types/memex';
import { db, schema } from '../db/client';
import { eq } from 'drizzle-orm';

const MEMEX_API_BASE = process.env.MEMEX_API_BASE || 'https://app.memex.xyz/api/service/public';

/**
 * Memex Data Collector
 * Fetches and processes social media data from Memex API
 */
export class MemexCollector {
  private lastCursor: number | null = null;
  private processedPostIds: Set<number> = new Set();

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
   * Aggregate metrics by token with enhanced data
   * Based on 50-page analysis:
   * - Graduated tokens (100% bonding) have 2.25x higher engagement
   * - Posts with images have 1.28x higher engagement
   */
  aggregateByToken(posts: MemexPost[]): Map<string, TokenMetrics> {
    const metrics = new Map<string, TokenMetrics>();
    let processedCount = 0;
    let skippedCount = 0;
    let totalTokensExtracted = 0;

    for (const post of posts) {
      // Skip already processed posts
      if (this.processedPostIds.has(post.id)) {
        skippedCount++;
        continue;
      }

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
          // Enhanced metrics
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

        // Enhanced metrics aggregation
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

      this.processedPostIds.add(post.id);
      processedCount++;
    }

    console.log(
      `[MemexCollector] Aggregation: ${processedCount} posts processed, ${skippedCount} skipped, ${totalTokensExtracted} tokens extracted, ${metrics.size} unique tokens found`
    );

    return metrics;
  }

  /**
   * Convert TokenMetrics to AggregatedMetrics (serializable)
   * Includes enhanced metrics for improved scoring
   */
  toAggregatedMetrics(metrics: Map<string, TokenMetrics>): AggregatedMetrics[] {
    return Array.from(metrics.values()).map((m) => ({
      tokenSymbol: m.tokenSymbol,
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
   * Fetch and process all recent posts
   */
  async collectAndAggregate(): Promise<AggregatedMetrics[]> {
    console.log('[MemexCollector] Fetching latest posts...');

    const posts = await this.fetchLatestPosts();
    console.log(`[MemexCollector] Fetched ${posts.length} posts from API`);

    if (posts.length === 0) {
      console.log('[MemexCollector] No posts to process');
      return [];
    }

    // Save to database for auditing
    await this.saveProcessedPosts(posts);

    // Aggregate metrics by token
    const metrics = this.aggregateByToken(posts);
    const aggregated = this.toAggregatedMetrics(metrics);

    // Calculate total engagement metrics
    const totalViews = Array.from(metrics.values()).reduce((sum, m) => sum + m.views, 0);
    const totalLikes = Array.from(metrics.values()).reduce((sum, m) => sum + m.likes, 0);
    const totalReposts = Array.from(metrics.values()).reduce((sum, m) => sum + m.reposts, 0);

    console.log(
      `[MemexCollector] Collection complete: ${aggregated.length} tokens aggregated (${totalViews} views, ${totalLikes} likes, ${totalReposts} reposts)`
    );

    return aggregated;
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
   * Clear processed posts cache (call periodically)
   */
  clearProcessedCache(): void {
    // Keep only last 1000 post IDs
    if (this.processedPostIds.size > 1000) {
      const ids = Array.from(this.processedPostIds);
      this.processedPostIds = new Set(ids.slice(-500));
    }
  }
}

// Singleton instance
export const memexCollector = new MemexCollector();
