/**
 * Signing Service - Signs (marketId, outcome, timestamp) with relayer keypair
 */

import nacl from 'tweetnacl';
import { encodeUTF8, decodeUTF8 } from 'tweetnacl-util';
import { OracleSubmission, FetcherHealth } from '../types';
import { logger } from '../utils/logger';
import { encodeAddress } from 'algosdk';

export interface SigningKeypair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export class SigningService {
  private keypair: SigningKeypair;
  private health: FetcherHealth;

  constructor(keypair: SigningKeypair) {
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
  static generateKeypair(): SigningKeypair {
    const keypair = nacl.sign.keyPair();
    return {
      publicKey: keypair.publicKey,
      secretKey: keypair.secretKey,
    };
  }

  /**
   * Load keypair from environment (base64 encoded)
   */
  static loadKeypairFromEnv(): SigningKeypair {
    const secretKeyB64 = process.env.ORACLE_PRIVATE_KEY;
    if (!secretKeyB64) {
      throw new Error('ORACLE_PRIVATE_KEY not set in environment');
    }

    const secretKey = Buffer.from(secretKeyB64, 'base64');
    if (secretKey.length !== 64) {
      throw new Error('Invalid private key length (expected 64 bytes)');
    }

    // Derive public key from secret key
    const keypair = nacl.sign.keyPair.fromSecretKey(secretKey);
    return {
      publicKey: keypair.publicKey,
      secretKey: keypair.secretKey,
    };
  }

  /**
   * Export public key as base64 (for contract deployment)
   */
  exportPublicKeyBase64(): string {
    return Buffer.from(this.keypair.publicKey).toString('base64');
  }

  /**
   * Export secret key as base64 (for backup)
   */
  exportSecretKeyBase64(): string {
    return Buffer.from(this.keypair.secretKey).toString('base64');
  }

  /**
   * Sign an oracle submission
   * Message format: marketId (8 bytes LE) + outcome (1 byte) + timestamp (8 bytes LE)
   */
  sign(submission: OracleSubmission): Uint8Array {
    try {
      const message = this.encodeMessage(submission);
      const signature = nacl.sign.detached(message, this.keypair.secretKey);
      
      this.recordSuccess();
      logger.debug('Signed oracle submission', { 
        marketId: submission.marketId.toString(),
        outcome: submission.outcome,
        timestamp: submission.timestamp.toString()
      });
      
      return signature;
    } catch (error) {
      this.recordFailure(error instanceof Error ? error.message : 'Unknown error');
      throw error;
    }
  }

  /**
   * Verify a signature (for testing)
   */
  verify(submission: OracleSubmission, signature: Uint8Array): boolean {
    try {
      const message = this.encodeMessage(submission);
      return nacl.sign.detached.verify(message, signature, this.keypair.publicKey);
    } catch {
      return false;
    }
  }

  /**
   * Encode message for signing: marketId (8 bytes BE) + outcome (1 byte) + timestamp (8 bytes BE)
   * Matches AVM's itob() which uses big-endian
   */
  private encodeMessage(submission: OracleSubmission): Uint8Array {
    const message = new Uint8Array(17); // 8 + 1 + 8
    
    // marketId (8 bytes, big-endian) - matches AVM itob()
    let marketId = submission.marketId;
    for (let i = 7; i >= 0; i--) {
      message[i] = Number(marketId & 0xffn);
      marketId >>= 8n;
    }
    
    // outcome (1 byte)
    message[8] = submission.outcome ? 1 : 0;
    
    // timestamp (8 bytes, big-endian) - matches AVM itob()
    let timestamp = submission.timestamp;
    for (let i = 16; i >= 9; i--) {
      message[i] = Number(timestamp & 0xffn);
      timestamp >>= 8n;
    }
    
    return message;
  }

  /**
   * Get public key
   */
  getPublicKey(): Uint8Array {
    return this.keypair.publicKey;
  }

  /**
   * Export public key as base64 (for contract deployment)
   */
  exportPublicKeyBase64(): string {
    return Buffer.from(this.keypair.publicKey).toString('base64');
  }

  /**
   * Export public key as Algorand address (for accounts array)
   */
  exportPublicKeyAsAddress(): string {
    return encodeAddress(this.keypair.publicKey);
  }

  /**
   * Get current health status
   */
  getHealth(): FetcherHealth {
    return { ...this.health };
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
    
    logger.error('Signing service failure', { 
      consecutiveFailures: this.health.consecutiveFailures, 
      error 
    });
  }
}

/**
 * Create signing service from environment
 */
export function createSigningService(): SigningService {
  const keypair = SigningService.loadKeypairFromEnv();
  return new SigningService(keypair);
}