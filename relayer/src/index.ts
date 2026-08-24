/**
 * Main entry point for the Oracle/Relayer service
 */

import { spawn } from 'child_process';
import { GammaFetcher, createGammaFetcher } from './fetchers/gamma';
import { ClobFetcher, createClobFetcher } from './fetchers/clob';
import { FinalityFetcher, createFinalityFetcher } from './fetchers/finality';
import { SecondaryFetcher, createSecondaryFetcher } from './fetchers/secondary';
import { SigningService, createSigningService } from './sign';
import { Scheduler, createScheduler } from './scheduler';
import { MarketMapping } from './types';
import { logger } from './utils/logger';

class Relayer {
  private gammaFetcher: GammaFetcher;
  private clobFetcher: ClobFetcher;
  private finalityFetcher: FinalityFetcher;
  private secondaryFetcher: SecondaryFetcher;
  private signingService: SigningService;
  private scheduler: Scheduler;
  private marketMappings: Map<number, MarketMapping> = new Map();

  constructor() {
    // Initialize fetchers
    this.gammaFetcher = createGammaFetcher();
    this.clobFetcher = createClobFetcher();
    this.finalityFetcher = createFinalityFetcher();
    this.secondaryFetcher = createSecondaryFetcher();
    this.signingService = createSigningService();
    this.scheduler = createScheduler(this.finalityFetcher, this.signingService);

    // Set up transaction submission callback
    this.scheduler.setSubmitCallback(this.submitToAlgorand.bind(this));
  }

  /**
   * Start the relayer service
   */
  async start(): Promise<void> {
    logger.info('Starting Prediction Market Relayer');
    
    // Load market mappings from database (placeholder)
    await this.loadMarketMappings();
    
    // Start scheduler
    this.scheduler.start();
    
    // Log health status periodically
    setInterval(() => this.logHealth(), 60000);
    
    logger.info('Relayer started successfully');
  }

  /**
   * Stop the relayer service
   */
  async stop(): Promise<void> {
    logger.info('Stopping relayer...');
    this.scheduler.stop();
    logger.info('Relayer stopped');
  }

  /**
   * Load market mappings from database
   * In production, this would query PostgreSQL
   */
  private async loadMarketMappings(): Promise<void> {
    logger.info('Loading market mappings...');
    
    // Placeholder - would load from database
    // For now, add a test mapping
    const testMapping: MarketMapping = {
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
    
    logger.info('Market mappings loaded', { count: this.marketMappings.size });
  }

  /**
   * Submit signed oracle submission to Algorand via Python script
   */
  private async submitToAlgorand(submission: {
    marketId: bigint;
    outcome: boolean;
    timestamp: bigint;
    signature: Uint8Array;
  }): Promise<string> {
    logger.info('Submitting oracle outcome to Algorand', {
      marketId: submission.marketId.toString(),
      outcome: submission.outcome,
      timestamp: submission.timestamp.toString(),
    });

    const config = {
      algod_address: process.env.ALGOD_ADDRESS || 'http://localhost:4001',
      algod_token: process.env.ALGOD_TOKEN || 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      app_id: parseInt(process.env.ALGORAND_APP_ID || '0'),
      sender_mnemonic: process.env.ORACLE_MNEMONIC || '',
      market_id: Number(submission.marketId),
      outcome: submission.outcome,
      timestamp: Number(submission.timestamp),
      signature_b64: Buffer.from(submission.signature).toString('base64'),
    };

    if (!config.sender_mnemonic) {
      throw new Error('ORACLE_MNEMONIC not set in environment');
    }

    const scriptPath = __dirname + '/../submit_outcome.py';
    
    return new Promise((resolve, reject) => {
      const python = spawn('python3', [scriptPath, JSON.stringify(config)]);
      
      let stdout = '';
      let stderr = '';
      
      python.stdout.on('data', (data) => {
        stdout += data.toString();
      });
      
      python.stderr.on('data', (data) => {
        stderr += data.toString();
      });
      
      python.on('close', (code) => {
        if (code !== 0) {
          logger.error('Python submission script failed', { stderr, code });
          reject(new Error(`Submission failed: ${stderr}`));
          return;
        }
        
        try {
          const result = JSON.parse(stdout.trim());
          if (result.error) {
            reject(new Error(result.error));
          } else {
            logger.info('Oracle submission successful', { txId: result.tx_id });
            resolve(result.tx_id);
          }
        } catch (e) {
          reject(new Error(`Failed to parse submission result: ${stdout}`));
        }
      });
    });
  }

  /**
   * Log health status of all components
   */
  private logHealth(): void {
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
      logger.warn('Unhealthy components detected', { components: unhealthy });
    } else {
      logger.debug('All components healthy');
    }
  }

  /**
   * Get public key for contract deployment
   */
  getOraclePublicKey(): string {
    return this.signingService.exportPublicKeyBase64();
  }

  /**
   * Manually trigger a market check
   */
  async triggerMarketCheck(marketId: number): Promise<void> {
    const mapping = this.marketMappings.get(marketId);
    if (!mapping) {
      throw new Error(`Market ${marketId} not found`);
    }

    const finality = await this.finalityFetcher.checkFinality(mapping.polymarketConditionId);
    logger.info('Manual check result', { marketId, finality });
  }
}

// Handle graceful shutdown
const relayer = new Relayer();

async function main() {
  try {
    await relayer.start();
    
    // Handle shutdown signals
    process.on('SIGINT', async () => {
      logger.info('Received SIGINT, shutting down...');
      await relayer.stop();
      process.exit(0);
    });
    
    process.on('SIGTERM', async () => {
      logger.info('Received SIGTERM, shutting down...');
      await relayer.stop();
      process.exit(0);
    });
  } catch (error) {
    logger.error('Failed to start relayer', { error });
    process.exit(1);
  }
}

main();