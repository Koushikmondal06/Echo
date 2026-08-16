"use strict";
/**
 * Signing Service - Signs (marketId, outcome, timestamp) with relayer keypair
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SigningService = void 0;
exports.createSigningService = createSigningService;
const tweetnacl_1 = __importDefault(require("tweetnacl"));
const logger_1 = require("../utils/logger");
class SigningService {
    keypair;
    health;
    constructor(keypair) {
        this.keypair = keypair;
        this.health = {
            name: 'signing',
            status: 'healthy',
            lastSuccess: null,
            lastFailure: null,
            consecutiveFailures: 0,
            lastError: null,
        };
    }
    /**
     * Generate a new ed25519 keypair
     */
    static generateKeypair() {
        const keypair = tweetnacl_1.default.sign.keyPair();
        return {
            publicKey: keypair.publicKey,
            secretKey: keypair.secretKey,
        };
    }
    /**
     * Load keypair from environment (base64 encoded)
     */
    static loadKeypairFromEnv() {
        const secretKeyB64 = process.env.ORACLE_PRIVATE_KEY;
        if (!secretKeyB64) {
            throw new Error('ORACLE_PRIVATE_KEY not set in environment');
        }
        const secretKey = Buffer.from(secretKeyB64, 'base64');
        if (secretKey.length !== 64) {
            throw new Error('Invalid private key length (expected 64 bytes)');
        }
        // Derive public key from secret key
        const keypair = tweetnacl_1.default.sign.keyPair.fromSecretKey(secretKey);
        return {
            publicKey: keypair.publicKey,
            secretKey: keypair.secretKey,
        };
    }
    /**
     * Export public key as base64 (for contract deployment)
     */
    exportPublicKeyBase64() {
        return Buffer.from(this.keypair.publicKey).toString('base64');
    }
    /**
     * Export secret key as base64 (for backup)
     */
    exportSecretKeyBase64() {
        return Buffer.from(this.keypair.secretKey).toString('base64');
    }
    /**
     * Sign an oracle submission
     * Message format: marketId (8 bytes LE) + outcome (1 byte) + timestamp (8 bytes LE)
     */
    sign(submission) {
        try {
            const message = this.encodeMessage(submission);
            const signature = tweetnacl_1.default.sign.detached(message, this.keypair.secretKey);
            this.recordSuccess();
            logger_1.logger.debug('Signed oracle submission', {
                marketId: submission.marketId.toString(),
                outcome: submission.outcome,
                timestamp: submission.timestamp.toString()
            });
            return signature;
        }
        catch (error) {
            this.recordFailure(error instanceof Error ? error.message : 'Unknown error');
            throw error;
        }
    }
    /**
     * Verify a signature (for testing)
     */
    verify(submission, signature) {
        try {
            const message = this.encodeMessage(submission);
            return tweetnacl_1.default.sign.detached.verify(message, signature, this.keypair.publicKey);
        }
        catch {
            return false;
        }
    }
    /**
     * Encode message for signing: marketId (8 bytes LE) + outcome (1 byte) + timestamp (8 bytes LE)
     */
    encodeMessage(submission) {
        const message = new Uint8Array(17); // 8 + 1 + 8
        // marketId (8 bytes, little-endian)
        let marketId = submission.marketId;
        for (let i = 0; i < 8; i++) {
            message[i] = Number(marketId & 0xffn);
            marketId >>= 8n;
        }
        // outcome (1 byte)
        message[8] = submission.outcome ? 1 : 0;
        // timestamp (8 bytes, little-endian)
        let timestamp = submission.timestamp;
        for (let i = 0; i < 8; i++) {
            message[9 + i] = Number(timestamp & 0xffn);
            timestamp >>= 8n;
        }
        return message;
    }
    /**
     * Get public key
     */
    getPublicKey() {
        return this.keypair.publicKey;
    }
    /**
     * Get current health status
     */
    getHealth() {
        return { ...this.health };
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
        logger_1.logger.error('Signing service failure', {
            consecutiveFailures: this.health.consecutiveFailures,
            error
        });
    }
}
exports.SigningService = SigningService;
/**
 * Create signing service from environment
 */
function createSigningService() {
    const keypair = SigningService.loadKeypairFromEnv();
    return new SigningService(keypair);
}
//# sourceMappingURL=index.js.map