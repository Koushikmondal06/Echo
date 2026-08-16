/**
 * CLOB Price Fetcher - Fetches live order book prices from Polymarket CLOB API
 */
import { PolymarketOrderBook, FetcherConfig, FetcherHealth } from '../types';
export declare class ClobFetcher {
    private client;
    private config;
    private health;
    private priceCache;
    constructor(config: FetcherConfig);
    /**
     * Fetch order book for a specific market
     */
    fetchOrderBook(marketId: string): Promise<PolymarketOrderBook>;
    /**
     * Fetch current price for a market (mid price)
     */
    fetchPrice(marketId: string): Promise<number>;
    /**
     * Fetch prices for multiple markets
     */
    fetchPrices(marketIds: string[]): Promise<Map<string, number>>;
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
 * Create default CLOB fetcher configuration
 */
export declare function createClobFetcher(): ClobFetcher;
//# sourceMappingURL=clob.d.ts.map