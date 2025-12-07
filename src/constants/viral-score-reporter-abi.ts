/**
 * ViralScoreReporter Contract ABI
 * Contract Address (Memecore Testnet): 0x639323a363Da20E755c3D38C14d59FbCC67446bC
 */

export const VIRAL_SCORE_REPORTER_ABI = [
  {
    type: "constructor",
    inputs: [
      { name: "_factory", type: "address" },
      { name: "_owner", type: "address" },
    ],
  },
  // Events
  {
    type: "event",
    name: "EpochUpdated",
    inputs: [
      { name: "epoch", type: "uint256", indexed: true },
      { name: "restoredCount", type: "uint256", indexed: false },
      { name: "newViralCount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "PairActivated",
    inputs: [
      { name: "tokenX", type: "address", indexed: true },
      { name: "tokenY", type: "address", indexed: true },
      { name: "binStep", type: "uint16", indexed: false },
      { name: "rank", type: "uint8", indexed: false },
      { name: "newShare", type: "uint16", indexed: false },
    ],
  },
  {
    type: "event",
    name: "PairRestored",
    inputs: [
      { name: "tokenX", type: "address", indexed: true },
      { name: "tokenY", type: "address", indexed: true },
      { name: "binStep", type: "uint16", indexed: false },
      { name: "protocolShare", type: "uint16", indexed: false },
    ],
  },
  // Errors
  { type: "error", name: "InvalidEpoch", inputs: [] },
  { type: "error", name: "InvalidSignature", inputs: [] },
  { type: "error", name: "InvalidRank", inputs: [] },
  { type: "error", name: "TooManyPairs", inputs: [] },
  { type: "error", name: "PairNotFound", inputs: [] },
  { type: "error", name: "ArrayLengthMismatch", inputs: [] },
  // Read Functions
  {
    type: "function",
    name: "EPOCH_DURATION",
    inputs: [],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "MAX_VIRAL_PAIRS",
    inputs: [],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "factory",
    inputs: [],
    outputs: [{ type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "trustedSigner",
    inputs: [],
    outputs: [{ type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "lastEpoch",
    inputs: [],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "defaultProtocolShare",
    inputs: [],
    outputs: [{ type: "uint16" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "rankProtocolShares",
    inputs: [{ name: "index", type: "uint256" }],
    outputs: [{ type: "uint16" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getCurrentEpoch",
    inputs: [],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getActiveViralPairsCount",
    inputs: [],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getAllActiveViralPairs",
    inputs: [],
    outputs: [
      {
        type: "tuple[]",
        components: [
          { name: "tokenX", type: "address" },
          { name: "tokenY", type: "address" },
          { name: "binStep", type: "uint16" },
          { name: "rank", type: "uint8" },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getActiveViralPair",
    inputs: [{ name: "index", type: "uint256" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "tokenX", type: "address" },
          { name: "tokenY", type: "address" },
          { name: "binStep", type: "uint16" },
          { name: "rank", type: "uint8" },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getProtocolShareForRank",
    inputs: [{ name: "rank", type: "uint256" }],
    outputs: [{ type: "uint16" }],
    stateMutability: "view",
  },
  // Write Functions
  {
    type: "function",
    name: "submitEpoch",
    inputs: [
      { name: "epoch", type: "uint256" },
      {
        name: "pairs",
        type: "tuple[]",
        components: [
          { name: "tokenX", type: "address" },
          { name: "tokenY", type: "address" },
          { name: "binStep", type: "uint16" },
          { name: "rank", type: "uint8" },
        ],
      },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

export const VIRAL_SCORE_REPORTER_ADDRESS = "0x639323a363Da20E755c3D38C14d59FbCC67446bC" as const;




