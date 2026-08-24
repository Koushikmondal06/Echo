/**
 * Admin dashboard API routes
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { query } from '../db/pool';
import { FetcherHealth, ApiResponse } from '../types';
import { logger } from '../utils/logger';

export async function adminRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /api/v1/admin/health - Overall system health
  fastify.get('/admin/health', async (
    _request: FastifyRequest,
    reply: FastifyReply
  ): Promise<ApiResponse<{
    database: string;
    fetchers: FetcherHealth[];
    markets: { active: number; resolved: number; disputed: number; settled: number };
  }>> => {
    try {
      // Check database
      await query('SELECT 1');
      const dbHealth = 'healthy';

      // Get fetcher health
      const fetchersResult = await query('SELECT * FROM fetcher_health');
      const fetchers: FetcherHealth[] = fetchersResult.rows.map(row => ({
        id: row.id,
        fetcherName: row.fetcher_name,
        status: row.status,
        lastSuccessAt: row.last_success_at,
        lastFailureAt: row.last_failure_at,
        consecutiveFailures: row.consecutive_failures,
        lastError: row.last_error,
        updatedAt: row.updated_at,
      }));

      // Get market counts by status
      const marketsResult = await query(
        `SELECT status, COUNT(*) as count FROM market_mappings GROUP BY status`
      );
      const marketCounts = { active: 0, resolved: 0, disputed: 0, settled: 0 };
      for (const row of marketsResult.rows) {
        if (row.status in marketCounts) {
          marketCounts[row.status as keyof typeof marketCounts] = parseInt(row.count);
        }
      }

      return {
        success: true,
        data: {
          database: dbHealth,
          fetchers,
          markets: marketCounts,
        },
      };
    } catch (error) {
      logger.error('Health check failed', { error });
      reply.code(500);
      return { success: false, error: 'Health check failed' };
    }
  });

  // GET /api/v1/admin/mappings - Market mapping table health
  fastify.get('/admin/mappings', async (
    _request: FastifyRequest,
    reply: FastifyReply
  ): Promise<ApiResponse<any[]>> => {
    try {
      const result = await query(
        `SELECT 
          id,
          algorand_market_id,
          polymarket_condition_id,
          polymarket_question,
          polymarket_end_date,
          status,
          seed_liquidity,
          b_param,
          created_at,
          updated_at
        FROM market_mappings
        ORDER BY created_at DESC`
      );

      return { success: true, data: result.rows };
    } catch (error) {
      logger.error('Failed to get mappings', { error });
      reply.code(500);
      return { success: false, error: 'Internal server error' };
    }
  });

  // GET /api/v1/admin/pending - Markets pending resolution
  fastify.get('/admin/pending', async (
    _request: FastifyRequest,
    reply: FastifyReply
  ): Promise<ApiResponse<any[]>> => {
    try {
      const result = await query(
        `SELECT 
          m.algorand_market_id,
          m.polymarket_condition_id,
          m.polymarket_question,
          m.polymarket_end_date,
          m.status,
          m.outcome_submitted_at,
          m.dispute_deadline,
          m.resolved_outcome
        FROM market_mappings m
        WHERE m.status IN ('active', 'resolved', 'disputed')
        ORDER BY m.polymarket_end_date ASC`
      );

      return { success: true, data: result.rows };
    } catch (error) {
      logger.error('Failed to get pending markets', { error });
      reply.code(500);
      return { success: false, error: 'Internal server error' };
    }
  });

  // GET /api/v1/admin/disputes - Active disputes
  fastify.get('/admin/disputes', async (
    _request: FastifyRequest,
    reply: FastifyReply
  ): Promise<ApiResponse<any[]>> => {
    try {
      const result = await query(
        `SELECT 
          d.*,
          m.polymarket_condition_id,
          m.polymarket_question
        FROM disputes d
        JOIN market_mappings m ON d.market_mapping_id = m.id
        WHERE d.resolved_at IS NULL
        ORDER BY d.created_at DESC`
      );

      return { success: true, data: result.rows };
    } catch (error) {
      logger.error('Failed to get disputes', { error });
      reply.code(500);
      return { success: false, error: 'Internal server error' };
    }
  });

  // GET /api/v1/admin/liquidity - Liquidity health
  fastify.get('/admin/liquidity', async (
    _request: FastifyRequest,
    reply: FastifyReply
  ): Promise<ApiResponse<any[]>> => {
    try {
      const result = await query(
        `SELECT 
          m.algorand_market_id,
          m.polymarket_condition_id,
          m.polymarket_question,
          m.seed_liquidity,
          m.b_param,
          m.status,
          COALESCE(SUM(t.cost_paid), 0) as total_volume
        FROM market_mappings m
        LEFT JOIN trades t ON t.market_mapping_id = m.id
        WHERE m.status = 'active'
        GROUP BY m.id
        ORDER BY total_volume DESC`
      );

      // Add liquidity health flags
      const data = result.rows.map(row => ({
        ...row,
        liquidityHealth: row.total_volume < row.seed_liquidity * 0.1 ? 'low' : 
                         row.total_volume < row.seed_liquidity * 0.5 ? 'medium' : 'healthy',
        volumeToLiquidityRatio: row.seed_liquidity > 0 ? row.total_volume / row.seed_liquidity : 0,
      }));

      return { success: true, data };
    } catch (error) {
      logger.error('Failed to get liquidity health', { error });
      reply.code(500);
      return { success: false, error: 'Internal server error' };
    }
  });

  // GET /api/v1/admin/oracle-status - Oracle status
  fastify.get('/admin/oracle-status', async (
    _request: FastifyRequest,
    reply: FastifyReply
  ): Promise<ApiResponse<any[]>> => {
    try {
      const result = await query(
        `SELECT 
          m.algorand_market_id,
          m.polymarket_condition_id,
          m.polymarket_question,
          m.status,
          m.outcome_submitted_at,
          m.dispute_deadline,
          m.resolved_outcome,
          os.submitted_at as oracle_submitted_at,
          os.outcome as oracle_outcome,
          os.is_valid as oracle_valid
        FROM market_mappings m
        LEFT JOIN oracle_submissions os ON os.market_mapping_id = m.id
        WHERE m.status IN ('active', 'resolved', 'disputed')
        ORDER BY m.polymarket_end_date ASC`
      );

      return { success: true, data: result.rows };
    } catch (error) {
      logger.error('Failed to get oracle status', { error });
      reply.code(500);
      return { success: false, error: 'Internal server error' };
    }
  });
}