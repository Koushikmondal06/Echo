/**
 * Liquidity/Health Fetcher - Derives thin-liquidity flags from CLOB feed + on-chain volume
 */

import { query } from '../db/pool';
import { logger } from '../utils/logger';

export interface LiquidityHealthConfig {
  clobApiUrl: string;
  checkIntervalMinutes: number;
  lowVolumeThreshold: number; // Ratio of on-chain volume to seed liquidity
}

export interface MarketLiquidityHealth {
  algorandMarketId: number;
  polymarketConditionId: string;
  seedLiquidity: number;
  bParam: number;
  onChainVolume: number;
  clobPrice?: number;
  clobSpread?: number;
  volumeToLiquidityRatio: number;
  health: 'healthy' | 'medium' | 'low' | 'critical';
  lastChecked: Date;
}

export class LiquidityHealthFetcher {
  private config: LiquidityHealthConfig;
  private isRunning = false;
  private intervalId: NodeJS.Timeout | null = null;

  constructor(config: LiquidityHealthConfig) {
    this.config = config;
  }

  /**
   * Start periodic health checks
   */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    logger.info('Starting liquidity health fetcher');

    // Initial check
    this.checkAllMarkets().catch(err => logger.error('Initial liquidity check failed', { error: err }));

    // Periodic checks
    this.intervalId = setInterval(() => {
      this.checkAllMarkets().catch(err => logger.error('Liquidity check failed', { error: err }));
    }, this.config.checkIntervalMinutes * 60 * 1000);
  }

  /**
   * Stop health checks
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
    logger.info('Stopped liquidity health fetcher');
  }

  /**
   * Check liquidity health for all active markets
   */
  async checkAllMarkets(): Promise<void> {
    try {
      // Get active markets with their on-chain volume
      const marketsResult = await query(
        `SELECT 
          m.algorand_market_id,
          m.polymarket_condition_id,
          m.seed_liquidity,
          m.b_param,
          COALESCE(SUM(t.cost_paid), 0) as on_chain_volume
        FROM market_mappings m
        LEFT JOIN trades t ON t.market_mapping_id = m.id
        WHERE m.status = 'active'
        GROUP BY m.id`
      );

      for (const row of marketsResult.rows) {
        await this.checkMarketHealth(row);
      }
    } catch (error) {
      logger.error('Failed to check market liquidity', { error });
    }
  }

  /**
   * Check liquidity health for a single market
   */
  private async checkMarketHealth(row: any): Promise<void> {
    const marketId = row.algorand_market_id;
    const seedLiquidity = row.seed_liquidity;
    const onChainVolume = parseFloat(row.on_chain_volume) || 0;
    const volumeRatio = seedLiquidity > 0 ? onChainVolume / seedLiquidity : 0;

    // Determine health status
    let health: MarketLiquidityHealth['health'];
    if (volumeRatio < 0.01) {
      health = 'critical';
    } else if (volumeRatio < 0.05) {
      health = 'low';
    } else if (volumeRatio < 0.2) {
      health = 'medium';
    } else {
      health = 'healthy';
    }

    // TODO: Fetch CLOB price and spread for additional metrics
    // This would integrate with the CLOB fetcher

    const healthData: MarketLiquidityHealth = {
      algorandMarketId: marketId,
      polymarketConditionId: row.polymarket_condition_id,
      seedLiquidity,
      bParam: row.b_param,
      onChainVolume,
      volumeToLiquidityRatio: volumeRatio,
      health,
      lastChecked: new Date(),
    };

    // Store in database
    await query(
      `INSERT INTO market_liquidity_health 
       (algorand_market_id, polymarket_condition_id, seed_liquidity, b_param, 
        on_chain_volume, volume_to_liquidity_ratio, health, last_checked)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (algorand_market_id) DO UPDATE SET
         on_chain_volume = EXCLUDED.on_chain_volume,
         volume_to_liquidity_ratio = EXCLUDED.volume_to_liquidity_ratio,
         health = EXCLUDED.health,
         last_checked = EXCLUDED.last_checked`,
      [
        healthData.algorandMarketId,
        healthData.polymarketConditionId,
        healthData.seedLiquidity,
        healthData.bParam,
        healthData.onChainVolume,
        healthData.volumeToLiquidityRatio,
        healthData.health,
        healthData.lastChecked,
      ]
    );

    // Log alerts for critical/low health
    if (health === 'critical' || health === 'low') {
      logger.warn('Low liquidity detected', { 
        marketId, 
        health, 
        volumeRatio: volumeRatio.toFixed(4),
        seedLiquidity,
        onChainVolume
      });
    }
  }

  /**
   * Get liquidity health for a specific market
   */
  async getMarketHealth(marketId: number): Promise<MarketLiquidityHealth | null> {
    const result = await query<MarketLiquidityHealth>(
      `SELECT * FROM market_liquidity_health WHERE algorand_market_id = $1`,
      [marketId]
    );
    return result.rows[0] || null;
  }

  /**
   * Get all markets with liquidity health
   */
  async getAllMarketsHealth(): Promise<MarketLiquidityHealth[]> {
    const result = await query<MarketLiquidityHealth>(
      `SELECT * FROM market_liquidity_health ORDER BY last_checked DESC`
    );
    return result.rows;
  }
}

/**
 * Create liquidity health fetcher from environment
 */
export function createLiquidityHealthFetcher(): LiquidityHealthFetcher {
  return new LiquidityHealthFetcher({
    clobApiUrl: process.env.CLOB_API_URL || 'https://clob.polymarket.com',
    checkIntervalMinutes: parseInt(process.env.LIQUIDITY_CHECK_INTERVAL_MINUTES || '15'),
    lowVolumeThreshold: parseFloat(process.env.LOW_VOLUME_THRESHOLD || '0.05'),
  });
}