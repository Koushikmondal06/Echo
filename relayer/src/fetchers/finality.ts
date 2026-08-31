/**
 * Resolution Finality Fetcher - Checks UMA dispute status before treating outcome as final
 */

import axios, { AxiosInstance } from 'axios';
import pRetry from 'p-retry';
import { ResolutionFinality, FetcherConfig, FetcherHealth } from '../types';
import { logger } from '../utils/logger';

export interface FinalityFetcherConfig extends FetcherConfig {
  testMode?: boolean;
  testFinalConditionIds?: Map<string, { outcome: boolean; disputeStatus: 'none' | 'pending' | 'resolved' | 'escalated' }>;
}

export class FinalityFetcher {
  private gammaClient: AxiosInstance;
  private umaClient: AxiosInstance | null = null;
  private config: FinalityFetcherConfig;
  private health: FetcherHealth;
  private cache: Map<string, { data: ResolutionFinality; timestamp: number }> = new Map();
  private testMode: boolean = false;
  private testFinalConditionIds: Map<string, { outcome: boolean; disputeStatus: 'none' | 'pending' | 'resolved' | 'escalated' }> = new Map();

  constructor(config: FinalityFetcherConfig) {
    this.config = config;
    this.testMode = config.testMode || false;
    this.testFinalConditionIds = config.testFinalConditionIds || new Map();
    
    // Gamma API for market resolution data
    this.gammaClient = axios.create({
      baseURL: process.env.GAMMA_API_URL || 'https://gamma-api.polymarket.com',
      timeout: config.timeout,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'PredictionMarketRelayer/1.0',
      },
    });

