/**
 * Secondary Reference Fetcher - Fallback source (e.g., Kalshi) for multi-oracle setups
 */

import axios, { AxiosInstance } from 'axios';
import pRetry from 'p-retry';
import { FetcherConfig, FetcherHealth } from '../types';
import { logger } from '../utils/logger';

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

export class SecondaryFetcher {
  private client: AxiosInstance | null;
  private config: FetcherConfig;
  private health: FetcherHealth;
  private cache: Map<string, { data: SecondaryMarketData; timestamp: number }> = new Map();
  private enabled: boolean;

  constructor(config: FetcherConfig) {
    this.config = config;
    this.enabled = process.env.SECONDARY_FETCHER_ENABLED === 'true';
    
    if (this.enabled && config.baseUrl) {
      this.client = axios.create({
        baseURL: config.baseUrl,
        timeout: config.timeout,
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'PredictionMarketRelayer/1.0',
        },
      });
    } else {
      this.client = null;
      logger.info('Secondary fetcher disabled (set SECONDARY_FETCHER_ENABLED=true to enable)');
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
   * Fetch market data from secondary source
   */
  async fetchMarket(conditionId: string): Promise<SecondaryMarketData | null> {
    if (!this.enabled || !this.client) {
      return null;
    }

    const cacheKey = `secondary_${conditionId}`;
    const cached = this.cache.get(cacheKey);
    
    if (cached && Date.now() - cached.timestamp < this.config.cacheTtl) {
      return cached.data;
    }

    try {
      // Try Kalshi format first
      const data = await this.fetchFromKalshi(conditionId);
      
      if (data) {
        this.cache.set(cacheKey, { data, timestamp: Date.now() });
        this.recordSuccess();
        return data;
      }

      // Try custom endpoint
      const customData = await this.fetchFromCustom(conditionId);
      if (customData) {
        this.cache.set(cacheKey, { data: customData, timestamp: Date.now() });
        this.recordSuccess();
        return customData;
      }

      this.recordSuccess();
      return null;
    } catch (error) {
      this.recordFailure(error instanceof Error ? error.message : 'Unknown error');
      throw error;
    }
  }

  /**
   * Fetch from Kalshi API
   */
  private async fetchFromKalshi(conditionId: string): Promise<SecondaryMarketData | null> {
    if (!this.client) return null;

    try {
      // Kalshi uses tickers, not condition IDs
      // This would need a mapping from Polymarket condition ID to Kalshi ticker
      const mapping = this.getKalshiMapping(conditionId);
      if (!mapping) return null;

      const response = await pRetry(
        () => this.client!.get<KalshiMarket>(`/markets/${mapping}`),
        {
          retries: this.config.retryAttempts,
          minTimeout: this.config.retryDelay,
        }
      );

      const market = response.data;
      
      return {
        source: 'kalshi',
        conditionId,
        priceYes: market.yes_price,
        priceNo: market.no_price,
        volume: market.volume,
        endTime: new Date(market.close_time).getTime(),
        isResolved: market.status === 'settled',
        outcome: market.result === 'yes' ? true : market.result === 'no' ? false : undefined,
        lastUpdated: Date.now(),
      };
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Fetch from custom secondary endpoint
   */
  private async fetchFromCustom(conditionId: string): Promise<SecondaryMarketData | null> {
    if (!this.client) return null;

    try {
      const response = await pRetry(
        () => this.client!.get(`/markets/${conditionId}`),
        {
          retries: this.config.retryAttempts,
          minTimeout: this.config.retryDelay,
        }
      );

      const market = response.data;
      
      return {
        source: 'custom',
        conditionId,
        priceYes: market.priceYes || market.yesPrice || 0.5,
        priceNo: market.priceNo || market.noPrice || 0.5,
        volume: market.volume || 0,
        endTime: market.endTime || market.endDate ? new Date(market.endDate).getTime() : 0,
        isResolved: market.isResolved || false,
        outcome: market.outcome !== undefined ? market.outcome : undefined,
        lastUpdated: Date.now(),
      };
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Map Polymarket condition ID to Kalshi ticker
   * In production, this would be a configurable mapping table
   */
  private getKalshiMapping(conditionId: string): string | null {
    // Placeholder - would be loaded from config/database
    const mappings: Record<string, string> = {
      // '0x...': 'KALSHI-TICKER',
    };
    return mappings[conditionId] || null;
  }

  /**
   * Cross-check price with primary source
   */
  async crossCheckPrice(
    conditionId: string, 
    primaryPriceYes: number
  ): Promise<{ 
    secondaryPrice: number | null; 
    deviation: number | null;
    agreement: boolean;
  }> {
    const secondary = await this.fetchMarket(conditionId);
    
    if (!secondary) {
      return { secondaryPrice: null, deviation: null, agreement: true };
    }

    const deviation = Math.abs(secondary.priceYes - primaryPriceYes);
    const agreement = deviation < 0.05; // Within 5%

    return {
      secondaryPrice: secondary.priceYes,
      deviation,
      agreement,
    };
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

  /**
   * Enable/disable fetcher
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
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
    
    logger.error('Secondary fetcher failure', { 
      consecutiveFailures: this.health.consecutiveFailures, 
      error 
    });
  }
}

/**
 * Create default Secondary fetcher configuration
 */
export function createSecondaryFetcher(): SecondaryFetcher {
  return new SecondaryFetcher({
    name: 'secondary',
    baseUrl: process.env.SECONDARY_API_URL || 'https://api.kalshi.com/trade-api/v2',
    timeout: 10000,
    retryAttempts: 2,
    retryDelay: 2000,
    cacheTtl: 5 * 60 * 1000, // 5 minutes
  });
}