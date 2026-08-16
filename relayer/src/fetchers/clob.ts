/**
 * CLOB Price Fetcher - Fetches live order book prices from Polymarket CLOB API
 */

import axios, { AxiosInstance } from 'axios';
import pRetry from 'p-retry';
import { PolymarketClobPrice, PolymarketOrderBook, FetcherConfig, FetcherHealth } from '../types';
import { logger } from '../utils/logger';

export class ClobFetcher {
  private client: AxiosInstance;
  private config: FetcherConfig;
  private health: FetcherHealth;
  private priceCache: Map<string, { data: PolymarketOrderBook; timestamp: number }> = new Map();

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
   * Fetch order book for a specific market
   */
  async fetchOrderBook(marketId: string): Promise<PolymarketOrderBook> {
    const cacheKey = `orderbook_${marketId}`;
    const cached = this.priceCache.get(cacheKey);
    
    if (cached && Date.now() - cached.timestamp < this.config.cacheTtl) {
      logger.debug('Returning cached order book', { marketId });
      return cached.data;
    }

    try {
      const response = await pRetry(
        () => this.client.get<{ bids: PolymarketClobPrice[]; asks: PolymarketClobPrice[] }>(
          `/books/${marketId}`
        ),
        {
          retries: this.config.retryAttempts,
          minTimeout: this.config.retryDelay,
        }
      );

      const bids = response.data.bids || [];
      const asks = response.data.asks || [];

      // Calculate mid price and spread
      const bestBid = bids.length > 0 ? parseFloat(bids[0].price) : 0;
      const bestAsk = asks.length > 0 ? parseFloat(asks[0].price) : 0;
      const midPrice = (bestBid + bestAsk) / 2;
      const spread = bestAsk > 0 && bestBid > 0 ? (bestAsk - bestBid) / midPrice : 0;

      const orderBook: PolymarketOrderBook = {
        bids,
        asks,
        midPrice,
        spread,
      };

      this.priceCache.set(cacheKey, { data: orderBook, timestamp: Date.now() });
      this.recordSuccess();

      logger.debug('Fetched order book', { marketId, midPrice, spread });
      return orderBook;
    } catch (error) {
      this.recordFailure(error instanceof Error ? error.message : 'Unknown error');
      throw error;
    }
  }

  /**
   * Fetch current price for a market (mid price)
   */
  async fetchPrice(marketId: string): Promise<number> {
    const orderBook = await this.fetchOrderBook(marketId);
    return orderBook.midPrice;
  }

  /**
   * Fetch prices for multiple markets
   */
  async fetchPrices(marketIds: string[]): Promise<Map<string, number>> {
    const prices = new Map<string, number>();
    
    // Fetch in parallel with concurrency limit
    const concurrency = 5;
    for (let i = 0; i < marketIds.length; i += concurrency) {
      const batch = marketIds.slice(i, i + concurrency);
      const results = await Promise.allSettled(
        batch.map(async (id) => {
          const price = await this.fetchPrice(id);
          return { id, price };
        })
      );

      for (const result of results) {
        if (result.status === 'fulfilled') {
          prices.set(result.value.id, result.value.price);
        } else {
          logger.warn('Failed to fetch price', { error: result.reason });
        }
      }
    }

    return prices;
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
    this.priceCache.clear();
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
    
    logger.error('CLOB fetcher failure', { 
      consecutiveFailures: this.health.consecutiveFailures, 
      error 
    });
  }
}

/**
 * Create default CLOB fetcher configuration
 */
export function createClobFetcher(): ClobFetcher {
  return new ClobFetcher({
    name: 'clob',
    baseUrl: process.env.CLOB_API_URL || 'https://clob.polymarket.com',
    timeout: 5000,
    retryAttempts: 3,
    retryDelay: 500,
    cacheTtl: 30 * 1000, // 30 seconds
  });
}