    // UMA API for dispute status (if available)
    const umaUrl = process.env.UMA_API_URL;
    if (umaUrl) {
      this.umaClient = axios.create({
        baseURL: umaUrl,
        timeout: config.timeout,
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'PredictionMarketRelayer/1.0',
        },
      });
    }

    this.health = {
      name: config.name,
      status: 'healthy',
      lastSuccess: null,
      lastFailure: null,
      consecutiveFailures: 0,
      lastError: null,
    };
  }

  /**
   * Enable test mode with predefined final condition IDs
   */
  enableTestMode(conditionIds: Map<string, { outcome: boolean; disputeStatus: 'none' | 'pending' | 'resolved' | 'escalated' }>): void {
    this.testMode = true;
    this.testFinalConditionIds = conditionIds;
    logger.info('Finality fetcher test mode enabled', { conditionIds: Array.from(conditionIds.keys()) });
  }

  /**
   * Disable test mode
   */
  disableTestMode(): void {
    this.testMode = false;
    this.testFinalConditionIds.clear();
    logger.info('Finality fetcher test mode disabled');
  }

  /**
   * Check if a market's resolution is final
   * Returns finality status with outcome if final
   */
  async checkFinality(conditionId: string): Promise<ResolutionFinality> {
    const cacheKey = `finality_${conditionId}`;
    const cached = this.cache.get(cacheKey);
    
    // Use shorter cache TTL for finality checks (1 minute)
    if (cached && Date.now() - cached.timestamp < 60 * 1000) {
      return cached.data;
    }

    // Test mode: return predefined finality for test condition IDs
    if (this.testMode && this.testFinalConditionIds.has(conditionId)) {
      const testData = this.testFinalConditionIds.get(conditionId)!;
      const result: ResolutionFinality = {
        conditionId,
        isFinal: testData.disputeStatus === 'none' || testData.disputeStatus === 'resolved',
        outcome: testData.outcome,
        disputeStatus: testData.disputeStatus,
        lastChecked: Date.now(),
      };
      this.cache.set(cacheKey, { data: result, timestamp: Date.now() });
      this.recordSuccess();
      logger.info('Finality check (test mode)', result);
      return result;
    }

    try {
      // First, check Gamma for market resolution status
      const market = await this.fetchMarketResolution(conditionId);
      
      if (!market.isResolved) {
        const result: ResolutionFinality = {
          conditionId,
          isFinal: false,
          disputeStatus: 'none',
          lastChecked: Date.now(),
        };
        this.cache.set(cacheKey, { data: result, timestamp: Date.now() });
        this.recordSuccess();
        return result;
      }

      // Market is resolved on Gamma, check UMA dispute status
      const disputeStatus = await this.checkUmaDispute(conditionId);
      
      let isFinal = false;
      let outcome: boolean | undefined;
      
      if (disputeStatus === 'none' || disputeStatus === 'resolved') {
        isFinal = true;
        // Parse outcome from resolution string
        outcome = this.parseOutcome(market.resolution);
      } else if (disputeStatus === 'escalated') {
        // Still in dispute process, not final yet
        isFinal = false;
      }

      const result: ResolutionFinality = {
        conditionId,
        isFinal,
        outcome,
        disputeStatus,
        disputeEndTime: this.estimateDisputeEndTime(disputeStatus),
        lastChecked: Date.now(),
      };

      this.cache.set(cacheKey, { data: result, timestamp: Date.now() });
      this.recordSuccess();

      logger.info('Finality check complete', { 
        conditionId, 
        isFinal, 
        outcome, 
        disputeStatus 
      });

      return result;
    } catch (error) {
      this.recordFailure(error instanceof Error ? error.message : 'Unknown error');
      
      // Return cached stale data if available, or throw
      if (cached) {
        logger.warn('Returning stale finality data due to error', { conditionId });
        return cached.data;
      }
      throw error;
    }
  }

  /**
   * Fetch market resolution data from Gamma
   */
  private async fetchMarketResolution(conditionId: string): Promise<{
    isResolved: boolean;
    resolution?: string;
    isActive: boolean;
  }> {
    try {
      const response = await pRetry(
        () => this.gammaClient.get(`/markets/${conditionId}`),
        {
          retries: this.config.retryAttempts,
          minTimeout: this.config.retryDelay,
        }
      );

      const market = response.data.market;
      return {
        isResolved: market.isResolved || false,
        resolution: market.resolution,
        isActive: market.isActive || false,
      };
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return { isResolved: false, isActive: false };
      }
      throw error;
    }
  }

  /**
   * Check UMA dispute status for a condition ID
   */
  private async checkUmaDispute(conditionId: string): Promise<'none' | 'pending' | 'resolved' | 'escalated'> {
    if (!this.umaClient) {
      // No UMA client configured - assume no dispute if Gamma says resolved
      logger.warn('UMA client not configured, assuming no dispute');
      return 'none';
    }

    try {
      const response = await pRetry(
        () => this.umaClient!.get(`/disputes/${conditionId}`),
        {
          retries: this.config.retryAttempts,
          minTimeout: this.config.retryDelay,
        }
      );

      const dispute = response.data.dispute;
      
      if (!dispute) {
        return 'none';
      }

      switch (dispute.status) {
        case 'open':
        case 'voting':
          return 'pending';
        case 'resolved':
          return 'resolved';
        case 'escalated':
        case 'appealed':
          return 'escalated';
        default:
          return 'pending';
      }
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return 'none';
      }
      logger.error('UMA dispute check failed', { conditionId, error });
      // On error, be conservative and assume pending
      return 'pending';
    }
  }

  /**
   * Parse outcome string from Polymarket resolution
   */
  private parseOutcome(resolution?: string): boolean | undefined {
    if (!resolution) return undefined;
    
    const lower = resolution.toLowerCase();
    if (lower.includes('yes') || lower.includes('true') || lower === '1') {
      return true;
    }
    if (lower.includes('no') || lower.includes('false') || lower === '0') {
      return false;
    }
    return undefined;
  }

  /**
   * Estimate when dispute will end based on status
   */
  private estimateDisputeEndTime(status: string): number | undefined {
    const now = Date.now();
    // UMA disputes typically take 2-5 days
    switch (status) {
      case 'pending':
        return now + 3 * 24 * 60 * 60 * 1000; // 3 days
      case 'escalated':
        return now + 5 * 24 * 60 * 60 * 1000; // 5 days
      default:
        return undefined;
    }
  }

  /**
   * Check finality for multiple markets
   */
  async checkMultipleFinality(conditionIds: string[]): Promise<Map<string, ResolutionFinality>> {
    const results = new Map<string, ResolutionFinality>();
    
    // Process in parallel with concurrency limit
    const concurrency = 3;
    for (let i = 0; i < conditionIds.length; i += concurrency) {
      const batch = conditionIds.slice(i, i + concurrency);
      const promises = batch.map(async (id) => {
        try {
          const finality = await this.checkFinality(id);
          return { id, finality };
        } catch (error) {
          logger.error('Finality check failed', { conditionId: id, error });
          return { id, finality: null };
        }
      });

      const batchResults = await Promise.all(promises);
      for (const { id, finality } of batchResults) {
        if (finality) {
          results.set(id, finality);
        }
      }
    }

    return results;
  }

  /**
   * Get current health status
   */
  getHealth(): FetcherHealth {
    return { ...this.health };
  }

  /**
   * Clear cache
   */
  clearCache(): void {
    this.cache.clear();
  }

  private recordSuccess(): void {
    this.health.status = 'healthy';
    this.health.lastSuccess = new Date();
    this.health.consecutiveFailures = 0;
    this.health.lastError = null;
  }

  private recordFailure(error: string): void {
    this.health.lastFailure = new Date();
    this.health.consecutiveFailures++;
    this.health.lastError = error;
    
    if (this.health.consecutiveFailures >= 3) {
      this.health.status = 'down';
    } else if (this.health.consecutiveFailures >= 1) {
      this.health.status = 'degraded';
    }
    
    logger.error('Finality fetcher failure', { 
      consecutiveFailures: this.health.consecutiveFailures, 
      error 
    });
  }
}

/**
 * Create default Finality fetcher configuration
 */
export function createFinalityFetcher(): FinalityFetcher {
  return new FinalityFetcher({
    name: 'finality',
    baseUrl: process.env.GAMMA_API_URL || 'https://gamma-api.polymarket.com',
    timeout: 10000,
    retryAttempts: 3,
    retryDelay: 1000,
    cacheTtl: 60 * 1000, // 1 minute
  });
}