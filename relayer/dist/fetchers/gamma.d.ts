/**
 * Gamma Market Fetcher - Fetches market metadata from Polymarket Gamma API
 */
import { PolymarketMarket, FetcherConfig, FetcherHealth } from '../types';
export declare class GammaFetcher {
    private client;
    private config;
    private health;
    private cache;
    constructor(config: FetcherConfig);
    /**
     * Fetch all active markets from Gamma API
     */
    fetchMarkets(params?: {
        active?: boolean;
        closed?: boolean;
        limit?: number;
        offset?: number;
    }): Promise<PolymarketMarket[]>;
    /**
     * Fetch a single market by condition ID
     */
    fetchMarketByConditionId(conditionId: string): Promise<PolymarketMarket | null>;
    /**
     * Fetch markets ending soon (for scheduler)
     */
    fetchMarketsEndingSoon(hoursAhead?: number): Promise<PolymarketMarket[]>;
    /**
     * Get current health status
     */
    getHealth(): FetcherHealth;
    /**
     * Clear cache
     */
    clearCache(): void;
    private recordSuccess;
    private recordFailure;
}
/**
 * Create default Gamma fetcher configuration
 */
export declare function createGammaFetcher(): GammaFetcher;
//# sourceMappingURL=gamma.d.ts.map