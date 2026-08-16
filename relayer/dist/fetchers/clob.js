"use strict";
/**
 * CLOB Price Fetcher - Fetches live order book prices from Polymarket CLOB API
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ClobFetcher = void 0;
exports.createClobFetcher = createClobFetcher;
const axios_1 = __importDefault(require("axios"));
const p_retry_1 = __importDefault(require("p-retry"));
const logger_1 = require("../utils/logger");
class ClobFetcher {
    client;
    config;
    health;
    priceCache = new Map();
    constructor(config) {
        this.config = config;
        this.client = axios_1.default.create({
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
    async fetchOrderBook(marketId) {
        const cacheKey = `orderbook_${marketId}`;
        const cached = this.priceCache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < this.config.cacheTtl) {
            logger_1.logger.debug('Returning cached order book', { marketId });
            return cached.data;
        }
        try {
            const response = await (0, p_retry_1.default)(() => this.client.get(`/books/${marketId}`), {
                retries: this.config.retryAttempts,
                minTimeout: this.config.retryDelay,
            });
            const bids = response.data.bids || [];
            const asks = response.data.asks || [];
            // Calculate mid price and spread
            const bestBid = bids.length > 0 ? parseFloat(bids[0].price) : 0;
            const bestAsk = asks.length > 0 ? parseFloat(asks[0].price) : 0;
            const midPrice = (bestBid + bestAsk) / 2;
            const spread = bestAsk > 0 && bestBid > 0 ? (bestAsk - bestBid) / midPrice : 0;
            const orderBook = {
                bids,
                asks,
                midPrice,
                spread,
            };
            this.priceCache.set(cacheKey, { data: orderBook, timestamp: Date.now() });
            this.recordSuccess();
            logger_1.logger.debug('Fetched order book', { marketId, midPrice, spread });
            return orderBook;
        }
        catch (error) {
            this.recordFailure(error instanceof Error ? error.message : 'Unknown error');
            throw error;
        }
    }
    /**
     * Fetch current price for a market (mid price)
     */
    async fetchPrice(marketId) {
        const orderBook = await this.fetchOrderBook(marketId);
        return orderBook.midPrice;
    }
    /**
     * Fetch prices for multiple markets
     */
    async fetchPrices(marketIds) {
        const prices = new Map();
        // Fetch in parallel with concurrency limit
        const concurrency = 5;
        for (let i = 0; i < marketIds.length; i += concurrency) {
            const batch = marketIds.slice(i, i + concurrency);
            const results = await Promise.allSettled(batch.map(async (id) => {
                const price = await this.fetchPrice(id);
                return { id, price };
            }));
            for (const result of results) {
                if (result.status === 'fulfilled') {
                    prices.set(result.value.id, result.value.price);
                }
                else {
                    logger_1.logger.warn('Failed to fetch price', { error: result.reason });
                }
            }
        }
        return prices;
    }
    /**
     * Get current health status
     */
    getHealth() {
        return { ...this.health };
    }
    /**
     * Clear cache
     */
    clearCache() {
        this.priceCache.clear();
    }
    recordSuccess() {
        this.health.status = 'healthy';
        this.health.lastSuccess = new Date();
        this.health.consecutiveFailures = 0;
        this.health.lastError = null;
    }
    recordFailure(error) {
        this.health.lastFailure = new Date();
        this.health.consecutiveFailures++;
        this.health.lastError = error;
        if (this.health.consecutiveFailures >= 3) {
            this.health.status = 'down';
        }
        else if (this.health.consecutiveFailures >= 1) {
            this.health.status = 'degraded';
        }
        logger_1.logger.error('CLOB fetcher failure', {
            consecutiveFailures: this.health.consecutiveFailures,
            error
        });
    }
}
exports.ClobFetcher = ClobFetcher;
/**
 * Create default CLOB fetcher configuration
 */
function createClobFetcher() {
    return new ClobFetcher({
        name: 'clob',
        baseUrl: process.env.CLOB_API_URL || 'https://clob.polymarket.com',
        timeout: 5000,
        retryAttempts: 3,
        retryDelay: 500,
        cacheTtl: 30 * 1000, // 30 seconds
    });
}
//# sourceMappingURL=clob.js.map