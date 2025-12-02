# Viral Score Collector API Documentation

## Base URL
```
http://localhost:3001
```

## Overview

The Viral Score Collector API provides real-time and historical viral scores for tokens and token pairs based on social media engagement metrics from Memex. Scores are calculated using a sophisticated algorithm that considers posts, views, likes, reposts, replies, unique users, and various multipliers.

---

## Table of Contents

- [Health & Status](#health--status)
- [Token Scores](#token-scores)
- [Pair Scores](#pair-scores)
- [Merkle Tree](#merkle-tree)
- [WebSocket](#websocket)
- [Data Models](#data-models)
- [Score Tiers](#score-tiers)

---

## Health & Status

### GET `/`
Root endpoint with basic server information.

**Response:**
```json
{
  "name": "Viral Score Server",
  "version": "1.0.0",
  "status": "running",
  "endpoints": {
    "health": "/health",
    "scores": "/api/score",
    "merkle": "/api/merkle",
    "websocket": "/ws"
  }
}
```

### GET `/health`
Detailed health check with system status.

**Response:**
```json
{
  "status": "healthy",
  "timestamp": "2025-12-02T10:30:00.000Z",
  "database": "connected",
  "scheduler": {
    "scoreCollection": true,
    "merkleCheckpoint": true,
    "cacheCleanup": true,
    "backfillCompleted": true,
    "tokenScoresCount": 42
  },
  "websocket": {
    "connections": 5,
    "subscriptions": 8
  }
}
```

---

## Token Scores

### GET `/api/score/signer`
Get the ECDSA signer address for signature verification.

**Response:**
```json
{
  "signerAddress": "0x1234567890abcdef..."
}
```

---

### GET `/api/score/tokens`
Get all current token scores from memory (real-time).

**Response:**
```json
{
  "count": 42,
  "tokens": [
    {
      "tokenSymbol": "TRUMP",
      "score": 8542,
      "tier": "LEGENDARY"
    },
    {
      "tokenSymbol": "BONK",
      "score": 7234,
      "tier": "VIRAL"
    }
  ]
}
```

---

### GET `/api/score/tokens/leaderboard`
Get top scoring tokens (real-time from memory).

**Query Parameters:**
- `limit` (optional, default: 20, max: 50) - Number of tokens to return

**Example:**
```
GET /api/score/tokens/leaderboard?limit=10
```

**Response:**
```json
{
  "count": 10,
  "leaderboard": [
    {
      "rank": 1,
      "tokenSymbol": "TRUMP",
      "score": 8542,
      "tier": "LEGENDARY"
    },
    {
      "rank": 2,
      "tokenSymbol": "BONK",
      "score": 7234,
      "tier": "VIRAL"
    }
  ]
}
```

---

### GET `/api/score/tokens/:symbol`
Get the latest token score from the database.

**Path Parameters:**
- `symbol` (required) - Token symbol (case insensitive)

**Example:**
```
GET /api/score/tokens/TRUMP
```

**Response:**
```json
{
  "tokenSymbol": "TRUMP",
  "score": 8542,
  "tier": "LEGENDARY",
  "rawPosts": 150,
  "rawViews": 45000,
  "rawLikes": 3200,
  "rawReposts": 450,
  "rawReplies": 280,
  "rawUniqueUsers": 85,
  "avgBondingCurve": 0.95,
  "graduatedRatio": 0.75,
  "imageRatio": 0.65,
  "createdAt": "2025-12-02T10:30:00.000Z"
}
```

**Error Response (404):**
```json
{
  "error": "Score not found for this token",
  "tokenSymbol": "UNKNOWN"
}
```

---

### GET `/api/score/tokens/:symbol/history`
Get historical token scores from the database.

**Path Parameters:**
- `symbol` (required) - Token symbol (case insensitive)

**Query Parameters:**
- `limit` (optional, default: 24, max: 100) - Number of records
- `offset` (optional, default: 0) - Pagination offset

**Example:**
```
GET /api/score/tokens/TRUMP/history?limit=48
```

**Response:**
```json
{
  "tokenSymbol": "TRUMP",
  "count": 48,
  "history": [
    {
      "score": 8542,
      "tier": "LEGENDARY",
      "rawPosts": 150,
      "rawViews": 45000,
      "rawLikes": 3200,
      "rawReposts": 450,
      "rawReplies": 280,
      "rawUniqueUsers": 85,
      "avgBondingCurve": 0.95,
      "graduatedRatio": 0.75,
      "imageRatio": 0.65,
      "createdAt": "2025-12-02T10:30:00.000Z"
    }
  ]
}
```

---

## Pair Scores

### GET `/api/score/pair/:tokenX/:tokenY`
Get the current pair score (unsigned, from memory).

**Path Parameters:**
- `tokenX` (required) - First token symbol
- `tokenY` (required) - Second token symbol

**Example:**
```
GET /api/score/pair/TRUMP/SOL
```

**Response:**
```json
{
  "poolId": "0x1234567890abcdef...",
  "tokenX": "SOL",
  "tokenY": "TRUMP",
  "tokenXScore": 7500,
  "tokenYScore": 8542,
  "pairScore": 8021,
  "tier": "LEGENDARY"
}
```

**Error Response (404):**
```json
{
  "error": "Score not found for one or both tokens",
  "tokenX": "TRUMP",
  "tokenY": "UNKNOWN"
}
```

---

### POST `/api/score/pair/:tokenX/:tokenY/sign`
Sign and store a pair score for on-chain use.

**Path Parameters:**
- `tokenX` (required) - First token symbol
- `tokenY` (required) - Second token symbol

**Example:**
```
POST /api/score/pair/TRUMP/SOL/sign
```

**Response:**
```json
{
  "poolId": "0x1234567890abcdef...",
  "tokenX": "SOL",
  "tokenY": "TRUMP",
  "tokenXScore": 7500,
  "tokenYScore": 8542,
  "pairScore": 8021,
  "tier": "LEGENDARY",
  "signature": "0xabcdef1234567890..."
}
```

**Notes:**
- This endpoint signs the pair score with ECDSA
- The signed score is stored in the database
- Each call generates a new nonce to prevent replay attacks

---

### GET `/api/score/pair/:tokenX/:tokenY/history`
Get historical pair scores from the database.

**Path Parameters:**
- `tokenX` (required) - First token symbol
- `tokenY` (required) - Second token symbol

**Query Parameters:**
- `limit` (optional, default: 24, max: 100) - Number of records
- `offset` (optional, default: 0) - Pagination offset

**Example:**
```
GET /api/score/pair/TRUMP/SOL/history?limit=24
```

**Response:**
```json
{
  "poolId": "0x1234567890abcdef...",
  "tokenX": "SOL",
  "tokenY": "TRUMP",
  "count": 24,
  "history": [
    {
      "tokenXScore": 7500,
      "tokenYScore": 8542,
      "pairScore": 8021,
      "timestamp": 1733138400,
      "nonce": 42,
      "signature": "0xabcdef1234567890...",
      "tier": "LEGENDARY",
      "createdAt": "2025-12-02T10:30:00.000Z"
    }
  ]
}
```

---

### GET `/api/score/pair/id/:poolId`
Get the latest signed score by pool ID.

**Path Parameters:**
- `poolId` (required) - Pool ID (hex string starting with 0x)

**Example:**
```
GET /api/score/pair/id/0x1234567890abcdef...
```

**Response:**
```json
{
  "poolId": "0x1234567890abcdef...",
  "tokenX": "SOL",
  "tokenY": "TRUMP",
  "tokenXScore": 7500,
  "tokenYScore": 8542,
  "pairScore": 8021,
  "timestamp": 1733138400,
  "nonce": 42,
  "signature": "0xabcdef1234567890...",
  "tier": "LEGENDARY",
  "createdAt": "2025-12-02T10:30:00.000Z"
}
```

**Error Response (400):**
```json
{
  "error": "Invalid poolId format"
}
```

**Error Response (404):**
```json
{
  "error": "Score not found for this pool"
}
```

---

### POST `/api/score/pair/register`
Register a new pair pool for tracking.

**Request Body:**
```json
{
  "tokenXSymbol": "TRUMP",
  "tokenYSymbol": "SOL",
  "tokenXAddress": "0x1234...",
  "tokenYAddress": "0x5678..."
}
```

**Required Fields:**
- `tokenXSymbol` (string) - First token symbol
- `tokenYSymbol` (string) - Second token symbol

**Optional Fields:**
- `tokenXAddress` (string) - First token address
- `tokenYAddress` (string) - Second token address

**Response (new registration):**
```json
{
  "message": "Pair pool registered successfully",
  "poolId": "0x1234567890abcdef...",
  "tokenX": "SOL",
  "tokenY": "TRUMP"
}
```

**Response (already exists):**
```json
{
  "message": "Pair pool already registered",
  "poolId": "0x1234567890abcdef...",
  "tokenX": "SOL",
  "tokenY": "TRUMP"
}
```

---

### GET `/api/score/pairs`
Get all registered pair pools.

**Query Parameters:**
- `limit` (optional, default: 50, max: 100) - Number of pairs
- `offset` (optional, default: 0) - Pagination offset

**Example:**
```
GET /api/score/pairs?limit=20
```

**Response:**
```json
{
  "count": 20,
  "pairs": [
    {
      "poolId": "0x1234567890abcdef...",
      "tokenX": "SOL",
      "tokenY": "TRUMP",
      "createdAt": "2025-12-02T10:00:00.000Z"
    }
  ]
}
```

---

## Merkle Tree

### GET `/api/merkle/root`
Get the current Merkle root.

**Response:**
```json
{
  "root": "0xabcdef1234567890...",
  "epoch": 42,
  "poolCount": 156,
  "timestamp": "2025-12-02T10:00:00.000Z"
}
```

**Error Response (404):**
```json
{
  "error": "No merkle checkpoint found"
}
```

---

### GET `/api/merkle/proof/:poolId`
Get Merkle proof for a specific pool.

**Path Parameters:**
- `poolId` (required) - Pool ID (hex string)

**Example:**
```
GET /api/merkle/proof/0x1234567890abcdef...
```

**Response:**
```json
{
  "poolId": "0x1234567890abcdef...",
  "proof": [
    "0xabcd...",
    "0xef01...",
    "0x2345..."
  ],
  "root": "0x6789abcdef...",
  "epoch": 42
}
```

**Error Response (404):**
```json
{
  "error": "No merkle checkpoint found"
}
```

---

### POST `/api/merkle/verify`
Verify a Merkle proof.

**Request Body:**
```json
{
  "poolId": "0x1234567890abcdef...",
  "score": 8021,
  "proof": [
    "0xabcd...",
    "0xef01...",
    "0x2345..."
  ],
  "root": "0x6789abcdef..."
}
```

**Response:**
```json
{
  "valid": true,
  "poolId": "0x1234567890abcdef...",
  "score": 8021,
  "root": "0x6789abcdef..."
}
```

---

### GET `/api/merkle/checkpoints`
List all Merkle checkpoints.

**Query Parameters:**
- `limit` (optional, default: 24, max: 100) - Number of checkpoints
- `offset` (optional, default: 0) - Pagination offset

**Example:**
```
GET /api/merkle/checkpoints?limit=10
```

**Response:**
```json
{
  "count": 10,
  "checkpoints": [
    {
      "epoch": 42,
      "root": "0xabcdef1234567890...",
      "poolCount": 156,
      "createdAt": "2025-12-02T10:00:00.000Z"
    }
  ]
}
```

---

### GET `/api/merkle/checkpoint/:epoch`
Get a specific checkpoint by epoch.

**Path Parameters:**
- `epoch` (required) - Epoch number

**Example:**
```
GET /api/merkle/checkpoint/42
```

**Response:**
```json
{
  "epoch": 42,
  "root": "0xabcdef1234567890...",
  "poolCount": 156,
  "createdAt": "2025-12-02T10:00:00.000Z"
}
```

**Error Response (404):**
```json
{
  "error": "Checkpoint not found for this epoch"
}
```

---

## WebSocket

### Connection
```
ws://localhost:3001/ws
```

### Client Messages

**Subscribe to specific pools:**
```json
{
  "type": "subscribe",
  "poolIds": ["0x1234...", "0x5678..."]
}
```

**Subscribe to all updates:**
```json
{
  "type": "subscribe",
  "all": true
}
```

**Unsubscribe:**
```json
{
  "type": "unsubscribe"
}
```

### Server Messages

**Connection confirmation:**
```json
{
  "type": "connected",
  "message": "Connected to viral score stream",
  "timestamp": "2025-12-02T10:30:00.000Z"
}
```

**Subscription confirmation:**
```json
{
  "type": "subscribed",
  "poolIds": ["0x1234...", "0x5678..."],
  "subscribeAll": false
}
```

**Score update:**
```json
{
  "type": "scoreUpdate",
  "poolId": "0x1234567890abcdef...",
  "tokenX": "SOL",
  "tokenY": "TRUMP",
  "tokenXScore": 7500,
  "tokenYScore": 8542,
  "pairScore": 8021,
  "timestamp": 1733138400,
  "nonce": 42,
  "signature": "0xabcdef..."
}
```

**Merkle update:**
```json
{
  "type": "merkleUpdate",
  "root": "0xabcdef1234567890...",
  "epoch": 42,
  "poolCount": 156,
  "timestamp": "2025-12-02T10:00:00.000Z"
}
```

**Error:**
```json
{
  "type": "error",
  "message": "Invalid message format"
}
```

---

## Data Models

### Token Score
```typescript
{
  tokenSymbol: string;          // Token symbol (uppercase)
  score: number;                // Viral score (0-10000 basis points)
  tier: string;                 // Score tier classification
  rawPosts: number;             // Number of posts
  rawViews: number;             // Total views
  rawLikes: number;             // Total likes
  rawReposts: number;           // Total reposts
  rawReplies: number;           // Total replies
  rawUniqueUsers: number;       // Unique user count
  avgBondingCurve: number;      // Average bonding curve progress
  graduatedRatio: number;       // Ratio of graduated tokens
  imageRatio: number;           // Ratio of posts with images
  createdAt: string;            // ISO 8601 timestamp
}
```

### Pair Score
```typescript
{
  poolId: string;               // Hex pool ID (keccak256)
  tokenX: string;               // First token (sorted)
  tokenY: string;               // Second token (sorted)
  tokenXScore: number;          // Individual X score
  tokenYScore: number;          // Individual Y score
  pairScore: number;            // Pair score (average)
  timestamp: number;            // Unix timestamp (seconds)
  nonce: number;                // Signature nonce
  signature: string;            // ECDSA signature (hex)
  tier: string;                 // Score tier
  createdAt: string;            // ISO 8601 timestamp
}
```

### Merkle Checkpoint
```typescript
{
  epoch: number;                // Checkpoint epoch number
  root: string;                 // Merkle root (hex)
  poolCount: number;            // Number of pools in tree
  createdAt: string;            // ISO 8601 timestamp
}
```

---

## Score Tiers

Scores are classified into tiers based on their value (0-10000 basis points):

| Tier | Score Range | Description |
|------|-------------|-------------|
| **LEGENDARY** | 8000-10000 | Extremely viral content |
| **VIRAL** | 6000-7999 | High engagement |
| **HOT** | 4000-5999 | Strong engagement |
| **WARM** | 2000-3999 | Moderate engagement |
| **ACTIVE** | 500-1999 | Low engagement |
| **COLD** | 0-499 | Minimal engagement |

---

## Score Calculation

Scores are calculated using a sophisticated algorithm:

1. **Raw Score**: `posts×100 + views×1 + likes×20 + reposts×50 + replies×30 + uniqueUsers×200`
2. **Time Decay**: Exponential decay with 24-hour half-life
3. **Anti-Gaming**: Penalties for suspicious patterns (low engagement ratio, user dominance, spam)
4. **Enhanced Multipliers**:
   - Graduated token bonus: 1.5x
   - Image post bonus: 1.2x
   - Price volatility bonus: 1.1x
5. **Normalization**: Sigmoid-like normalization to 0-10000 basis points

---

## Scheduler Jobs

The server runs three background jobs:

1. **Score Collection** (every 10 seconds)
   - Fetches latest posts from Memex
   - Calculates token scores
   - Updates in-memory cache
   - Saves to database

2. **Merkle Checkpoint** (every hour)
   - Generates all token pairs
   - Calculates pair scores
   - Builds Merkle tree
   - Signs and stores all pair scores
   - Broadcasts to WebSocket clients

3. **Cache Cleanup** (every 5 minutes)
   - Clears processed post cache
   - Keeps only top 100 tokens in memory

---

## Error Codes

| Code | Description |
|------|-------------|
| 400 | Bad Request - Invalid parameters |
| 404 | Not Found - Resource not found |
| 500 | Internal Server Error |

All errors return JSON with an `error` field:
```json
{
  "error": "Error message here"
}
```

---

## Rate Limiting

Currently, no rate limiting is enforced. Recommended for production:
- 100 requests per minute per IP for API endpoints
- 10 WebSocket connections per IP

---

## CORS

CORS is enabled for all origins (`*`). For production, configure specific allowed origins in the server configuration.

---

## Authentication

Currently, no authentication is required. For production:
- Add API key authentication
- Implement JWT tokens for WebSocket connections
- Rate limit by authenticated user

---

## Examples

### JavaScript (Fetch API)
```javascript
// Get token score
const response = await fetch('http://localhost:3001/api/score/tokens/TRUMP');
const data = await response.json();
console.log(data);

// Sign pair score
const signResponse = await fetch('http://localhost:3001/api/score/pair/TRUMP/SOL/sign', {
  method: 'POST'
});
const signData = await signResponse.json();
console.log(signData);
```

### cURL
```bash
# Get leaderboard
curl http://localhost:3001/api/score/tokens/leaderboard?limit=10

# Register pair
curl -X POST http://localhost:3001/api/score/pair/register \
  -H "Content-Type: application/json" \
  -d '{"tokenXSymbol":"TRUMP","tokenYSymbol":"SOL"}'
```

### WebSocket (JavaScript)
```javascript
const ws = new WebSocket('ws://localhost:3001/ws');

ws.onopen = () => {
  // Subscribe to specific pools
  ws.send(JSON.stringify({
    type: 'subscribe',
    poolIds: ['0x1234...']
  }));
};

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log('Received:', data);
};
```

---

## Support

For issues and questions:
- GitHub: [viral-score-collector](https://github.com/meme-pulse/viral-score-collector)
- Documentation: This file
- Health endpoint: `GET /health`
