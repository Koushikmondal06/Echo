/**
 * Market Mapping Database Service
 * CRUD operations for market_mappings table
 */

import { query, getClient } from '../db/pool';
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
    id: row.id,
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
    settledAt: row.settled_at,
    oraclePubkey: row.oracle_pubkey.toString('base64'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createMarketMapping(input: CreateMarketMappingInput): Promise<MarketMapping> {
  const result = await query(
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
  const result = await query(
    `SELECT * FROM market_mappings WHERE algorand_market_id = $1`,
    [algorandMarketId]
  );
  if (result.rows.length === 0) return null;
  return mapRowToMarketMapping(result.rows[0]);
}

export async function getMarketMappingByConditionId(conditionId: string): Promise<MarketMapping | null> {
  const result = await query(
    `SELECT * FROM market_mappings WHERE polymarket_condition_id = $1`,
    [conditionId]
  );
  if (result.rows.length === 0) return null;
  return mapRowToMarketMapping(result.rows[0]);
}

export async function getMarketMappingById(id: string): Promise<MarketMapping | null> {
  const result = await query(
    `SELECT * FROM market_mappings WHERE id = $1`,
    [id]
  );
  if (result.rows.length === 0) return null;
  return mapRowToMarketMapping(result.rows[0]);
}

export async function listMarketMappings(
  options: {
    status?: string;
    conditionId?: string;
    page?: number;
    limit?: number;
  } = {}
): Promise<{ markets: MarketMapping[]; total: number }> {
  const { status, conditionId, page = 1, limit = 20 } = options;
  const offset = (page - 1) * limit;

  let whereClause = 'WHERE 1=1';
  const params: any[] = [];
  let paramIndex = 1;

  if (status) {
    whereClause += ` AND status = $${paramIndex++}`;
    params.push(status);
  }
  if (conditionId) {
    whereClause += ` AND polymarket_condition_id = $${paramIndex++}`;
    params.push(conditionId);
  }

  const countResult = await query(
    `SELECT COUNT(*) FROM market_mappings ${whereClause}`,
    params
  );
  const total = parseInt(countResult.rows[0].count);

  params.push(limit, offset);
  const result = await query(
    `SELECT * FROM market_mappings ${whereClause}
     ORDER BY created_at DESC
     LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
    params
  );

  return {
    markets: result.rows.map(mapRowToMarketMapping),
    total,
  };
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

  const result = await query(
    `UPDATE market_mappings SET ${updates.join(', ')} WHERE algorand_market_id = $${paramIndex} RETURNING *`,
    params
  );

  if (result.rows.length === 0) return null;
  return mapRowToMarketMapping(result.rows[0]);
}

export async function deleteMarketMapping(algorandMarketId: number): Promise<boolean> {
  const result = await query(
    `DELETE FROM market_mappings WHERE algorand_market_id = $1`,
    [algorandMarketId]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function getActiveMarketMappings(): Promise<MarketMapping[]> {
  const result = await query(
    `SELECT * FROM market_mappings WHERE status = 'active' AND polymarket_end_date > NOW()
     ORDER BY polymarket_end_date ASC`
  );
  return result.rows.map(mapRowToMarketMapping);
}

export async function getMarketMappingsForResolution(): Promise<MarketMapping[]> {
  const result = await query(
    `SELECT * FROM market_mappings 
     WHERE status = 'active' 
     AND polymarket_end_date <= NOW()
     AND resolved_outcome IS NULL
     ORDER BY polymarket_end_date ASC`
  );
  return result.rows.map(mapRowToMarketMapping);
}