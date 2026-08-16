"use strict";
/**
 * Scheduler - Cron job polling near market end dates only
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Scheduler = void 0;
exports.createScheduler = createScheduler;
const node_cron_1 = __importDefault(require("node-cron"));
const logger_1 = require("../utils/logger");
class Scheduler {
    config;
    finalityFetcher;
    signingService;
    marketMappings = new Map();
    pendingJobs = new Map();
    cronJob = null;
    isRunning = false;
    submitCallback = null;
    constructor(config, finalityFetcher, signingService) {
        this.config = config;
        this.finalityFetcher = finalityFetcher;
        this.signingService = signingService;
    }
    /**
     * Set the callback for submitting transactions to Algorand
     */
    setSubmitCallback(callback) {
        this.submitCallback = callback;
    }
    /**
     * Add or update a market mapping
     */
    addMarketMapping(mapping) {
        this.marketMappings.set(mapping.algorandMarketId, mapping);
        logger_1.logger.debug('Market mapping added', {
            algorandMarketId: mapping.algorandMarketId,
            conditionId: mapping.polymarketConditionId
        });
    }
    /**
     * Remove a market mapping
     */
    removeMarketMapping(algorandMarketId) {
        this.marketMappings.delete(algorandMarketId);
        this.pendingJobs.delete(algorandMarketId);
    }
    /**
     * Start the scheduler
     */
    start() {
        if (this.isRunning) {
            logger_1.logger.warn('Scheduler already running');
            return;
        }
        const cronExpression = `*/${this.config.checkIntervalMinutes} * * * *`;
        this.cronJob = node_cron_1.default.schedule(cronExpression, async () => {
            await this.runCheck();
        });
        this.isRunning = true;
        logger_1.logger.info('Scheduler started', {
            intervalMinutes: this.config.checkIntervalMinutes,
            lookaheadHours: this.config.lookaheadHours
        });
        // Run initial check
        this.runCheck().catch(err => logger_1.logger.error('Initial check failed', { error: err }));
    }
    /**
     * Stop the scheduler
     */
    stop() {
        if (this.cronJob) {
            this.cronJob.stop();
            this.cronJob = null;
        }
        this.isRunning = false;
        logger_1.logger.info('Scheduler stopped');
    }
    /**
     * Run a single check cycle
     */
    async runCheck() {
        if (this.isRunning === false)
            return;
        logger_1.logger.debug('Running scheduler check');
        const now = Date.now();
        const lookaheadMs = this.config.lookaheadHours * 60 * 60 * 1000;
        const cutoff = now + lookaheadMs;
        // Check all active markets ending within lookahead window
        for (const [marketId, mapping] of this.marketMappings) {
            if (mapping.status !== 'active')
                continue;
            const endTime = mapping.polymarketEndDate.getTime();
            // Skip if market end is too far in future or already passed
            if (endTime > cutoff || endTime < now - 24 * 60 * 60 * 1000) {
                continue;
            }
            // Check finality
            try {
                const finality = await this.finalityFetcher.checkFinality(mapping.polymarketConditionId);
                if (finality.isFinal && finality.outcome !== undefined) {
                    // Market is resolved and final - schedule or submit
                    await this.handleFinalizedMarket(marketId, mapping, finality);
                }
                else if (finality.disputeStatus === 'escalated') {
                    // Dispute escalated - alert admin
                    logger_1.logger.warn('Dispute escalated', {
                        marketId,
                        conditionId: mapping.polymarketConditionId
                    });
                }
            }
            catch (error) {
                logger_1.logger.error('Finality check failed', { marketId, error });
            }
        }
        // Process pending jobs
        await this.processPendingJobs();
    }
    /**
     * Handle a market that has been finalized
     */
    async handleFinalizedMarket(marketId, mapping, finality) {
        // Check if already processed
        if (this.pendingJobs.has(marketId)) {
            const existing = this.pendingJobs.get(marketId);
            if (existing.finality.outcome === finality.outcome) {
                return; // Already handled
            }
        }
        const job = {
            marketMapping: mapping,
            finality,
            scheduledAt: new Date(),
        };
        this.pendingJobs.set(marketId, job);
        logger_1.logger.info('Market finalized, queued for submission', {
            marketId,
            outcome: finality.outcome,
            conditionId: mapping.polymarketConditionId
        });
    }
    /**
     * Process pending resolution jobs
     */
    async processPendingJobs() {
        if (!this.submitCallback) {
            logger_1.logger.warn('No submit callback configured, skipping job processing');
            return;
        }
        for (const [marketId, job] of this.pendingJobs) {
            try {
                // Create submission
                const submission = {
                    marketId: BigInt(job.marketMapping.algorandMarketId),
                    outcome: job.finality.outcome,
                    timestamp: BigInt(Math.floor(Date.now() / 1000)),
                    signature: new Uint8Array(64), // Will be filled by sign()
                };
                // Sign the submission
                submission.signature = this.signingService.sign(submission);
                // Submit to Algorand
                const txId = await this.submitCallback(submission);
                logger_1.logger.info('Oracle submission successful', { marketId, txId });
                // Update mapping status
                job.marketMapping.status = 'resolved';
                job.marketMapping.resolvedOutcome = job.finality.outcome;
                job.marketMapping.outcomeSubmittedAt = new Date();
                // Remove from pending
                this.pendingJobs.delete(marketId);
            }
            catch (error) {
                logger_1.logger.error('Failed to process resolution job', { marketId, error });
                // Keep in pending for retry
            }
        }
    }
    /**
     * Get scheduler status
     */
    getStatus() {
        return {
            running: this.isRunning,
            trackedMarkets: this.marketMappings.size,
            pendingJobs: this.pendingJobs.size,
            nextRun: this.cronJob ? this.getNextRun() : null,
        };
    }
    getNextRun() {
        // Approximate next run based on interval
        const now = new Date();
        const intervalMs = this.config.checkIntervalMinutes * 60 * 1000;
        return new Date(now.getTime() + intervalMs);
    }
}
exports.Scheduler = Scheduler;
/**
 * Create default scheduler
 */
function createScheduler(finalityFetcher, signingService) {
    return new Scheduler({
        checkIntervalMinutes: parseInt(process.env.SCHEDULER_INTERVAL_MINUTES || '5'),
        lookaheadHours: parseInt(process.env.SCHEDULER_LOOKAHEAD_HOURS || '24'),
        algorandAppId: parseInt(process.env.ALGORAND_APP_ID || '0'),
    }, finalityFetcher, signingService);
}
//# sourceMappingURL=index.js.map