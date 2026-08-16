/**
 * Tests for Signing Service
 */

import { SigningService, SigningKeypair } from './index';

describe('SigningService', () => {
  let keypair: SigningKeypair;
  let service: SigningService;

  beforeEach(() => {
    keypair = SigningService.generateKeypair();
    service = new SigningService(keypair);
  });

  test('generates valid keypair', () => {
    expect(keypair.publicKey).toBeInstanceOf(Uint8Array);
    expect(keypair.secretKey).toBeInstanceOf(Uint8Array);
    expect(keypair.publicKey.length).toBe(32);
    expect(keypair.secretKey.length).toBe(64);
  });

  test('signs and verifies submission', () => {
    const submission = {
      marketId: 123n,
      outcome: true,
      timestamp: BigInt(Math.floor(Date.now() / 1000)),
      signature: new Uint8Array(64),
    };

    const signature = service.sign(submission);
    expect(signature).toBeInstanceOf(Uint8Array);
    expect(signature.length).toBe(64);

    const verified = service.verify(submission, signature);
    expect(verified).toBe(true);
  });

  test('rejects invalid signature', () => {
    const submission = {
      marketId: 123n,
      outcome: true,
      timestamp: BigInt(Math.floor(Date.now() / 1000)),
      signature: new Uint8Array(64),
    };

    const signature = service.sign(submission);
    
    // Tamper with signature
    signature[0] ^= 0xff;
    
    const verified = service.verify(submission, signature);
    expect(verified).toBe(false);
  });

  test('rejects wrong outcome', () => {
    const submission = {
      marketId: 123n,
      outcome: true,
      timestamp: BigInt(Math.floor(Date.now() / 1000)),
      signature: new Uint8Array(64),
    };

    const signature = service.sign(submission);
    
    // Verify with different outcome
    const wrongSubmission = { ...submission, outcome: false };
    const verified = service.verify(wrongSubmission, signature);
    expect(verified).toBe(false);
  });

  test('rejects wrong market ID', () => {
    const submission = {
      marketId: 123n,
      outcome: true,
      timestamp: BigInt(Math.floor(Date.now() / 1000)),
      signature: new Uint8Array(64),
    };

    const signature = service.sign(submission);
    
    const wrongSubmission = { ...submission, marketId: 456n };
    const verified = service.verify(wrongSubmission, signature);
    expect(verified).toBe(false);
  });

  test('exports public key as base64', () => {
    const publicKeyB64 = service.exportPublicKeyBase64();
    expect(typeof publicKeyB64).toBe('string');
    expect(publicKeyB64.length).toBeGreaterThan(0);
    
    // Verify it decodes correctly
    const decoded = Buffer.from(publicKeyB64, 'base64');
    expect(new Uint8Array(decoded)).toEqual(keypair.publicKey);
  });

  test('exports secret key as base64', () => {
    const secretKeyB64 = service.exportSecretKeyBase64();
    expect(typeof secretKeyB64).toBe('string');
    expect(secretKeyB64.length).toBeGreaterThan(0);
    
    const decoded = Buffer.from(secretKeyB64, 'base64');
    expect(new Uint8Array(decoded)).toEqual(keypair.secretKey);
  });

  test('health status starts healthy', () => {
    const health = service.getHealth();
    expect(health.status).toBe('healthy');
    expect(health.consecutiveFailures).toBe(0);
  });
});