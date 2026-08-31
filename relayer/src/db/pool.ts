/**
 * Database connection pool for the relayer
 */

import pg from 'pg';
import { logger } from '../utils/logger';

const { Pool } = pg;

let pool: pg.Pool | null = null;

export function getRelayerPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL environment variable not set');
    }

    pool = new Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 15000,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    });

    pool.on('error', (err: Error) => {
      logger.error('Unexpected database pool error', { error: err.message });
    });

    logger.info('Relayer database pool created');
  }
  return pool;
}

export async function closeRelayerPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    logger.info('Relayer database pool closed');
  }
}

export async function queryRelayer<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: any[]
): Promise<pg.QueryResult<T>> {
  const start = Date.now();
  const pool = getRelayerPool();
  try {
    const result = await pool.query<T>(text, params);
    const duration = Date.now() - start;
    logger.debug('Executed query', { text: text.substring(0, 100), duration, rows: result.rowCount });
    return result;
  } catch (error) {
    logger.error('Query failed', { text: text.substring(0, 100), params, error });
    throw error;
  }
}