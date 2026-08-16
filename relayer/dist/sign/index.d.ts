/**
 * Signing Service - Signs (marketId, outcome, timestamp) with relayer keypair
 */
import { OracleSubmission, FetcherHealth } from '../types';
export interface SigningKeypair {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
}
export declare class SigningService {
    private keypair;
    private health;
    constructor(keypair: SigningKeypair);
    /**
     * Generate a new ed25519 keypair
     */
    static generateKeypair(): SigningKeypair;
    /**
     * Load keypair from environment (base64 encoded)
     */
    static loadKeypairFromEnv(): SigningKeypair;
    /**
     * Export public key as base64 (for contract deployment)
     */
    exportPublicKeyBase64(): string;
    /**
     * Export secret key as base64 (for backup)
     */
    exportSecretKeyBase64(): string;
    /**
     * Sign an oracle submission
     * Message format: marketId (8 bytes LE) + outcome (1 byte) + timestamp (8 bytes LE)
     */
    sign(submission: OracleSubmission): Uint8Array;
    /**
     * Verify a signature (for testing)
     */
    verify(submission: OracleSubmission, signature: Uint8Array): boolean;
    /**
     * Encode message for signing: marketId (8 bytes LE) + outcome (1 byte) + timestamp (8 bytes LE)
     */
    private encodeMessage;
    /**
     * Get public key
     */
    getPublicKey(): Uint8Array;
    /**
     * Get current health status
     */
    getHealth(): FetcherHealth;
    private recordSuccess;
    private recordFailure;
}
/**
 * Create signing service from environment
 */
export declare function createSigningService(): SigningService;
//# sourceMappingURL=index.d.ts.map