/**
 * Algorand Indexer integration for historical data
 */

import algosdk from 'algosdk';
import { query, withTransaction } from '../db/pool';
import { MarketMapping } from '../types';
import { logger } from '../utils/logger';

export interface IndexerConfig {
  indexerUrl: string;
  indexerToken: string;
  appId: number;
  startRound: number;
}

// Transaction type from algosdk v2 indexer
interface IndexerTransaction {
  id: string;
  'confirmed-round': number;
  sender: string;
  'application-transaction'?: {
    'application-id': number;
    'application-args'?: string[];
  };
  'inner-txns'?: IndexerTransaction[];
  'payment-transaction'?: { amount: number };
  'asset-transfer-transaction'?: { 'asset-id': number; amount: number };
  'txn-type': string;
}

export class IndexerService {
  private client: algosdk.Indexer;
  private config: IndexerConfig;
  private lastProcessedRound: number;

  constructor(config: IndexerConfig) {
    this.config = config;
    this.client = new algosdk.Indexer(config.indexerToken, config.indexerUrl);
    this.lastProcessedRound = config.startRound;
  }

  /**
   * Sync transactions for a specific market
   */
  async syncMarket(marketMapping: MarketMapping): Promise<void> {
    logger.info('Syncing market', { marketId: marketMapping.algorandMarketId });

    try {
      // Get application transactions
      const response = await this.client
        .searchForTransactions()
        .applicationID(marketMapping.algorandAppId)
        .round(this.lastProcessedRound)
        .limit(1000)
        .do();

      const transactions = (response.transactions as IndexerTransaction[]) || [];
      logger.info('Found transactions', { count: transactions.length });

      for (const txn of transactions) {
        await this.processTransaction(txn, marketMapping);
      }

      // Update last processed round
      if (transactions.length > 0) {
        const maxRound = Math.max(...transactions.map((t: IndexerTransaction) => t['confirmed-round'] || 0));
        this.lastProcessedRound = maxRound + 1;
      }
    } catch (error) {
      logger.error('Failed to sync market', { error, marketId: marketMapping.algorandMarketId });
      throw error;
    }
  }

  /**
   * Process a single transaction
   */
  private async processTransaction(
    txn: IndexerTransaction,
    marketMapping: MarketMapping
  ): Promise<void> {
    const appCall = txn['application-transaction'];
    if (!appCall) return;

    const appArgs = appCall['application-args'] || [];
    if (appArgs.length === 0) return;

    // Decode method selector (first 4 bytes)
    const methodSelector = Buffer.from(appArgs[0], 'base64').slice(0, 4).toString('hex');
    
    const sender = txn.sender;
    const round = txn['confirmed-round'] || 0;
    const txId = txn.id;

    switch (methodSelector) {
      case this.getMethodSelector('buy_position'):
        await this.processBuyPosition(txn, appCall, marketMapping, sender, round, txId);
        break;
      case this.getMethodSelector('submit_outcome'):
        await this.processSubmitOutcome(txn, appCall, marketMapping, sender, round, txId);
        break;
      case this.getMethodSelector('dispute_outcome'):
        await this.processDisputeOutcome(txn, appCall, marketMapping, sender, round, txId);
        break;
      case this.getMethodSelector('claim_payout'):
        await this.processClaimPayout(txn, appCall, marketMapping, sender, round, txId);
        break;
    }
  }

  /**
   * Process buy_position transaction
   */
  private async processBuyPosition(
    txn: IndexerTransaction,
    appCall: any,
    marketMapping: MarketMapping,
    sender: string,
    round: number,
    txId: string
  ): Promise<void> {
    // Extract inner transactions for asset transfers and payments
    const innerTxns = txn['inner-txns'] || [];
    
    let paymentAmount = 0;
    let assetTransferred = 0;
    let isYes = false;

    for (const inner of innerTxns) {
      if (inner['txn-type'] === 'pay') {
        paymentAmount = inner['payment-transaction']?.amount || 0;
      } else if (inner['txn-type'] === 'axfer') {
        const assetId = inner['asset-transfer-transaction']?.['asset-id'];
        const amount = inner['asset-transfer-transaction']?.amount || 0;
        
        if (assetId === marketMapping.yesAssetId) {
          isYes = true;
          assetTransferred = amount;
        } else if (assetId === marketMapping.noAssetId) {
          isYes = false;
          assetTransferred = amount;
        }
      }
    }

    if (paymentAmount === 0 || assetTransferred === 0) return;

    // Calculate price at trade (implied probability)
    // This would ideally come from contract state at that round
    const priceAtTrade = 0.5; // Placeholder

    await withTransaction(async (client) => {
      // Insert trade
      await client.query(
        `INSERT INTO trades (market_mapping_id, user_address, is_yes, shares_amount, cost_paid, price_at_trade, txn_id, round_number)
         VALUES ((SELECT id FROM market_mappings WHERE algorand_market_id = $1), $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (txn_id) DO NOTHING`,
        [marketMapping.algorandMarketId, sender, isYes, assetTransferred, paymentAmount, priceAtTrade, txId, round]
      );

      // Update user position
      await client.query(
        `INSERT INTO user_positions (market_mapping_id, user_address, yes_amount, no_amount, total_invested)
         VALUES ((SELECT id FROM market_mappings WHERE algorand_market_id = $1), $2, $3, $4, $5)
         ON CONFLICT (market_mapping_id, user_address) DO UPDATE SET
           yes_amount = user_positions.yes_amount + EXCLUDED.yes_amount,
           no_amount = user_positions.no_amount + EXCLUDED.no_amount,
           total_invested = user_positions.total_invested + EXCLUDED.total_invested,
           last_updated = NOW()`,
        [marketMapping.algorandMarketId, sender, isYes ? assetTransferred : 0, isYes ? 0 : assetTransferred, paymentAmount]
      );
    });

    logger.debug('Processed buy_position', { sender, isYes, amount: assetTransferred, txId });
  }

