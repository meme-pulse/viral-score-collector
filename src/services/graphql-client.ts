import type { Address } from "viem";

/**
 * GraphQL Client for Envio Indexer
 * Fetches LBPair data including TVL for viral score ranking
 */

const GRAPHQL_ENDPOINT =
  process.env.GRAPHQL_ENDPOINT || "https://indexer.dev.hyperindex.xyz/e3c58e2/v1/graphql";

const CHAIN_ID = parseInt(process.env.CHAIN_ID || "43522"); // Memecore Testnet

/**
 * LBPair data from GraphQL
 */
export interface LBPairData {
  id: string;
  address: string;
  binStep: string;
  totalValueLockedUSD: string;
  tokenX: {
    id: string;
    address: string;
    symbol: string;
    name: string;
  };
  tokenY: {
    id: string;
    address: string;
    symbol: string;
    name: string;
  };
}

/**
 * Token with TVL-sorted binSteps
 */
export interface TokenPoolData {
  tokenAddress: Address;
  tokenSymbol: string;
  tokenName: string; // Full token name for alternative matching
  quoteTokenAddress: Address;
  // binSteps sorted by TVL (highest first)
  pools: Array<{
    binStep: number;
    tvlUSD: number;
    pairAddress: Address;
  }>;
  // Total TVL across all pools
  totalTvlUSD: number;
}

/**
 * GraphQL query to fetch all LBPairs with TVL
 */
const GET_LB_PAIRS_QUERY = `
  query GetLBPairs($chainId: Int!) {
    LBPair(where: { chainId: { _eq: $chainId } }, order_by: { totalValueLockedUSD: desc }) {
      id
      address
      binStep
      totalValueLockedUSD
      tokenX {
        id
        address
        symbol
        name
      }
      tokenY {
        id
        address
        symbol
        name
      }
    }
  }
`;

/**
 * GraphQL query to fetch pairs for a specific token
 */
const GET_TOKEN_PAIRS_QUERY = `
  query GetTokenPairs($chainId: Int!, $tokenAddress: String!) {
    LBPair(
      where: {
        chainId: { _eq: $chainId }
        _or: [
          { tokenX: { address: { _eq: $tokenAddress } } }
          { tokenY: { address: { _eq: $tokenAddress } } }
        ]
      }
      order_by: { totalValueLockedUSD: desc }
    ) {
      id
      address
      binStep
      totalValueLockedUSD
      tokenX {
        id
        address
        symbol
        name
      }
      tokenY {
        id
        address
        symbol
        name
      }
    }
  }
`;

/**
 * Execute GraphQL query
 */
