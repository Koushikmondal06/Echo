"use strict";
/**
 * Main entry point for the Oracle/Relayer service
 */
Object.defineProperty(exports, "__esModule", { value: true });
const gamma_1 = require("./fetchers/gamma");
const clob_1 = require("./fetchers/clob");
const finality_1 = require("./fetchers/finality");
const secondary_1 = require("./fetchers/secondary");
const sign_1 = require("./sign");
const scheduler_1 = require("./scheduler");
const logger_1 = require("./utils/logger");
class Relayer {
    gammaFetcher;
    clobFetcher;
    finalityFetcher;
    secondaryFetcher;
    signingService;
    scheduler;
    marketMappings = new Map();
    constructor() {
        // Initialize fetchers
        this.gammaFetcher = (0, gamma_1.createGammaFetcher)();
        this.clobFetcher = (0, clob_1.createClobFetcher)();
        this.finalityFetcher = (0, finality_1.createFinalityFetcher)();
        this.secondaryFetcher = (0, secondary_1.createSecondaryFetcher)();
        this.signingService = (0, sign_1.createSigningService)();
        this.scheduler = (0, scheduler_1.createScheduler)(this.finalityFetcher, this.signingService);
        // Set up transaction submission callback
        this.scheduler.setSubmitCallback(this.submitToAlgorand.bind(this));
    }
    /**
     * Start the relayer service
     */
    async start() {
        logger_1.logger.info('Starting Prediction Market Relayer');
        // Load market mappings from database (placeholder)
        await this.loadMarketMappings();
        // Start scheduler
        this.scheduler.start();
        // Log health status periodically
        setInterval(() => this.logHealth(), 60000);
        logger_1.logger.info('Relayer started successfully');
    }
    /**
     * Stop the relayer service
     */
    async stop() {
        logger_1.logger.info('Stopping relayer...');
        this.scheduler.stop();
        logger_1.logger.info('Relayer stopped');
    }
    /**
     * Load market mappings from database
     * In production, this would query PostgreSQL
     */
    async loadMarketMappings() {
        logger_1.logger.info('Loading market mappings...');
        // Placeholder - would load from database
        // For now, add a test mapping
        const testMapping = {
            algorandMarketId: 0,
            algorandAppId: parseInt(process.env.ALGORAND_APP_ID || '0'),
            yesAssetId: 0,
            noAssetId: 0,
            polymarketMarketId: 'test-market',
            polymarketConditionId: '0x1234567890abcdef',
            polymarketQuestion: 'Test Market',
            polymarketResolutionCriteria: 'Test criteria',
            polymarketEndDate: new Date(Date.now() + 86400000),
            seedLiquidity: 1000000000,
            bParam: 1000000000000,
            status: 'active',
            oraclePubkey: this.signingService.getPublicKey(),
        };
        this.marketMappings.set(0, testMapping);
        this.scheduler.addMarketMapping(testMapping);
        logger_1.logger.info('Market mappings loaded', { count: this.marketMappings.size });
    }
    /**
     * Submit signed oracle submission to Algorand
     * This would use algosdk to send the transaction
     */
    async submitToAlgorand(submission) {
        logger_1.logger.info('Submitting oracle outcome to Algorand', {
            marketId: submission.marketId.toString(),
            outcome: submission.outcome,
            timestamp: submission.timestamp.toString(),
        });
        // Placeholder - would use algosdk to call submit_outcome on the contract
        // const txId = await algodClient.sendTransaction(signedTxn);
        // For now, return mock tx ID
        return 'mock-tx-id-' + Date.now();
    }
    /**
     * Log health status of all components
     */
    logHealth() {
        const health = {
            gamma: this.gammaFetcher.getHealth(),
            clob: this.clobFetcher.getHealth(),
            finality: this.finalityFetcher.getHealth(),
            secondary: this.secondaryFetcher.getHealth(),
            signing: this.signingService.getHealth(),
            scheduler: this.scheduler.getStatus(),
        };
        const unhealthy = Object.entries(health)
            .filter(([_, h]) => h && 'status' in h && h.status !== 'healthy')
            .map(([name]) => name);
        if (unhealthy.length > 0) {
            logger_1.logger.warn('Unhealthy components detected', { components: unhealthy });
        }
        else {
            logger_1.logger.debug('All components healthy');
        }
    }
    /**
     * Get public key for contract deployment
     */
    getOraclePublicKey() {
        return this.signingService.exportPublicKeyBase64();
    }
    /**
     * Manually trigger a market check
     */
    async triggerMarketCheck(marketId) {
        const mapping = this.marketMappings.get(marketId);
        if (!mapping) {
            throw new Error(`Market ${marketId} not found`);
        }
        const finality = await this.finalityFetcher.checkFinality(mapping.polymarketConditionId);
        logger_1.logger.info('Manual check result', { marketId, finality });
    }
}
// Handle graceful shutdown
const relayer = new Relayer();
async function main() {
    try {
        await relayer.start();
        // Handle shutdown signals
        process.on('SIGINT', async () => {
            logger_1.logger.info('Received SIGINT, shutting down...');
            await relayer.stop();
            process.exit(0);
        });
        process.on('SIGTERM', async () => {
            logger_1.logger.info('Received SIGTERM, shutting down...');
            await relayer.stop();
            process.exit(0);
        });
    }
    catch (error) {
        logger_1.logger.error('Failed to start relayer', { error });
        process.exit(1);
    }
}
main();
//# sourceMappingURL=index.js.map