  /**
   * Process submit_outcome transaction
   */
  private async processSubmitOutcome(
    txn: IndexerTransaction,
    appCall: any,
    marketMapping: MarketMapping,
    sender: string,
    round: number,
    txId: string
  ): Promise<void> {
    const appArgs = appCall['application-args'] || [];
    if (appArgs.length < 3) return; // market_id, outcome, signature

    const outcome = this.decodeBool(appArgs[1]);
    const signature = appArgs[2];

    await withTransaction(async (client) => {
      // Update market status
      await client.query(
        `UPDATE market_mappings 
         SET status = 'resolved', resolved_outcome = $1, outcome_submitted_at = NOW(), dispute_deadline = NOW() + INTERVAL '24 hours'
         WHERE algorand_market_id = $2`,
        [outcome, marketMapping.algorandMarketId]
      );

      // Log oracle submission
      await client.query(
        `INSERT INTO oracle_submissions (market_mapping_id, outcome, signature, txn_id, round_number, is_valid)
         VALUES ((SELECT id FROM market_mappings WHERE algorand_market_id = $1), $2, $3, $4, $5, $6)
         ON CONFLICT (market_mapping_id, txn_id) DO NOTHING`,
        [marketMapping.algorandMarketId, outcome, signature, txId, round, true]
      );
    });

    logger.info('Processed submit_outcome', { marketId: marketMapping.algorandMarketId, outcome, txId });
  }

  /**
   * Process dispute_outcome transaction
   */
  private async processDisputeOutcome(
    txn: IndexerTransaction,
    appCall: any,
    marketMapping: MarketMapping,
    sender: string,
    round: number,
    txId: string
  ): Promise<void> {
    await withTransaction(async (client) => {
      await client.query(
        `UPDATE market_mappings SET status = 'disputed' WHERE algorand_market_id = $1`,
        [marketMapping.algorandMarketId]
      );

      await client.query(
        `INSERT INTO disputes (market_mapping_id, initiated_by, txn_id, round_number)
         VALUES ((SELECT id FROM market_mappings WHERE algorand_market_id = $1), $2, $3, $4)`,
        [marketMapping.algorandMarketId, sender, txId, round]
      );
    });

    logger.info('Processed dispute_outcome', { marketId: marketMapping.algorandMarketId, sender, txId });
  }

  /**
   * Process claim_payout transaction
   */
  private async processClaimPayout(
    txn: IndexerTransaction,
    appCall: any,
    marketMapping: MarketMapping,
    sender: string,
    round: number,
    txId: string
  ): Promise<void> {
    // Update market to settled if all positions claimed
    await withTransaction(async (client) => {
      // Check if all winning positions have been claimed
      const result = await client.query(
        `SELECT COUNT(*) as unclaimed FROM user_positions up
         JOIN market_mappings m ON up.market_mapping_id = m.id
         WHERE m.algorand_market_id = $1
         AND ((m.resolved_outcome = true AND up.yes_amount > 0) OR (m.resolved_outcome = false AND up.no_amount > 0))`,
        [marketMapping.algorandMarketId]
      );

      if (parseInt(result.rows[0].unclaimed) === 0) {
        await client.query(
          `UPDATE market_mappings SET status = 'settled', settled_at = NOW() WHERE algorand_market_id = $1`,
          [marketMapping.algorandMarketId]
        );
      }
    });

    logger.debug('Processed claim_payout', { marketId: marketMapping.algorandMarketId, sender, txId });
  }

  /**
   * Get method selector for ABI method
   */
  private getMethodSelector(methodName: string): string {
    // This should match the contract's ABI method selectors
    // For Algorand Python (ARC-4), selectors are first 4 bytes of SHA-512/256 of method signature
    const selectors: Record<string, string> = {
      'buy_position': '7b2d3e1a', // placeholder
      'submit_outcome': 'a1b2c3d4',
      'dispute_outcome': 'd4c3b2a1',
      'claim_payout': 'e5f6a7b8',
    };
    return selectors[methodName] || '';
  }

  /**
   * Decode boolean from base64 encoded byte
   */
  private decodeBool(base64: string): boolean {
    const bytes = Buffer.from(base64, 'base64');
    return bytes[0] === 1;
  }

  /**
   * Get last processed round
   */
  getLastProcessedRound(): number {
    return this.lastProcessedRound;
  }

  /**
   * Set last processed round (for recovery)
   */
  setLastProcessedRound(round: number): void {
    this.lastProcessedRound = round;
  }
}

/**
 * Create indexer service from environment
 */
export function createIndexerService(): IndexerService {
  return new IndexerService({
    indexerUrl: process.env.ALGORAND_INDEXER_URL || 'https://testnet-idx.algonode.cloud',
    indexerToken: process.env.ALGORAND_INDEXER_TOKEN || '',
    appId: parseInt(process.env.ALGORAND_APP_ID || '0'),
    startRound: parseInt(process.env.INDEXER_START_ROUND || '0'),
  });
}