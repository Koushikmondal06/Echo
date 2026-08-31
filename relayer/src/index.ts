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
import { getMarketMappingsForResolution, updateMarketMapping, listActiveMarketMappings } from './db/market-mappings';
import { closeRelayerPool } from './db/pool';

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
    await closeRelayerPool();
    logger.info('Relayer stopped');
  }

  /**
   * Load market mappings from database
   */
  private async loadMarketMappings(): Promise<void> {
    logger.info('Loading market mappings from database...');
    
    try {
      // Load active markets that need monitoring
      const activeMappings = await listActiveMarketMappings();
      
      for (const mapping of activeMappings) {
        this.marketMappings.set(mapping.algorandMarketId, mapping);
        this.scheduler.addMarketMapping(mapping);
      }
      
      // Enable test mode for finality fetcher with our test market
      const testConditionId = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
      this.finalityFetcher.enableTestMode(new Map([
        [testConditionId, { outcome: true, disputeStatus: 'none' }], // YES outcome
      ]));
      logger.info('Finality fetcher test mode enabled', { conditionId: testConditionId });
      
      logger.info('Market mappings loaded from database', { count: this.marketMappings.size });
    } catch (error) {
      logger.error('Failed to load market mappings from database', { error });
      throw error;
    }
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
    
    return new Promise(async (resolve, reject) => {
      const python = spawn('python3', [scriptPath, JSON.stringify(config)]);
      
      let stdout = '';
      let stderr = '';
      
      python.stdout.on('data', (data) => {
        stdout += data.toString();
      });
      
      python.stderr.on('data', (data) => {
        stderr += data.toString();
      });
      
      python.on('close', async (code) => {
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
            
            // Update market mapping in database
            await updateMarketMapping(Number(submission.marketId), {
              status: 'resolved',
              resolvedOutcome: submission.outcome,
              outcomeSubmittedAt: new Date(Number(submission.timestamp)),
              disputeDeadline: new Date(Date.now() + 86400000), // 24 hours
            });
            
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