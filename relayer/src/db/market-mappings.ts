/**
 * Market Mapping Database Service for Relayer
 * CRUD operations for market_mappings table
 */

import { queryRelayer } from './pool';
import { MarketMapping } from '../types';

export interface CreateMarketMappingInput {
  algorandMarketId: number;
  algorandAppId: number;
  yesAssetId: number;
  noAssetId: number;
  polymarketMarketId: string;
  polymarketConditionId: string;
  polymarketQuestion: string;
  polymarketResolutionCriteria: string;
  polymarketEndDate: Date;
  seedLiquidity: number;
  bParam: number;
  oraclePubkey: Buffer; // 32-byte ed25519 public key
}

export interface UpdateMarketMappingInput {
  status?: 'active' | 'resolved' | 'disputed' | 'settled';
  resolvedOutcome?: boolean;
  outcomeSubmittedAt?: Date;
  disputeDeadline?: Date;
  settledAt?: Date;
}

function mapRowToMarketMapping(row: any): MarketMapping {
  return {
    algorandMarketId: row.algorand_market_id,
    algorandAppId: row.algorand_app_id,
    yesAssetId: row.yes_asset_id,
    noAssetId: row.no_asset_id,
    polymarketMarketId: row.polymarket_market_id,
    polymarketConditionId: row.polymarket_condition_id,
    polymarketQuestion: row.polymarket_question,
    polymarketResolutionCriteria: row.polymarket_resolution_criteria,
    polymarketEndDate: row.polymarket_end_date,
    seedLiquidity: row.seed_liquidity,
    bParam: row.b_param,
    status: row.status,
    resolvedOutcome: row.resolved_outcome,
    outcomeSubmittedAt: row.outcome_submitted_at,
    disputeDeadline: row.dispute_deadline,
    oraclePubkey: row.oracle_pubkey,
  };
}

export async function createMarketMapping(input: CreateMarketMappingInput): Promise<MarketMapping> {
  const result = await queryRelayer(
    `INSERT INTO market_mappings (
      algorand_market_id, algorand_app_id, yes_asset_id, no_asset_id,
      polymarket_market_id, polymarket_condition_id, polymarket_question,
      polymarket_resolution_criteria, polymarket_end_date,
      seed_liquidity, b_param, oracle_pubkey
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    RETURNING *`,
    [
      input.algorandMarketId,
      input.algorandAppId,
      input.yesAssetId,
      input.noAssetId,
      input.polymarketMarketId,
      input.polymarketConditionId,
      input.polymarketQuestion,
      input.polymarketResolutionCriteria,
      input.polymarketEndDate,
      input.seedLiquidity,
      input.bParam,
      input.oraclePubkey,
    ]
  );
  return mapRowToMarketMapping(result.rows[0]);
}

export async function getMarketMappingByAlgorandId(algorandMarketId: number): Promise<MarketMapping | null> {
  const result = await queryRelayer(
    `SELECT * FROM market_mappings WHERE algorand_market_id = $1`,
    [algorandMarketId]
  );
  if (result.rows.length === 0) return null;
  return mapRowToMarketMapping(result.rows[0]);
}

export async function getMarketMappingByConditionId(conditionId: string): Promise<MarketMapping | null> {
  const result = await queryRelayer(
    `SELECT * FROM market_mappings WHERE polymarket_condition_id = $1`,
    [conditionId]
  );
  if (result.rows.length === 0) return null;
  return mapRowToMarketMapping(result.rows[0]);
}

export async function listActiveMarketMappings(): Promise<MarketMapping[]> {
  const result = await queryRelayer(
    `SELECT * FROM market_mappings WHERE status = 'active' AND polymarket_end_date > NOW()
     ORDER BY polymarket_end_date ASC`
  );
  return result.rows.map(mapRowToMarketMapping);
}

export async function getMarketMappingsForResolution(): Promise<MarketMapping[]> {
  const result = await queryRelayer(
    `SELECT * FROM market_mappings 
     WHERE status = 'active' 
     AND polymarket_end_date <= NOW()
     AND resolved_outcome IS NULL
     ORDER BY polymarket_end_date ASC`
  );
  return result.rows.map(mapRowToMarketMapping);
}

export async function updateMarketMapping(
  algorandMarketId: number,
  input: UpdateMarketMappingInput
): Promise<MarketMapping | null> {
  const updates: string[] = [];
  const params: any[] = [];
  let paramIndex = 1;

  if (input.status !== undefined) {
    updates.push(`status = $${paramIndex++}`);
    params.push(input.status);
  }
  if (input.resolvedOutcome !== undefined) {
    updates.push(`resolved_outcome = $${paramIndex++}`);
    params.push(input.resolvedOutcome);
  }
  if (input.outcomeSubmittedAt !== undefined) {
    updates.push(`outcome_submitted_at = $${paramIndex++}`);
    params.push(input.outcomeSubmittedAt);
  }
  if (input.disputeDeadline !== undefined) {
    updates.push(`dispute_deadline = $${paramIndex++}`);
    params.push(input.disputeDeadline);
  }
  if (input.settledAt !== undefined) {
    updates.push(`settled_at = $${paramIndex++}`);
    params.push(input.settledAt);
  }

  if (updates.length === 0) {
    return getMarketMappingByAlgorandId(algorandMarketId);
  }

  updates.push(`updated_at = NOW()`);
  params.push(algorandMarketId);

  const result = await queryRelayer(
    `UPDATE market_mappings SET ${updates.join(', ')} WHERE algorand_market_id = $${paramIndex} RETURNING *`,
    params
  );

  if (result.rows.length === 0) return null;
  return mapRowToMarketMapping(result.rows[0]);
}