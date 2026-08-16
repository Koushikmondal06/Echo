/**
 * Scheduler - Cron job polling near market end dates only
 */

import cron from 'node-cron';
import { ResolutionFinality, OracleSubmission, MarketMapping } from '../types';
import { FinalityFetcher } from '../fetchers/finality';
import { SigningService } from '../sign';
import { logger } from '../utils/logger';

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

export class Scheduler {
  private config: SchedulerConfig;
  private finalityFetcher: FinalityFetcher;
  private signingService: SigningService;
  private marketMappings: Map<number, MarketMapping> = new Map();
  private pendingJobs: Map<number, MarketResolutionJob> = new Map();
  private cronJob: cron.ScheduledTask | null = null;
  private isRunning = false;
  private submitCallback: ((submission: OracleSubmission) => Promise<string>) | null = null;

  constructor(
    config: SchedulerConfig,
    finalityFetcher: FinalityFetcher,
    signingService: SigningService
  ) {
    this.config = config;
    this.finalityFetcher = finalityFetcher;
    this.signingService = signingService;
  }

  /**
   * Set the callback for submitting transactions to Algorand
   */
  setSubmitCallback(callback: (submission: OracleSubmission) => Promise<string>): void {
    this.submitCallback = callback;
  }

  /**
   * Add or update a market mapping
   */
  addMarketMapping(mapping: MarketMapping): void {
    this.marketMappings.set(mapping.algorandMarketId, mapping);
    logger.debug('Market mapping added', { 
      algorandMarketId: mapping.algorandMarketId,
      conditionId: mapping.polymarketConditionId 
    });
  }

  /**
   * Remove a market mapping
   */
  removeMarketMapping(algorandMarketId: number): void {
    this.marketMappings.delete(algorandMarketId);
    this.pendingJobs.delete(algorandMarketId);
  }

  /**
   * Start the scheduler
   */
  start(): void {
    if (this.isRunning) {
      logger.warn('Scheduler already running');
      return;
    }

    const cronExpression = `*/${this.config.checkIntervalMinutes} * * * *`;
    
    this.cronJob = cron.schedule(cronExpression, async () => {
      await this.runCheck();
    });

    this.isRunning = true;
    logger.info('Scheduler started', { 
      intervalMinutes: this.config.checkIntervalMinutes,
      lookaheadHours: this.config.lookaheadHours 
    });

    // Run initial check
    this.runCheck().catch(err => logger.error('Initial check failed', { error: err }));
  }

  /**
   * Stop the scheduler
   */
  stop(): void {
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
    }
    this.isRunning = false;
    logger.info('Scheduler stopped');
  }

  /**
   * Run a single check cycle
   */
  async runCheck(): Promise<void> {
    if (this.isRunning === false) return;

    logger.debug('Running scheduler check');
    
    const now = Date.now();
    const lookaheadMs = this.config.lookaheadHours * 60 * 60 * 1000;
    const cutoff = now + lookaheadMs;

    // Check all active markets ending within lookahead window
    for (const [marketId, mapping] of this.marketMappings) {
      if (mapping.status !== 'active') continue;

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
        } else if (finality.disputeStatus === 'escalated') {
          // Dispute escalated - alert admin
          logger.warn('Dispute escalated', { 
            marketId, 
            conditionId: mapping.polymarketConditionId 
          });
        }
      } catch (error) {
        logger.error('Finality check failed', { marketId, error });
      }
    }

    // Process pending jobs
    await this.processPendingJobs();
  }

  /**
   * Handle a market that has been finalized
   */
  private async handleFinalizedMarket(
    marketId: number,
    mapping: MarketMapping,
    finality: ResolutionFinality
  ): Promise<void> {
    // Check if already processed
    if (this.pendingJobs.has(marketId)) {
      const existing = this.pendingJobs.get(marketId)!;
      if (existing.finality.outcome === finality.outcome) {
        return; // Already handled
      }
    }

    const job: MarketResolutionJob = {
      marketMapping: mapping,
      finality,
      scheduledAt: new Date(),
    };

    this.pendingJobs.set(marketId, job);
    logger.info('Market finalized, queued for submission', { 
      marketId, 
      outcome: finality.outcome,
      conditionId: mapping.polymarketConditionId 
    });
  }

  /**
   * Process pending resolution jobs
   */
  private async processPendingJobs(): Promise<void> {
    if (!this.submitCallback) {
      logger.warn('No submit callback configured, skipping job processing');
      return;
    }

    for (const [marketId, job] of this.pendingJobs) {
      try {
        // Create submission
        const submission: OracleSubmission = {
          marketId: BigInt(job.marketMapping.algorandMarketId),
          outcome: job.finality.outcome!,
          timestamp: BigInt(Math.floor(Date.now() / 1000)),
          signature: new Uint8Array(64), // Will be filled by sign()
        };

        // Sign the submission
        submission.signature = this.signingService.sign(submission);

        // Submit to Algorand
        const txId = await this.submitCallback(submission);
        
        logger.info('Oracle submission successful', { marketId, txId });
        
        // Update mapping status
        job.marketMapping.status = 'resolved';
        job.marketMapping.resolvedOutcome = job.finality.outcome;
        job.marketMapping.outcomeSubmittedAt = new Date();
        
        // Remove from pending
        this.pendingJobs.delete(marketId);
      } catch (error) {
        logger.error('Failed to process resolution job', { marketId, error });
        // Keep in pending for retry
      }
    }
  }

  /**
   * Get scheduler status
   */
  getStatus(): {
    running: boolean;
    trackedMarkets: number;
    pendingJobs: number;
    nextRun: Date | null;
  } {
    return {
      running: this.isRunning,
      trackedMarkets: this.marketMappings.size,
      pendingJobs: this.pendingJobs.size,
      nextRun: this.cronJob ? this.getNextRun() : null,
    };
  }

  private getNextRun(): Date {
    // Approximate next run based on interval
    const now = new Date();
    const intervalMs = this.config.checkIntervalMinutes * 60 * 1000;
    return new Date(now.getTime() + intervalMs);
  }
}

/**
 * Create default scheduler
 */
export function createScheduler(
  finalityFetcher: FinalityFetcher,
  signingService: SigningService
): Scheduler {
  return new Scheduler(
    {
      checkIntervalMinutes: parseInt(process.env.SCHEDULER_INTERVAL_MINUTES || '5'),
      lookaheadHours: parseInt(process.env.SCHEDULER_LOOKAHEAD_HOURS || '24'),
      algorandAppId: parseInt(process.env.ALGORAND_APP_ID || '0'),
    },
    finalityFetcher,
    signingService
  );
}