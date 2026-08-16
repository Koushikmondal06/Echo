"use strict";
/**
 * Secondary Reference Fetcher - Fallback source (e.g., Kalshi) for multi-oracle setups
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SecondaryFetcher = void 0;
exports.createSecondaryFetcher = createSecondaryFetcher;
const axios_1 = __importDefault(require("axios"));
const p_retry_1 = __importDefault(require("p-retry"));
const logger_1 = require("../utils/logger");
class SecondaryFetcher {
    client;
    config;
    health;
    cache = new Map();
    enabled;
    constructor(config) {
        this.config = config;
        this.enabled = process.env.SECONDARY_FETCHER_ENABLED === 'true';
        if (this.enabled && config.baseUrl) {
            this.client = axios_1.default.create({
                baseURL: config.baseUrl,
                timeout: config.timeout,
                headers: {
                    'Accept': 'application/json',
                    'User-Agent': 'PredictionMarketRelayer/1.0',
                },
            });
        }
        else {
            this.client = null;
            logger_1.logger.info('Secondary fetcher disabled (set SECONDARY_FETCHER_ENABLED=true to enable)');
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
    async fetchMarket(conditionId) {
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
        }
        catch (error) {
            this.recordFailure(error instanceof Error ? error.message : 'Unknown error');
            throw error;
        }
    }
    /**
     * Fetch from Kalshi API
     */
    async fetchFromKalshi(conditionId) {
        if (!this.client)
            return null;
        try {
            // Kalshi uses tickers, not condition IDs
            // This would need a mapping from Polymarket condition ID to Kalshi ticker
            const mapping = this.getKalshiMapping(conditionId);
            if (!mapping)
                return null;
            const response = await (0, p_retry_1.default)(() => this.client.get(`/markets/${mapping}`), {
                retries: this.config.retryAttempts,
                minTimeout: this.config.retryDelay,
            });
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
        }
        catch (error) {
            if (axios_1.default.isAxiosError(error) && error.response?.status === 404) {
                return null;
            }
            throw error;
        }
    }
    /**
     * Fetch from custom secondary endpoint
     */
    async fetchFromCustom(conditionId) {
        if (!this.client)
            return null;
        try {
            const response = await (0, p_retry_1.default)(() => this.client.get(`/markets/${conditionId}`), {
                retries: this.config.retryAttempts,
                minTimeout: this.config.retryDelay,
            });
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
        }
        catch (error) {
            if (axios_1.default.isAxiosError(error) && error.response?.status === 404) {
                return null;
            }
            throw error;
        }
    }
    /**
     * Map Polymarket condition ID to Kalshi ticker
     * In production, this would be a configurable mapping table
     */
    getKalshiMapping(conditionId) {
        // Placeholder - would be loaded from config/database
        const mappings = {
        // '0x...': 'KALSHI-TICKER',
        };
        return mappings[conditionId] || null;
    }
    /**
     * Cross-check price with primary source
     */
    async crossCheckPrice(conditionId, primaryPriceYes) {
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
    getHealth() {
        return { ...this.health };
    }
    /**
     * Clear cache
     */
    clearCache() {
        this.cache.clear();
    }
    /**
     * Enable/disable fetcher
     */
    setEnabled(enabled) {
        this.enabled = enabled;
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
        logger_1.logger.error('Secondary fetcher failure', {
            consecutiveFailures: this.health.consecutiveFailures,
            error
        });
    }
}
exports.SecondaryFetcher = SecondaryFetcher;
/**
 * Create default Secondary fetcher configuration
 */
function createSecondaryFetcher() {
    return new SecondaryFetcher({
        name: 'secondary',
        baseUrl: process.env.SECONDARY_API_URL || 'https://api.kalshi.com/trade-api/v2',
        timeout: 10000,
        retryAttempts: 2,
        retryDelay: 2000,
        cacheTtl: 5 * 60 * 1000, // 5 minutes
    });
}
//# sourceMappingURL=secondary.js.map