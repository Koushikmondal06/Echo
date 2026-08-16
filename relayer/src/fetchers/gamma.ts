/**
 * Gamma Market Fetcher - Fetches market metadata from Polymarket Gamma API
 */

import axios, { AxiosInstance } from 'axios';
import pRetry from 'p-retry';
import { PolymarketMarket, FetcherConfig, FetcherHealth } from '../types';
import { logger } from '../utils/logger';

export class GammaFetcher {
  private client: AxiosInstance;
  private config: FetcherConfig;
  private health: FetcherHealth;
  private cache: Map<string, { data: PolymarketMarket[]; timestamp: number }> = new Map();

  constructor(config: FetcherConfig) {
    this.config = config;
    this.client = axios.create({
      baseURL: config.baseUrl,
      timeout: config.timeout,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'PredictionMarketRelayer/1.0',
      },
    });
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
   * Fetch all active markets from Gamma API
   */
  async fetchMarkets(params?: {
    active?: boolean;
    closed?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<PolymarketMarket[]> {
    const cacheKey = `markets_${JSON.stringify(params)}`;
    const cached = this.cache.get(cacheKey);
    
    if (cached && Date.now() - cached.timestamp < this.config.cacheTtl) {
      logger.debug('Returning cached markets', { count: cached.data.length });
      return cached.data;
    }

    try {
      const response = await pRetry(
        () => this.client.get<{ markets: PolymarketMarket[] }>('/markets', { params }),
        {
          retries: this.config.retryAttempts,
          minTimeout: this.config.retryDelay,
          factor: 2,
          onFailedAttempt: (error) => {
            logger.warn('Gamma API retry', { attempt: error.attemptNumber, error: error.message });
          },
        }
      );

      const markets = response.data.markets || [];
      
      this.cache.set(cacheKey, { data: markets, timestamp: Date.now() });
      this.recordSuccess();
      
      logger.info('Fetched markets from Gamma', { count: markets.length });
      return markets;
    } catch (error) {
      this.recordFailure(error instanceof Error ? error.message : 'Unknown error');
      throw error;
    }
  }

  /**
   * Fetch a single market by condition ID
   */
  async fetchMarketByConditionId(conditionId: string): Promise<PolymarketMarket | null> {
    const cacheKey = `market_${conditionId}`;
    const cached = this.cache.get(cacheKey);
    
    if (cached && Date.now() - cached.timestamp < this.config.cacheTtl) {
      return cached.data[0] || null;
    }

    try {
      const response = await pRetry(
        () => this.client.get<{ market: PolymarketMarket }>(`/markets/${conditionId}`),
        {
          retries: this.config.retryAttempts,
          minTimeout: this.config.retryDelay,
        }
      );

      const market = response.data.market;
      
      if (market) {
        this.cache.set(cacheKey, { data: [market], timestamp: Date.now() });
      }
      
      this.recordSuccess();
      return market || null;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        this.recordSuccess();
        return null;
      }
      this.recordFailure(error instanceof Error ? error.message : 'Unknown error');
      throw error;
    }
  }

  /**
   * Fetch markets ending soon (for scheduler)
   */
  async fetchMarketsEndingSoon(hoursAhead: number = 24): Promise<PolymarketMarket[]> {
    const allMarkets = await this.fetchMarkets({ active: true, closed: false });
    const now = Date.now();
    const cutoff = now + hoursAhead * 60 * 60 * 1000;

    return allMarkets.filter(market => {
      const endTime = new Date(market.endDate).getTime();
      return endTime > now && endTime <= cutoff && !market.isResolved;
    });
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
    
    logger.error('Gamma fetcher failure', { 
      consecutiveFailures: this.health.consecutiveFailures, 
      error 
    });
  }
}

/**
 * Create default Gamma fetcher configuration
 */
export function createGammaFetcher(): GammaFetcher {
  return new GammaFetcher({
    name: 'gamma',
    baseUrl: process.env.GAMMA_API_URL || 'https://gamma-api.polymarket.com',
    timeout: 10000,
    retryAttempts: 3,
    retryDelay: 1000,
    cacheTtl: 5 * 60 * 1000, // 5 minutes
  });
}