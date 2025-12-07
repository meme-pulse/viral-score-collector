# Viral Score Server v2.0

Memex 소셜 데이터 기반 밈토큰 viral score 계산 및 온체인 제출 서버

## 🏗️ 아키텍처

```
┌─────────────────────────────────────────────────────────────────┐
│                     VIRAL SCORE SERVER                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌───────────────┐     ┌────────────────┐                      │
│  │   Memex API   │────▶│  Score Calc    │──────┐               │
│  │   (Social)    │     │  (0-10000)     │      │               │
│  └───────────────┘     └────────────────┘      │               │
│                                                │               │
│  ┌───────────────┐     ┌────────────────┐      ▼               │
│  │   GraphQL     │────▶│  TVL Sorting   │──▶ Rankings          │
│  │   (Envio)     │     │                │                      │
│  └───────────────┘     └────────────────┘      │               │
│                                                │               │
│                                                ▼               │
│                              ┌────────────────────────────┐    │
│                              │     Epoch Submitter        │    │
│                              │  - ECDSA Signing           │    │
│                              │  - Contract Submission     │    │
│                              └─────────────┬──────────────┘    │
│                                            │                   │
└────────────────────────────────────────────┼───────────────────┘
                                             │
                                             ▼
                              ┌────────────────────────────┐
                              │   ViralScoreReporter       │
                              │   (On-chain Contract)      │
                              └────────────────────────────┘
```

## 📁 프로젝트 구조

```
viral-score-server/
├── src/
│   ├── index.ts                    # 서버 진입점
│   ├── constants/
│   │   ├── token-blacklist.ts      # 제외 토큰 목록
│   │   └── viral-score-reporter-abi.ts  # 컨트랙트 ABI
│   ├── db/
│   │   ├── client.ts               # DB 클라이언트
│   │   ├── schema.ts               # 스키마 정의
│   │   └── migrate.ts              # 마이그레이션
│   ├── jobs/
│   │   └── scheduler.ts            # 스케줄러
│   ├── routes/
│   │   └── score.ts                # API 라우트
│   ├── services/
│   │   ├── memex-collector.ts      # Memex 데이터 수집
│   │   ├── score-calculator.ts     # 점수 계산
│   │   ├── graphql-client.ts       # TVL 조회
│   │   └── epoch-submitter.ts      # 온체인 제출
│   └── types/
│       ├── memex.ts
│       └── score.ts
├── drizzle/
├── env.template
└── package.json
```

## ⚙️ 환경변수

```env
# Database
DATABASE_URL=postgresql://user:password@localhost:5432/viral_score

# Memex API
MEMEX_API_BASE=https://app.memex.xyz/api/service/public

# Server
PORT=3001

# On-chain (ViralScoreReporter)
SIGNER_PRIVATE_KEY=0x...        # trustedSigner 개인키 (필수)
VIRAL_SCORE_REPORTER_ADDRESS=0x639323a363Da20E755c3D38C14d59FbCC67446bC
CHAIN_ID=43522

# GraphQL (Envio Indexer - TVL 조회)
GRAPHQL_ENDPOINT=https://indexer.dev.hyperindex.xyz/e3c58e2/v1/graphql
QUOTE_TOKEN_ADDRESS=0x653e645e3d81a72e71328Bc01A04002945E3ef7A  # WM
```

## 🔄 스케줄러

| 작업 | 주기 | 설명 |
|------|------|------|
| Score Collection | 10초 | Memex 데이터 수집 & 점수 계산 |
| **Epoch Submission** | 매시 :00 | Top 3 토큰 온체인 제출 |
| Metrics Refresh | 5분 | 최근 포스트 메트릭 갱신 |
| Token Image Refresh | 10분 | 토큰 이미지 캐시 |
| Hourly Snapshot | 매시 :05 | DB 스냅샷 저장 |
| Daily Aggregation | 00:10 UTC | 일별 집계 |

## 🏆 Epoch 제출 로직

### 1. Token Ranking (GraphQL + Viral Score)

```
1. GraphQL에서 LBPair TVL 조회
2. Quote 토큰(WM)과 페어된 밈토큰 그룹화
3. 각 토큰의 binStep을 TVL 순으로 정렬
4. Memex viral score로 토큰 순위 결정
```

### 2. ViralPair 구성

```
Top 3 토큰 선정:
- Rank 1: TVL 상위 3개 binStep (protocol share 10%)
- Rank 2: TVL 상위 2개 binStep (protocol share 20%)
- Rank 3: TVL 상위 1개 binStep (protocol share 40%)
```

### 3. 서명 & 제출

```typescript
// EIP-191 서명
messageHash = keccak256(abi.encode(epoch, pairs))
signature = signer.signMessage({ message: { raw: messageHash } })

// 컨트랙트 호출
reporter.submitEpoch(epoch, pairs, signature)
```

## 🌐 API

### Token Scores

| Method | Path | 설명 |
|--------|------|------|
| GET | `/api/score/tokens` | 모든 토큰 점수 |
| GET | `/api/score/tokens/leaderboard` | 리더보드 (rank, score, stats) |

### Epoch (On-chain)

| Method | Path | 설명 |
|--------|------|------|
| GET | `/api/score/epoch/status` | Epoch 상태 |
| POST | `/api/score/epoch/submit` | 수동 제출 |

### Token Images

| Method | Path | 설명 |
|--------|------|------|
| GET | `/api/score/images/status` | 캐시 상태 |
| GET | `/api/score/images/:symbol` | 토큰 이미지 |
| POST | `/api/score/images/refresh` | 캐시 갱신 |

### Backfill

| Method | Path | 설명 |
|--------|------|------|
| GET | `/api/score/backfill/status` | Backfill 상태 |
| POST | `/api/score/backfill` | Backfill 실행 |

### Health

| Method | Path | 설명 |
|--------|------|------|
| GET | `/` | 서버 정보 |
| GET | `/health` | 상세 상태 |

## 📡 응답 예시

### GET `/api/score/tokens/leaderboard`

```json
{
  "count": 20,
  "updatedAt": "2024-12-04T10:00:00.000Z",
  "leaderboard": [
    {
      "rank": 1,
      "tokenSymbol": "PEPE",
      "imageSrc": "https://...",
      "tokenName": "Pepe Coin",
      "posts": { "1h": 15, "1d": 120, "7d": 850 },
      "views": { "1h": 5000, "1d": 45000, "7d": 320000 },
      "likes": { "1h": 200, "1d": 1800, "7d": 12000 },
      "pulseScore": 85
    }
  ]
}
```

### GET `/api/score/epoch/status`

```json
{
  "ready": true,
  "signerAddress": "0x1066...",
  "currentEpoch": "482156",
  "lastEpoch": "482155",
  "canSubmit": true,
  "activePairs": 6
}
```

## 🚀 실행

```bash
# 설치
bun install

# 개발
bun run dev

# 프로덕션
bun run start
```

## 🔗 연동 컨트랙트

| 항목 | 값 |
|------|-----|
| Contract | `ViralScoreReporter` |
| Address | `0x639323a363Da20E755c3D38C14d59FbCC67446bC` |
| Network | Memecore Testnet (43522) |
| Epoch Duration | 1 hour |
| Max Pairs | 6 (3+2+1) |

## 📊 Protocol Share 감소

| Rank | Protocol Share | 설명 |
|------|----------------|------|
| 1 | 10% | Top viral (3 binSteps) |
| 2 | 20% | 2nd viral (2 binSteps) |
| 3 | 40% | 3rd viral (1 binStep) |
| Default | 50% | 일반 페어 |

