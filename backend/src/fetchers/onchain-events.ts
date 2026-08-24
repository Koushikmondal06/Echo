/**
 * On-Chain Event Fetcher - Listens for contract events via algod
 */

import algosdk from 'algosdk';
import { query, withTransaction } from '../db/pool';
import { logger } from '../utils/logger';

export interface EventFetcherConfig {
  algodUrl: string;
  algodToken: string;
  appId: number;
  startRound: number;
}

export interface ContractEvent {
  type: 'market_created' | 'position_bought' | 'outcome_submitted' | 'disputed' | 'payout_claimed' | 'settled';
  marketId: number;
  data: Record<string, any>;
  round: number;
  txId: string;
  timestamp: number;
}

export class OnChainEventFetcher {
  private client: algosdk.Algodv2;
  private config: EventFetcherConfig;
  private lastProcessedRound: number;
  private isRunning = false;
  private pollInterval: NodeJS.Timeout | null = null;
  private eventHandlers: Map<string, (event: ContractEvent) => Promise<void>> = new Map();

  constructor(config: EventFetcherConfig) {
    this.config = config;
    this.client = new algosdk.Algodv2(config.algodToken, config.algodUrl);
    this.lastProcessedRound = config.startRound;
  }

  /**
   * Register event handler
   */
  on(eventType: string, handler: (event: ContractEvent) => Promise<void>): void {
    this.eventHandlers.set(eventType, handler);
  }

  /**
   * Start polling for events
   */
  async start(pollIntervalMs: number = 5000): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    logger.info('Starting on-chain event fetcher', { startRound: this.lastProcessedRound });

    // Initial catch-up
    await this.catchUp();

    // Start polling
    this.pollInterval = setInterval(async () => {
      try {
        await this.poll();
      } catch (error) {
        logger.error('Event fetcher poll error', { error });
      }
    }, pollIntervalMs);
  }

  /**
   * Stop polling
   */
  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.isRunning = false;
    logger.info('Stopped on-chain event fetcher');
  }

  /**
   * Catch up to current round
   */
  private async catchUp(): Promise<void> {
    const status = await this.client.status().do();
    const currentRound = status['last-round'];
    
    if (currentRound > this.lastProcessedRound) {
      logger.info('Catching up', { from: this.lastProcessedRound, to: currentRound });
      await this.processRoundRange(this.lastProcessedRound, currentRound);
      this.lastProcessedRound = currentRound;
    }
  }

  /**
   * Poll for new blocks
   */
  private async poll(): Promise<void> {
    const status = await this.client.status().do();
    const currentRound = status['last-round'];

    if (currentRound > this.lastProcessedRound) {
      await this.processRoundRange(this.lastProcessedRound + 1, currentRound);
      this.lastProcessedRound = currentRound;
    }
  }

  /**
   * Process a range of rounds
   */
  private async processRoundRange(fromRound: number, toRound: number): Promise<void> {
    for (let round = fromRound; round <= toRound; round++) {
      try {
        const block = await this.client.block(round).do();
        const transactions = block.block?.txns || [];

        for (const txn of transactions) {
          await this.processTransaction(txn, round);
        }
      } catch (error) {
        logger.error('Failed to process round', { round, error });
      }
    }
  }

  /**
   * Process a single transaction for events
   */
  private async processTransaction(txn: any, round: number): Promise<void> {
    // Check if it's an app call to our contract
    if (txn.txn?.txn?.apid !== this.config.appId) return;

    const appCall = txn.txn?.txn?.apaa || [];
    if (appCall.length === 0) return;

    // Decode method selector
    const methodSelector = Buffer.from(appCall[0], 'base64').slice(0, 4).toString('hex');
    
    let eventType: ContractEvent['type'] | null = null;
    let eventData: Record<string, any> = {};

    switch (methodSelector) {
      case 'create_market_selector': // Would match actual selector
        eventType = 'market_created';
        eventData = { creator: txn.txn.txn.snd };
        break;
      case 'buy_position_selector':
        eventType = 'position_bought';
        // Parse inner txns for details
        eventData = { buyer: txn.txn.txn.snd };
        break;
      case 'submit_outcome_selector':
        eventType = 'outcome_submitted';
        eventData = { submitter: txn.txn.txn.snd };
        break;
      case 'dispute_outcome_selector':
        eventType = 'disputed';
        eventData = { disputer: txn.txn.txn.snd };
        break;
      case 'claim_payout_selector':
        eventType = 'payout_claimed';
        eventData = { claimant: txn.txn.txn.snd };
        break;
    }

    if (eventType) {
      const event: ContractEvent = {
        type: eventType,
        marketId: 0, // Would extract from app args
        data: eventData,
        round,
        txId: txn.txn?.txn?.id || '',
        timestamp: Date.now(),
      };

      await this.emitEvent(event);
    }
  }

  /**
   * Emit event to handlers and store in database
   */
  private async emitEvent(event: ContractEvent): Promise<void> {
    // Store in database for admin dashboard
    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO on_chain_events (event_type, market_id, event_data, round_number, tx_id, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [event.type, event.marketId, JSON.stringify(event.data), event.round, event.txId, new Date(event.timestamp)]
      );
    });

    // Call registered handler
    const handler = this.eventHandlers.get(event.type);
    if (handler) {
      try {
        await handler(event);
      } catch (error) {
        logger.error('Event handler error', { eventType: event.type, error });
      }
    }

    logger.debug('Emitted event', { type: event.type, round: event.round, txId: event.txId });
  }

  /**
   * Get current status
   */
  getStatus(): { running: boolean; lastProcessedRound: number } {
    return {
      running: this.isRunning,
      lastProcessedRound: this.lastProcessedRound,
    };
  }
}

/**
 * Create event fetcher from environment
 */
export function createEventFetcher(): OnChainEventFetcher {
  return new OnChainEventFetcher({
    algodUrl: process.env.ALGORAND_ALGOD_URL || 'https://testnet-api.algonode.cloud',
    algodToken: process.env.ALGORAND_ALGOD_TOKEN || '',
    appId: parseInt(process.env.ALGORAND_APP_ID || '0'),
    startRound: parseInt(process.env.EVENT_FETCHER_START_ROUND || '0'),
  });
}