/**
 * Market API routes
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { query } from '../db/pool';
import { MarketSummary, MarketDetail, MarketQueryParams, ApiResponse } from '../types';
import { logger } from '../utils/logger';

export async function marketRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /api/v1/markets - List markets with pagination
  fastify.get<{ Querystring: MarketQueryParams }>('/markets', async (
    request: FastifyRequest<{ Querystring: MarketQueryParams }>,
    reply: FastifyReply
  ): Promise<ApiResponse<MarketSummary[]>> => {
    try {
      const page = request.query.page || 1;
      const limit = Math.min(request.query.limit || 20, 100);
      const offset = (page - 1) * limit;
      const status = request.query.status;
      const conditionId = request.query.conditionId;

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

      // Get total count
      const countResult = await query(
        `SELECT COUNT(*) FROM market_mappings ${whereClause}`,
        params
      );
      const total = parseInt(countResult.rows[0].count);

      // Get markets
      params.push(limit, offset);
      const marketsResult = await query(
        `SELECT 
          algorand_market_id,
          polymarket_condition_id,
          polymarket_question,
          polymarket_end_date,
          status,
          resolved_outcome,
          seed_liquidity,
          b_param,
          created_at
        FROM market_mappings
        ${whereClause}
        ORDER BY created_at DESC
        LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
        params
      );

      const markets: MarketSummary[] = marketsResult.rows.map(row => ({
        algorandMarketId: row.algorand_market_id,
        polymarketConditionId: row.polymarket_condition_id,
        question: row.polymarket_question,
        endDate: row.polymarket_end_date,
        status: row.status,
        impliedPriceYes: 0.5, // Would be computed from on-chain state
        impliedPriceNo: 0.5,
        totalVolume: 0,
        totalLiquidity: row.seed_liquidity,
        resolvedOutcome: row.resolved_outcome,
      }));

      return {
        success: true,
        data: markets,
        meta: { page, limit, total },
      };
    } catch (error) {
      logger.error('Failed to list markets', { error });
      reply.code(500);
      return { success: false, error: 'Internal server error' };
    }
  });

  // GET /api/v1/markets/:marketId - Get market detail
  fastify.get<{ Params: { marketId: string } }>('/markets/:marketId', async (
    request: FastifyRequest<{ Params: { marketId: string } }>,
    reply: FastifyReply
  ): Promise<ApiResponse<MarketDetail>> => {
    try {
      const marketId = parseInt(request.params.marketId);
      if (isNaN(marketId)) {
        reply.code(400);
        return { success: false, error: 'Invalid market ID' };
      }

      const marketResult = await query(
        `SELECT * FROM market_mappings WHERE algorand_market_id = $1`,
        [marketId]
      );

      if (marketResult.rows.length === 0) {
        reply.code(404);
        return { success: false, error: 'Market not found' };
      }

      const row = marketResult.rows[0];
      const marketMappingId = row.id; // UUID

      // Get recent trades
      const tradesResult = await query(
        `SELECT * FROM trades WHERE market_mapping_id = $1 ORDER BY created_at DESC LIMIT 50`,
        [marketMappingId]
      );

      const market: MarketDetail = {
        algorandMarketId: row.algorand_market_id,
        polymarketConditionId: row.polymarket_condition_id,
        polymarketMarketId: row.polymarket_market_id,
        question: row.polymarket_question,
        endDate: row.polymarket_end_date,
        status: row.status,
        impliedPriceYes: 0.5,
        impliedPriceNo: 0.5,
        totalVolume: 0,
        totalLiquidity: row.seed_liquidity,
        polymarketResolutionCriteria: row.polymarket_resolution_criteria,
        seedLiquidity: row.seed_liquidity,
        bParam: row.b_param,
        oraclePubkey: row.oracle_pubkey.toString('base64'),
        yesAssetId: row.yes_asset_id,
        noAssetId: row.no_asset_id,
        outcomeSubmittedAt: row.outcome_submitted_at,
        disputeDeadline: row.dispute_deadline,
        settledAt: row.settled_at,
        recentTrades: tradesResult.rows.map(t => ({
          id: t.id,
          marketMappingId: t.market_mapping_id,
          userAddress: t.user_address,
          isYes: t.is_yes,
          sharesAmount: t.shares_amount,
          costPaid: t.cost_paid,
          priceAtTrade: t.price_at_trade,
          txnId: t.txn_id,
          roundNumber: t.round_number,
          createdAt: t.created_at,
        })),
      };

      return { success: true, data: market };
    } catch (error) {
      logger.error('Failed to get market detail', { error, marketId: request.params.marketId });
      reply.code(500);
      return { success: false, error: 'Internal server error' };
    }
  });

  // GET /api/v1/markets/:marketId/position - Get user position
  fastify.get<{ Params: { marketId: string }, Querystring: { userAddress: string } }>(
    '/markets/:marketId/position',
    async (
      request: FastifyRequest<{ Params: { marketId: string }; Querystring: { userAddress: string } }>,
      reply: FastifyReply
    ): Promise<ApiResponse<{ yesAmount: number; noAmount: number; totalInvested: number }>> => {
      try {
        const marketId = parseInt(request.params.marketId);
        const userAddress = request.query.userAddress;

        if (isNaN(marketId) || !userAddress) {
          reply.code(400);
          return { success: false, error: 'Invalid parameters' };
        }

        const result = await query(
          `SELECT yes_amount, no_amount, total_invested 
           FROM user_positions 
           WHERE market_mapping_id = (SELECT id FROM market_mappings WHERE algorand_market_id = $1)
           AND user_address = $2`,
          [marketId, userAddress]
        );

        if (result.rows.length === 0) {
          return { success: true, data: { yesAmount: 0, noAmount: 0, totalInvested: 0 } };
        }

        const row = result.rows[0];
        return {
          success: true,
          data: {
            yesAmount: row.yes_amount,
            noAmount: row.no_amount,
            totalInvested: row.total_invested,
          },
        };
      } catch (error) {
        logger.error('Failed to get user position', { error });
        reply.code(500);
        return { success: false, error: 'Internal server error' };
      }
    }
  );

  // GET /api/v1/markets/:marketId/trades - Get market trades
  fastify.get<{ Params: { marketId: string }, Querystring: { page?: string; limit?: string } }>(
    '/markets/:marketId/trades',
    async (
      request: FastifyRequest<{ Params: { marketId: string }; Querystring: { page?: string; limit?: string } }>,
      reply: FastifyReply
    ): Promise<ApiResponse<any[]>> => {
      try {
        const marketId = parseInt(request.params.marketId);
        const page = parseInt(request.query.page || '1');
        const limit = Math.min(parseInt(request.query.limit || '50'), 200);
        const offset = (page - 1) * limit;

        if (isNaN(marketId)) {
          reply.code(400);
          return { success: false, error: 'Invalid market ID' };
        }

        const countResult = await query(
          `SELECT COUNT(*) FROM trades WHERE market_mapping_id = (SELECT id FROM market_mappings WHERE algorand_market_id = $1)`,
          [marketId]
        );
        const total = parseInt(countResult.rows[0].count);

        const tradesResult = await query(
          `SELECT * FROM trades 
           WHERE market_mapping_id = (SELECT id FROM market_mappings WHERE algorand_market_id = $1)
           ORDER BY created_at DESC
           LIMIT $2 OFFSET $3`,
          [marketId, limit, offset]
        );

        return {
          success: true,
          data: tradesResult.rows,
          meta: { page, limit, total },
        };
      } catch (error) {
        logger.error('Failed to get market trades', { error });
        reply.code(500);
        return { success: false, error: 'Internal server error' };
      }
    }
  );
}