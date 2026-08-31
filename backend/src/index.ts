/**
 * Main entry point for the Backend API
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { marketRoutes } from './api/markets';
import { adminRoutes } from './api/admin';
import { marketMappingRoutes } from './api/market-mappings';
import { initializeDatabase, closePool } from './db/pool';
import { createIndexerService } from './indexer';
import { createEventFetcher } from './fetchers/onchain-events';
import { createLiquidityHealthFetcher } from './fetchers/liquidity-health';
import { logger } from './utils/logger';

const fastify = Fastify({
  logger: false, // We use our own logger
});

async function start() {
  try {
    // Initialize database
    await initializeDatabase();

    // Register plugins
    await fastify.register(cors, {
      origin: true,
      credentials: true,
    });

    await fastify.register(swagger, {
      openapi: {
        info: {
          title: 'Algorand Prediction Market API',
          description: 'Backend API for Polymarket-anchored prediction markets on Algorand',
          version: '1.0.0',
        },
        servers: [
          { url: `http://localhost:${process.env.PORT || 3001}`, description: 'Development server' },
        ],
        components: {
          securitySchemes: {
            apiKey: {
              type: 'apiKey',
              name: 'Authorization',
              in: 'header',
            },
          },
        },
      },
    });

    await fastify.register(swaggerUi, {
      routePrefix: '/docs',
      uiConfig: {
        docExpansion: 'list',
        deepLinking: true,
      },
    });

    // Health check endpoint
    fastify.get('/health', async () => {
      return { status: 'ok', timestamp: new Date().toISOString() };
    });

    // Register API routes
    await fastify.register(marketRoutes, { prefix: '/api/v1' });
    await fastify.register(adminRoutes, { prefix: '/api/v1' });
    await fastify.register(marketMappingRoutes, { prefix: '/api/v1' });

    // Start server
    const port = parseInt(process.env.PORT || '3001');
    const host = process.env.HOST || '0.0.0.0';
    
    await fastify.listen({ port, host });
    
    logger.info(`Server listening on http://${host}:${port}`);
    logger.info(`API docs available at http://${host}:${port}/docs`);

    // Initialize background services
    const indexer = createIndexerService();
    const eventFetcher = createEventFetcher();
    const liquidityFetcher = createLiquidityHealthFetcher();

    // Start background services
    eventFetcher.start(10000); // Poll every 10 seconds
    liquidityFetcher.start();

    // Periodic indexer sync (every 30 seconds)
    setInterval(async () => {
      try {
        // Would fetch market mappings and sync
        // await indexer.syncMarket(marketMapping);
      } catch (error) {
        logger.error('Indexer sync failed', { error });
      }
    }, 30000);

    // Graceful shutdown
    const shutdown = async () => {
      logger.info('Shutting down...');
      eventFetcher.stop();
      liquidityFetcher.stop();
      await closePool();
      await fastify.close();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

  } catch (error) {
    logger.error('Failed to start server', { error });
    process.exit(1);
  }
}

start();