/**
 * Token Symbol Blacklist
 *
 * Tokens in this list will be excluded from:
 * - Leaderboard rankings
 * - Score calculations (optional)
 *
 * Add symbols that are commonly misextracted or are not actual tokens.
 * All symbols are case-insensitive (will be converted to uppercase).
 */

export const TOKEN_BLACKLIST: Set<string> = new Set([
  'M', // Platform currency, not a meme token
  'MEMEX', // Platform name, not a meme token
]);

/**
 * Check if a token symbol is blacklisted
 */
export function isBlacklisted(symbol: string): boolean {
  return TOKEN_BLACKLIST.has(symbol.toUpperCase());
}

/**
 * Filter out blacklisted tokens from an array
 */
export function filterBlacklisted<T extends { tokenSymbol: string }>(tokens: T[]): T[] {
  return tokens.filter((t) => !isBlacklisted(t.tokenSymbol));
}

/**
 * Filter out blacklisted tokens from a Map
 */
export function filterBlacklistedMap<V>(tokenMap: Map<string, V>): Map<string, V> {
  const filtered = new Map<string, V>();
  for (const [symbol, value] of tokenMap) {
    if (!isBlacklisted(symbol)) {
      filtered.set(symbol, value);
    }
  }
  return filtered;
}
