# Viral Score Server

소셜 미디어 바이럴 데이터를 수집하고 DeFi 풀의 프로토콜 수수료 할인에 활용하는 서버입니다.

## 기능

- **Memex API 데이터 수집**: 소셜 미디어 engagement 데이터 실시간 수집
- **Viral Score 계산**: 가중치 기반 점수 계산 및 time decay 적용
- **서명된 점수 제공**: viem ECDSA 서명으로 온체인 검증 가능
- **Merkle Tree**: 배치 검증을 위한 주기적 Merkle checkpoint
- **실시간 WebSocket**: 점수 업데이트 실시간 스트리밍

## 기술 스택

- **Runtime**: Bun
- **Framework**: Hono
- **Database**: PostgreSQL (Drizzle ORM)
- **Signing**: viem
- **Merkle**: @openzeppelin/merkle-tree

## 설치

```bash
# Bun 설치 (없는 경우)
curl -fsSL https://bun.sh/install | bash

# 의존성 설치
bun install

# 환경변수 설정
cp env.template .env
# .env 파일 수정

# 데이터베이스 마이그레이션
bun run db:generate
bun run db:migrate

# 서버 실행
bun run dev
```

## 환경변수

```env
# Database
DATABASE_URL=postgresql://user:password@localhost:5432/viral_score

# Signer (프로덕션용 새 키 생성 필요)
SIGNER_PRIVATE_KEY=0x...

# Memex API
MEMEX_API_BASE=https://app.memex.xyz/api/service/public

# Server
PORT=3001
```

## API 엔드포인트

### Score API

| Method | Endpoint                     | Description                |
| ------ | ---------------------------- | -------------------------- |
| GET    | `/api/score/:poolId`         | 풀의 최신 서명된 점수 조회 |
| GET    | `/api/score/:poolId/history` | 풀의 점수 히스토리 조회    |
| GET    | `/api/score/token/:symbol`   | 토큰 심볼로 점수 조회      |
| GET    | `/api/score/leaderboard`     | 점수 순위표                |
| POST   | `/api/score/register`        | 새 토큰 등록               |
| GET    | `/api/score/signer`          | 서명자 주소 조회           |

### Merkle API

| Method | Endpoint                        | Description             |
| ------ | ------------------------------- | ----------------------- |
| GET    | `/api/merkle/root`              | 현재 Merkle root 조회   |
| GET    | `/api/merkle/proof/:poolId`     | 풀의 Merkle proof 조회  |
| POST   | `/api/merkle/verify`            | Merkle proof 검증       |
| GET    | `/api/merkle/checkpoints`       | Checkpoint 목록         |
| GET    | `/api/merkle/checkpoint/:epoch` | 특정 epoch의 checkpoint |

### WebSocket

```javascript
// 연결
const ws = new WebSocket('ws://localhost:3001/ws');

// 특정 풀 구독
ws.send(
  JSON.stringify({
    type: 'subscribe',
    poolIds: ['0x1234...', '0x5678...'],
  })
);

// 모든 업데이트 구독
ws.send(
  JSON.stringify({
    type: 'subscribeAll',
  })
);

// 점수 업데이트 수신
ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  if (data.type === 'scoreUpdate') {
    console.log('New score:', data.data);
  }
};
```

## 점수 계산 로직

```
rawScore = posts × 100 + views × 1 + likes × 20 + reposts × 50 + replies × 30 + uniqueUsers × 200

timeDecay = e^(-ageHours × ln(2) / 24)  // 24시간 반감기

finalScore = normalize(rawScore × timeDecay × antiGamingFactor)  // 0-10000
```

### Score Tiers

| Score     | Tier      |
| --------- | --------- |
| 8000+     | LEGENDARY |
| 6000-7999 | VIRAL     |
| 4000-5999 | HOT       |
| 2000-3999 | WARM      |
| 500-1999  | ACTIVE    |
| 0-499     | COLD      |

## 온체인 통합

### 서명 검증 (Solidity)

```solidity
function verifyScore(
    bytes32 poolId,
    uint256 score,
    uint256 timestamp,
    uint256 nonce,
    bytes calldata signature
) external view returns (bool) {
    bytes32 messageHash = keccak256(abi.encodePacked(poolId, score, timestamp, nonce));
    bytes32 ethHash = messageHash.toEthSignedMessageHash();
    return ethHash.recover(signature) == trustedSigner;
}
```

### Protocol Share 계산

```solidity
// 최대 50% 할인 (score 10000일 때)
uint256 reductionBps = (score * 5000) / 10000;
uint256 adjustedShare = baseShare * (10000 - reductionBps) / 10000;
```

## 개발

```bash
# 개발 모드 (watch)
bun run dev

# 프로덕션 실행
bun run start

# DB 스키마 생성
bun run db:generate

# DB 마이그레이션
bun run db:migrate

# Drizzle Studio (DB 관리)
bun run db:studio
```

## 아키텍처

```
┌─────────────────────────────────────────────────────────────────┐
│                         VIRAL SCORE SERVER                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   ┌─────────────┐     ┌─────────────┐     ┌─────────────┐       │
│   │   Memex     │     │   Score     │     │   Signer    │       │
│   │  Collector  │────▶│ Calculator  │────▶│  Service    │       │
│   └─────────────┘     └─────────────┘     └──────┬──────┘       │
│                                                   │              │
│                                                   ▼              │
│   ┌─────────────┐     ┌─────────────┐     ┌─────────────┐       │
│   │  Scheduler  │     │   Merkle    │     │  PostgreSQL │       │
│   │   (Cron)    │────▶│  Builder    │────▶│    (DB)     │       │
│   └─────────────┘     └─────────────┘     └─────────────┘       │
│                                                   │              │
│                                                   ▼              │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │                    Hono HTTP Server                     │   │
│   │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │   │
│   │  │  Score API   │  │  Merkle API  │  │  WebSocket   │   │   │
│   │  └──────────────┘  └──────────────┘  └──────────────┘   │   │
│   └─────────────────────────────────────────────────────────┘   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## License

MIT
