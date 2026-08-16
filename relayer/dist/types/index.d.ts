/**
 * Core type definitions for the relayer service
 */
export interface PolymarketMarket {
    id: string;
    conditionId: string;
    question: string;
    description: string;
    endDate: string;
    outcomes: string[];
    outcomePrices: string[];
    volume: string;
    liquidity: string;
    category: string;
    tags: string[];
    isActive: boolean;
    isClosed: boolean;
    isResolved: boolean;
    resolution?: string;
}
export interface PolymarketClobPrice {
    market: string;
    assetId: string;
    price: string;
    size: string;
    side: 'buy' | 'sell';
    timestamp: number;
}
export interface PolymarketOrderBook {
    bids: PolymarketClobPrice[];
    asks: PolymarketClobPrice[];
    midPrice: number;
    spread: number;
}
export interface ResolutionFinality {
    conditionId: string;
    isFinal: boolean;
    outcome?: boolean;
    disputeStatus: 'none' | 'pending' | 'resolved' | 'escalated';
    disputeEndTime?: number;
    lastChecked: number;
}
export interface OracleSubmission {
    marketId: bigint;
    outcome: boolean;
    timestamp: bigint;
    signature: Uint8Array;
}
export interface FetcherConfig {
    name: string;
    baseUrl: string;
    timeout: number;
    retryAttempts: number;
    retryDelay: number;
    cacheTtl: number;
}
export interface MarketMapping {
    algorandMarketId: number;
    algorandAppId: number;
    yesAssetId: number;
    noAssetId: number;
    polymarketMarketId: string;
    polymarketConditionId: string;
    polymarketQuestion: string;
    polymarketResolutionCriteria: string;
    polymarketEndDate: Date;
    seedLiquidity: number;
    bParam: number;
    status: 'active' | 'resolved' | 'disputed' | 'settled';
    resolvedOutcome?: boolean;
    outcomeSubmittedAt?: Date;
    disputeDeadline?: Date;
    oraclePubkey: Uint8Array;
}
export interface RelayerConfig {
    algorandNodeUrl: string;
    algorandIndexerUrl: string;
    appId: number;
    oraclePrivateKey: Uint8Array;
    oracleAddress: string;
    fetchers: {
        gamma: FetcherConfig;
        clob: FetcherConfig;
        finality: FetcherConfig;
        secondary: FetcherConfig;
    };
    scheduler: {
        checkIntervalMinutes: number;
        lookaheadHours: number;
    };
}
export interface FetcherHealth {
    name: string;
    status: 'healthy' | 'degraded' | 'down';
    lastSuccess: Date | null;
    lastFailure: Date | null;
    consecutiveFailures: number;
    lastError: string | null;
}
//# sourceMappingURL=index.d.ts.map