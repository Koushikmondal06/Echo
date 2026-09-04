-- Migration: 002_market_liquidity_health
-- Add market_liquidity_health table for backend liquidity monitoring

CREATE TABLE market_liquidity_health (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    
    algorand_market_id BIGINT NOT NULL UNIQUE,
    polymarket_condition_id VARCHAR(255) NOT NULL,
    seed_liquidity BIGINT NOT NULL,
    b_param BIGINT NOT NULL,
    on_chain_volume BIGINT NOT NULL DEFAULT 0,
    volume_to_liquidity_ratio NUMERIC(10,6) NOT NULL DEFAULT 0,
    health VARCHAR(20) NOT NULL DEFAULT 'healthy',  -- healthy, medium, low, critical
    last_checked TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    FOREIGN KEY (polymarket_condition_id) REFERENCES market_mappings(polymarket_condition_id) ON DELETE CASCADE
);

CREATE INDEX idx_market_liquidity_health_market_id ON market_liquidity_health(algorand_market_id);
CREATE INDEX idx_market_liquidity_health_health ON market_liquidity_health(health);
CREATE INDEX idx_market_liquidity_health_last_checked ON market_liquidity_health(last_checked);