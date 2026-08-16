/**
 * Resolution Finality Fetcher - Checks UMA dispute status before treating outcome as final
 */
import { ResolutionFinality, FetcherConfig, FetcherHealth } from '../types';
export declare class FinalityFetcher {
    private gammaClient;
    private umaClient;
    private config;
    private health;
    private cache;
    constructor(config: FetcherConfig);
    /**
     * Check if a market's resolution is final
     * Returns finality status with outcome if final
     */
    checkFinality(conditionId: string): Promise<ResolutionFinality>;
    /**
     * Fetch market resolution data from Gamma
     */
    private fetchMarketResolution;
    /**
     * Check UMA dispute status for a condition ID
     */
    private checkUmaDispute;
    /**
     * Parse outcome string from Polymarket resolution
     */
    private parseOutcome;
    /**
     * Estimate when dispute will end based on status
     */
    private estimateDisputeEndTime;
    /**
     * Check finality for multiple markets
     */
    checkMultipleFinality(conditionIds: string[]): Promise<Map<string, ResolutionFinality>>;
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
 * Create default Finality fetcher configuration
 */
export declare function createFinalityFetcher(): FinalityFetcher;
//# sourceMappingURL=finality.d.ts.map