async function executeQuery<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const response = await fetch(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`GraphQL request failed: ${response.status} ${response.statusText}`);
  }

  const result = await response.json();

  if (result.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(result.errors)}`);
  }

  return result.data;
}

/**
 * GraphQL Client for fetching pool/TVL data
 */
export class GraphQLClient {
  private quoteTokenAddress: Address;

  constructor(quoteTokenAddress?: Address) {
    this.quoteTokenAddress = (
      quoteTokenAddress ||
      process.env.QUOTE_TOKEN_ADDRESS ||
      "0x653e645e3d81a72e71328Bc01A04002945E3ef7A"
    ).toLowerCase() as Address;

    console.log(`[GraphQL] Initialized with endpoint: ${GRAPHQL_ENDPOINT}`);
    console.log(`[GraphQL] Quote token: ${this.quoteTokenAddress}`);
  }

  /**
   * Fetch all LBPairs from the indexer
   */
  async fetchAllPairs(): Promise<LBPairData[]> {
    const data = await executeQuery<{ LBPair: LBPairData[] }>(GET_LB_PAIRS_QUERY, {
      chainId: CHAIN_ID,
    });

    console.log(`[GraphQL] Fetched ${data.LBPair.length} LBPairs`);
    return data.LBPair;
  }

  /**
   * Get meme tokens with their pools sorted by TVL
   * Filters for pairs with quote token (WNATIVE) and groups by meme token
   */
  async getMemeTokensWithPools(): Promise<TokenPoolData[]> {
    const pairs = await this.fetchAllPairs();

    // Group by meme token (non-quote token)
    const tokenMap = new Map<string, TokenPoolData>();

    for (const pair of pairs) {
      const tokenXAddr = pair.tokenX.address.toLowerCase();
      const tokenYAddr = pair.tokenY.address.toLowerCase();
      const tvl = parseFloat(pair.totalValueLockedUSD) || 0;
      const binStep = parseInt(pair.binStep);

      // Skip pairs with zero TVL
      if (tvl <= 0) continue;

      // Determine which is the meme token (not quote token)
      let memeToken: typeof pair.tokenX;
      let quoteToken: typeof pair.tokenY;

      if (tokenXAddr === this.quoteTokenAddress) {
        memeToken = pair.tokenY;
        quoteToken = pair.tokenX;
      } else if (tokenYAddr === this.quoteTokenAddress) {
        memeToken = pair.tokenX;
        quoteToken = pair.tokenY;
      } else {
        // Neither token is quote token - skip this pair
        continue;
      }

      const memeAddr = memeToken.address.toLowerCase();
      const existing = tokenMap.get(memeAddr);

      // Normalize all addresses to lowercase for consistency
      const normalizedTokenAddress = memeToken.address.toLowerCase() as Address;
      const normalizedQuoteAddress = quoteToken.address.toLowerCase() as Address;
      const normalizedPairAddress = pair.address.toLowerCase() as Address;

      if (existing) {
        existing.pools.push({
          binStep,
          tvlUSD: tvl,
          pairAddress: normalizedPairAddress,
        });
        existing.totalTvlUSD += tvl;
      } else {
        tokenMap.set(memeAddr, {
          tokenAddress: normalizedTokenAddress,
          tokenSymbol: memeToken.symbol,
          tokenName: memeToken.name, // Store token name for alternative matching
          quoteTokenAddress: normalizedQuoteAddress,
          pools: [
            {
              binStep,
              tvlUSD: tvl,
              pairAddress: normalizedPairAddress,
            },
          ],
          totalTvlUSD: tvl,
        });
      }
    }

    // Sort pools within each token by TVL (highest first)
    for (const token of tokenMap.values()) {
      token.pools.sort((a, b) => b.tvlUSD - a.tvlUSD);
    }

    // Convert to array and sort by total TVL
    const result = Array.from(tokenMap.values()).sort((a, b) => b.totalTvlUSD - a.totalTvlUSD);

    console.log(`[GraphQL] Found ${result.length} meme tokens with quote token pairs`);
    return result;
  }

  /**
   * Get top binSteps for a specific token by TVL
   */
  async getTopBinStepsForToken(
    tokenAddress: Address,
    limit: number = 3
  ): Promise<Array<{ binStep: number; tvlUSD: number }>> {
    const tokens = await this.getMemeTokensWithPools();
    const token = tokens.find((t) => t.tokenAddress.toLowerCase() === tokenAddress.toLowerCase());

    if (!token) {
      return [];
    }

    return token.pools.slice(0, limit).map((p) => ({
      binStep: p.binStep,
      tvlUSD: p.tvlUSD,
    }));
  }

  /**
   * Get token symbol to address mapping
   */
  async getTokenAddressMap(): Promise<Map<string, Address>> {
    const pairs = await this.fetchAllPairs();
    const map = new Map<string, Address>();

    for (const pair of pairs) {
      // Normalize addresses to lowercase for consistency
      map.set(pair.tokenX.symbol.toUpperCase(), pair.tokenX.address.toLowerCase() as Address);
      map.set(pair.tokenY.symbol.toUpperCase(), pair.tokenY.address.toLowerCase() as Address);
    }

    return map;
  }
}

// Singleton instance
export const graphqlClient = new GraphQLClient();

