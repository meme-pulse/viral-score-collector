import { createPublicClient, createWalletClient, http, encodeAbiParameters, keccak256, type Hex, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { VIRAL_SCORE_REPORTER_ABI, VIRAL_SCORE_REPORTER_ADDRESS } from '../constants/viral-score-reporter-abi';

/**
 * ViralPair structure matching the contract
 */
export interface ViralPair {
  tokenX: Address;
  tokenY: Address;
  binStep: number;
  rank: 1 | 2 | 3; // 1 = best, 3 = third
}

/**
 * Token ranking with multiple binSteps
 */
export interface TokenRanking {
  tokenAddress: Address;
  quoteTokenAddress: Address;
  score: number;
  binSteps: number[]; // sorted by TVL (highest first)
}

/**
 * Memecore Testnet chain definition
 */
const memecoreTestnet = {
  id: 43522,
  name: 'Memecore Testnet',
  network: 'memecore-testnet',
  nativeCurrency: {
    decimals: 18,
    name: 'M',
    symbol: 'M',
  },
  rpcUrls: {
    default: { http: ['https://rpc.insectarium.memecore.net'] },
    public: { http: ['https://rpc.insectarium.memecore.net'] },
  },
} as const;

/**
 * Epoch Submitter
 * Signs and submits viral score epochs to the ViralScoreReporter contract
 */
export class EpochSubmitter {
  private publicClient;
  private walletClient;
  private account;
  private reporterAddress: Address;

  constructor() {
    const privateKey = process.env.SIGNER_PRIVATE_KEY;
    if (!privateKey) {
      console.warn('[EpochSubmitter] SIGNER_PRIVATE_KEY not set - epoch submission disabled');
    }

    this.reporterAddress = (process.env.VIRAL_SCORE_REPORTER_ADDRESS || VIRAL_SCORE_REPORTER_ADDRESS) as Address;

    // Create public client for reading
    this.publicClient = createPublicClient({
      chain: memecoreTestnet,
      transport: http(),
    });

    // Create wallet client for signing/writing (only if private key exists)
    if (privateKey) {
      this.account = privateKeyToAccount(privateKey as Hex);
      this.walletClient = createWalletClient({
        account: this.account,
        chain: memecoreTestnet,
        transport: http(),
      });
      console.log(`[EpochSubmitter] Initialized with signer: ${this.account.address}`);
    }
  }

  /**
   * Check if submitter is configured and ready
   */
  isReady(): boolean {
    return !!this.account && !!this.walletClient;
  }

  /**
   * Get the signer address
   */
  getSignerAddress(): Address | null {
    return this.account?.address ?? null;
  }

  /**
   * Get current epoch from contract
   */
  async getCurrentEpoch(): Promise<bigint> {
    return (await this.publicClient.readContract({
      address: this.reporterAddress,
      abi: VIRAL_SCORE_REPORTER_ABI,
      functionName: 'getCurrentEpoch',
    })) as bigint;
  }

  /**
   * Get last submitted epoch from contract
   */
  async getLastEpoch(): Promise<bigint> {
    return (await this.publicClient.readContract({
      address: this.reporterAddress,
      abi: VIRAL_SCORE_REPORTER_ABI,
      functionName: 'lastEpoch',
    })) as bigint;
  }

  /**
   * Get trusted signer from contract
   */
  async getTrustedSigner(): Promise<Address> {
    return (await this.publicClient.readContract({
      address: this.reporterAddress,
      abi: VIRAL_SCORE_REPORTER_ABI,
      functionName: 'trustedSigner',
    })) as Address;
  }

  /**
   * Build ViralPairs from top 3 token rankings
   * - Rank 1: Top 3 TVL binSteps
   * - Rank 2: Top 2 TVL binSteps
   * - Rank 3: Top 1 TVL binStep
   *
   * @param rankings Sorted by score (highest first), max 3
   */
  buildViralPairs(rankings: TokenRanking[]): ViralPair[] {
    const pairs: ViralPair[] = [];
    const maxPairsPerRank = [3, 2, 1]; // Rank 1 gets 3, Rank 2 gets 2, Rank 3 gets 1

    for (let rankIdx = 0; rankIdx < Math.min(rankings.length, 3); rankIdx++) {
      const ranking = rankings[rankIdx];
      const rank = (rankIdx + 1) as 1 | 2 | 3;
      const pairsToAdd = maxPairsPerRank[rankIdx];

      // Add pairs for each binStep (up to the limit for this rank)
      for (let i = 0; i < Math.min(ranking.binSteps.length, pairsToAdd); i++) {
        pairs.push({
          tokenX: ranking.tokenAddress,
          tokenY: ranking.quoteTokenAddress,
          binStep: ranking.binSteps[i],
          rank,
        });
      }
    }

    return pairs;
  }

  /**
   * Sign epoch data for contract verification
   * Matches contract's _verifySignature:
   *   bytes32 messageHash = keccak256(abi.encode(epoch, pairs));
   *   bytes32 ethSignedHash = messageHash.toEthSignedMessageHash();
   */
  async signEpoch(epoch: bigint, pairs: ViralPair[]): Promise<Hex> {
    if (!this.account) {
      throw new Error('Signer not configured');
    }

    // Encode the data exactly as the contract does
    // abi.encode(epoch, pairs) where pairs is ViralPair[]
    const encodedData = encodeAbiParameters(
      [
        { type: 'uint256' },
        {
          type: 'tuple[]',
          components: [
            { name: 'tokenX', type: 'address' },
            { name: 'tokenY', type: 'address' },
            { name: 'binStep', type: 'uint16' },
            { name: 'rank', type: 'uint8' },
          ],
        },
      ],
      [
        epoch,
        pairs.map((p) => ({
          tokenX: p.tokenX,
          tokenY: p.tokenY,
          binStep: p.binStep,
          rank: p.rank,
        })),
      ]
    );

    // keccak256(abi.encode(epoch, pairs))
    const messageHash = keccak256(encodedData);

    // Sign with EIP-191 prefix (toEthSignedMessageHash)
    const signature = await this.account.signMessage({
      message: { raw: messageHash },
    });

    return signature;
  }

  /**
   * Submit epoch to contract
   */
  async submitEpoch(epoch: bigint, pairs: ViralPair[]): Promise<{ txHash: Hex; epoch: bigint; pairsCount: number }> {
    if (!this.walletClient || !this.account) {
      throw new Error('Wallet client not configured - set SIGNER_PRIVATE_KEY');
    }

    // Sign the epoch data
    const signature = await this.signEpoch(epoch, pairs);
    console.log(`[EpochSubmitter] Signed epoch ${epoch} with ${pairs.length} pairs`);

    // Submit to contract
    const txHash = await this.walletClient.writeContract({
      address: this.reporterAddress,
      abi: VIRAL_SCORE_REPORTER_ABI,
      functionName: 'submitEpoch',
      args: [
        epoch,
        pairs.map((p) => ({
          tokenX: p.tokenX,
          tokenY: p.tokenY,
          binStep: p.binStep,
          rank: p.rank,
        })),
        signature,
      ],
    });

    console.log(`[EpochSubmitter] Submitted epoch ${epoch}, txHash: ${txHash}`);

    // Wait for confirmation
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    console.log(`[EpochSubmitter] Epoch ${epoch} confirmed in block ${receipt.blockNumber}, status: ${receipt.status}`);

    return {
      txHash,
      epoch,
      pairsCount: pairs.length,
    };
  }

  /**
   * Check if a new epoch can be submitted
   */
  async canSubmitNewEpoch(): Promise<{ canSubmit: boolean; currentEpoch: bigint; lastEpoch: bigint }> {
    const currentEpoch = await this.getCurrentEpoch();
    const lastEpoch = await this.getLastEpoch();

    return {
      canSubmit: currentEpoch > lastEpoch,
      currentEpoch,
      lastEpoch,
    };
  }

  /**
   * Get active viral pairs from contract
   */
  async getActiveViralPairs(): Promise<ViralPair[]> {
    const pairs = await this.publicClient.readContract({
      address: this.reporterAddress,
      abi: VIRAL_SCORE_REPORTER_ABI,
      functionName: 'getAllActiveViralPairs',
    });

    return (pairs as any[]).map((p) => ({
      tokenX: p.tokenX as Address,
      tokenY: p.tokenY as Address,
      binStep: Number(p.binStep),
      rank: Number(p.rank) as 1 | 2 | 3,
    }));
  }
}

// Singleton instance
export const epochSubmitter = new EpochSubmitter();
