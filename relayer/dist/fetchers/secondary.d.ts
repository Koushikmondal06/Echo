/**
 * Secondary Reference Fetcher - Fallback source (e.g., Kalshi) for multi-oracle setups
 */
import { FetcherConfig, FetcherHealth } from '../types';
export interface KalshiMarket {
    ticker: string;
    title: string;
    yes_price: number;
    no_price: number;
    volume: number;
    close_time: string;
    status: 'open' | 'closed' | 'settled';
    result?: 'yes' | 'no';
}
export interface SecondaryMarketData {
    source: 'kalshi' | 'custom';
    conditionId: string;
    priceYes: number;
    priceNo: number;
    volume: number;
    endTime: number;
    isResolved: boolean;
    outcome?: boolean;
    lastUpdated: number;
}
export declare class SecondaryFetcher {
    private client;
    private config;
    private health;
    private cache;
    private enabled;
    constructor(config: FetcherConfig);
    /**
     * Fetch market data from secondary source
     */
    fetchMarket(conditionId: string): Promise<SecondaryMarketData | null>;
    /**
     * Fetch from Kalshi API
     */
    private fetchFromKalshi;
    /**
     * Fetch from custom secondary endpoint
     */
    private fetchFromCustom;
    /**
     * Map Polymarket condition ID to Kalshi ticker
     * In production, this would be a configurable mapping table
     */
    private getKalshiMapping;
    /**
     * Cross-check price with primary source
     */
    crossCheckPrice(conditionId: string, primaryPriceYes: number): Promise<{
        secondaryPrice: number | null;
        deviation: number | null;
        agreement: boolean;
    }>;
    /**
     * Get current health status
     */
    getHealth(): FetcherHealth;
    /**
     * Clear cache
     */
    clearCache(): void;
    /**
     * Enable/disable fetcher
     */
    setEnabled(enabled: boolean): void;
    private recordSuccess;
    private recordFailure;
}
/**
 * Create default Secondary fetcher configuration
 */
export declare function createSecondaryFetcher(): SecondaryFetcher;
//# sourceMappingURL=secondary.d.ts.map