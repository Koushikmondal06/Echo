/**
 * Scheduler - Cron job polling near market end dates only
 */
import { ResolutionFinality, OracleSubmission, MarketMapping } from '../types';
import { FinalityFetcher } from '../fetchers/finality';
import { SigningService } from '../sign';
export interface SchedulerConfig {
    checkIntervalMinutes: number;
    lookaheadHours: number;
    algorandAppId: number;
}
export interface MarketResolutionJob {
    marketMapping: MarketMapping;
    finality: ResolutionFinality;
    scheduledAt: Date;
}
export declare class Scheduler {
    private config;
    private finalityFetcher;
    private signingService;
    private marketMappings;
    private pendingJobs;
    private cronJob;
    private isRunning;
    private submitCallback;
    constructor(config: SchedulerConfig, finalityFetcher: FinalityFetcher, signingService: SigningService);
    /**
     * Set the callback for submitting transactions to Algorand
     */
    setSubmitCallback(callback: (submission: OracleSubmission) => Promise<string>): void;
    /**
     * Add or update a market mapping
     */
    addMarketMapping(mapping: MarketMapping): void;
    /**
     * Remove a market mapping
     */
    removeMarketMapping(algorandMarketId: number): void;
    /**
     * Start the scheduler
     */
    start(): void;
    /**
     * Stop the scheduler
     */
    stop(): void;
    /**
     * Run a single check cycle
     */
    runCheck(): Promise<void>;
    /**
     * Handle a market that has been finalized
     */
    private handleFinalizedMarket;
    /**
     * Process pending resolution jobs
     */
    private processPendingJobs;
    /**
     * Get scheduler status
     */
    getStatus(): {
        running: boolean;
        trackedMarkets: number;
        pendingJobs: number;
        nextRun: Date | null;
    };
    private getNextRun;
}
/**
 * Create default scheduler
 */
export declare function createScheduler(finalityFetcher: FinalityFetcher, signingService: SigningService): Scheduler;
//# sourceMappingURL=index.d.ts.map