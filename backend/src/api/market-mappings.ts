/**
 * Market Mapping CRUD API routes
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  createMarketMapping,
  getMarketMappingByAlgorandId,
  getMarketMappingByConditionId,
  getMarketMappingById,
  listMarketMappings,
  updateMarketMapping,
  deleteMarketMapping,
  CreateMarketMappingInput,
  UpdateMarketMappingInput,
} from '../db/market-mappings';
import { ApiResponse, MarketMapping } from '../types';
import { logger } from '../utils/logger';

export async function marketMappingRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /api/v1/market-mappings - Create a new market mapping
  fastify.post<{ Body: CreateMarketMappingInput }>('/market-mappings', async (
    request: FastifyRequest<{ Body: CreateMarketMappingInput }>,
    reply: FastifyReply
  ): Promise<ApiResponse<MarketMapping>> => {
    try {
      // Convert base64 oraclePubkey to buffer if provided as string
      const input = { ...request.body };
      if (typeof input.oraclePubkey === 'string') {
        (input as any).oraclePubkey = Buffer.from(input.oraclePubkey, 'base64');
      }

      const mapping = await createMarketMapping(input);
      logger.info('Market mapping created', { algorandMarketId: mapping.algorandMarketId });
      return { success: true, data: mapping };
    } catch (error: any) {
      logger.error('Failed to create market mapping', { error: error.message, body: request.body });
      if (error.code === '23505') { // Unique violation
        reply.code(409);
        return { success: false, error: 'Market mapping already exists (duplicate condition ID or market ID)' };
      }
      reply.code(500);
      return { success: false, error: 'Internal server error' };
    }
  });

  // GET /api/v1/market-mappings - List market mappings with pagination
  fastify.get<{ Querystring: { status?: string; conditionId?: string; page?: string; limit?: string } }>(
    '/market-mappings',
    async (
      request: FastifyRequest<{ Querystring: { status?: string; conditionId?: string; page?: string; limit?: string } }>,
      reply: FastifyReply
    ): Promise<ApiResponse<MarketMapping[]>> => {
      try {
        const page = parseInt(request.query.page || '1');
        const limit = Math.min(parseInt(request.query.limit || '20'), 100);
        const { status, conditionId } = request.query;

        const result = await listMarketMappings({ status, conditionId, page, limit });
        return { success: true, data: result.markets, meta: { page, limit, total: result.total } };
      } catch (error) {
        logger.error('Failed to list market mappings', { error });
        reply.code(500);
        return { success: false, error: 'Internal server error' };
      }
    }
  );

  // GET /api/v1/market-mappings/:id - Get market mapping by UUID
  fastify.get<{ Params: { id: string } }>('/market-mappings/:id', async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply
  ): Promise<ApiResponse<MarketMapping>> => {
    try {
      const mapping = await getMarketMappingById(request.params.id);
      if (!mapping) {
        reply.code(404);
        return { success: false, error: 'Market mapping not found' };
      }
      return { success: true, data: mapping };
    } catch (error) {
      logger.error('Failed to get market mapping', { error, id: request.params.id });
      reply.code(500);
      return { success: false, error: 'Internal server error' };
    }
  });

  // GET /api/v1/market-mappings/algorand/:marketId - Get market mapping by Algorand market ID
  fastify.get<{ Params: { marketId: string } }>('/market-mappings/algorand/:marketId', async (
    request: FastifyRequest<{ Params: { marketId: string } }>,
    reply: FastifyReply
  ): Promise<ApiResponse<MarketMapping>> => {
    try {
      const marketId = parseInt(request.params.marketId);
      if (isNaN(marketId)) {
        reply.code(400);
        return { success: false, error: 'Invalid market ID' };
      }

      const mapping = await getMarketMappingByAlgorandId(marketId);
      if (!mapping) {
        reply.code(404);
        return { success: false, error: 'Market mapping not found' };
      }
      return { success: true, data: mapping };
    } catch (error) {
      logger.error('Failed to get market mapping by Algorand ID', { error, marketId: request.params.marketId });
      reply.code(500);
      return { success: false, error: 'Internal server error' };
    }
  });

  // GET /api/v1/market-mappings/condition/:conditionId - Get market mapping by Polymarket condition ID
  fastify.get<{ Params: { conditionId: string } }>('/market-mappings/condition/:conditionId', async (
    request: FastifyRequest<{ Params: { conditionId: string } }>,
    reply: FastifyReply
  ): Promise<ApiResponse<MarketMapping>> => {
    try {
      const mapping = await getMarketMappingByConditionId(request.params.conditionId);
      if (!mapping) {
        reply.code(404);
        return { success: false, error: 'Market mapping not found' };
      }
      return { success: true, data: mapping };
    } catch (error) {
      logger.error('Failed to get market mapping by condition ID', { error, conditionId: request.params.conditionId });
      reply.code(500);
      return { success: false, error: 'Internal server error' };
    }
  });

  // PATCH /api/v1/market-mappings/:marketId - Update market mapping
  fastify.patch<{ Params: { marketId: string }; Body: UpdateMarketMappingInput }>(
    '/market-mappings/:marketId',
    async (
      request: FastifyRequest<{ Params: { marketId: string }; Body: UpdateMarketMappingInput }>,
      reply: FastifyReply
    ): Promise<ApiResponse<MarketMapping>> => {
      try {
        const marketId = parseInt(request.params.marketId);
        if (isNaN(marketId)) {
          reply.code(400);
          return { success: false, error: 'Invalid market ID' };
        }

        const mapping = await updateMarketMapping(marketId, request.body);
        if (!mapping) {
          reply.code(404);
          return { success: false, error: 'Market mapping not found' };
        }

        logger.info('Market mapping updated', { marketId, updates: request.body });
        return { success: true, data: mapping };
      } catch (error) {
        logger.error('Failed to update market mapping', { error, marketId: request.params.marketId });
        reply.code(500);
        return { success: false, error: 'Internal server error' };
      }
    }
  );

  // DELETE /api/v1/market-mappings/:marketId - Delete market mapping
  fastify.delete<{ Params: { marketId: string } }>('/market-mappings/:marketId', async (
    request: FastifyRequest<{ Params: { marketId: string } }>,
    reply: FastifyReply
  ): Promise<ApiResponse<{ deleted: boolean }>> => {
    try {
      const marketId = parseInt(request.params.marketId);
      if (isNaN(marketId)) {
        reply.code(400);
        return { success: false, error: 'Invalid market ID' };
      }

      const deleted = await deleteMarketMapping(marketId);
      if (!deleted) {
        reply.code(404);
        return { success: false, error: 'Market mapping not found' };
      }

      logger.info('Market mapping deleted', { marketId });
      return { success: true, data: { deleted: true } };
    } catch (error) {
      logger.error('Failed to delete market mapping', { error, marketId: request.params.marketId });
      reply.code(500);
      return { success: false, error: 'Internal server error' };
    }
  });
}