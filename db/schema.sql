-- Algorand Prediction Market - Market Mapping Schema
-- Migration: 001_initial_schema

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Core market mapping table
CREATE TABLE market_mappings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    
    -- Algorand side
    algorand_market_id BIGINT NOT NULL UNIQUE,
    algorand_app_id BIGINT NOT NULL,
    yes_asset_id BIGINT NOT NULL,
    no_asset_id BIGINT NOT NULL,
    
    -- Polymarket side
    polymarket_market_id VARCHAR(255) NOT NULL,
    polymarket_condition_id VARCHAR(255) NOT NULL UNIQUE,
    polymarket_question TEXT NOT NULL,
    polymarket_resolution_criteria TEXT,
    polymarket_end_date TIMESTAMPTZ NOT NULL,
    
    -- AMM Parameters
    seed_liquidity BIGINT NOT NULL,           -- microAlgos deposited by creator
    b_param BIGINT NOT NULL,                  -- LMSR liquidity parameter (scaled)
    
    -- Market state
    status VARCHAR(50) NOT NULL DEFAULT 'active', -- active, resolved, disputed, settled
    resolved_outcome BOOLEAN,                 -- true=YES, false=NO, null=pending
    outcome_submitted_at TIMESTAMPTZ,
    dispute_deadline TIMESTAMPTZ,
    settled_at TIMESTAMPTZ,
    
    -- Oracle
    oracle_pubkey BYTEA NOT NULL,             -- 32-byte ed25519 public key
    
    -- Metadata
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for common queries
CREATE INDEX idx_market_mappings_algorand_market_id ON market_mappings(algorand_market_id);
CREATE INDEX idx_market_mappings_polymarket_condition_id ON market_mappings(polymarket_condition_id);
CREATE INDEX idx_market_mappings_status ON market_mappings(status);
CREATE INDEX idx_market_mappings_end_date ON market_mappings(polymarket_end_date);

-- User positions table (for backend/indexer tracking)
CREATE TABLE user_positions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    market_mapping_id UUID NOT NULL REFERENCES market_mappings(id) ON DELETE CASCADE,
    user_address VARCHAR(58) NOT NULL,        -- Algorand address
    yes_amount BIGINT NOT NULL DEFAULT 0,     -- micro-shares
    no_amount BIGINT NOT NULL DEFAULT 0,      -- micro-shares
    total_invested BIGINT NOT NULL DEFAULT 0, -- microAlgos
    last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    UNIQUE(market_mapping_id, user_address)
);

CREATE INDEX idx_user_positions_user ON user_positions(user_address);
CREATE INDEX idx_user_positions_market ON user_positions(market_mapping_id);

-- Trade history for analytics
CREATE TABLE trades (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    market_mapping_id UUID NOT NULL REFERENCES market_mappings(id) ON DELETE CASCADE,
    user_address VARCHAR(58) NOT NULL,
    is_yes BOOLEAN NOT NULL,
    shares_amount BIGINT NOT NULL,            -- micro-shares bought
    cost_paid BIGINT NOT NULL,                -- microAlgos paid
    price_at_trade NUMERIC(10,6) NOT NULL,    -- implied probability at trade time
    txn_id VARCHAR(64) NOT NULL,              -- Algorand transaction ID
    round_number BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_trades_market ON trades(market_mapping_id);
CREATE INDEX idx_trades_user ON trades(user_address);
CREATE INDEX idx_trades_txn ON trades(txn_id);

-- Oracle submission log
CREATE TABLE oracle_submissions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    market_mapping_id UUID NOT NULL REFERENCES market_mappings(id) ON DELETE CASCADE,
    outcome BOOLEAN NOT NULL,                 -- true=YES, false=NO
    signature BYTEA NOT NULL,                 -- 64-byte ed25519 signature
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    txn_id VARCHAR(64) NOT NULL,              -- Algorand transaction ID
    round_number BIGINT NOT NULL,
    is_valid BOOLEAN NOT NULL DEFAULT TRUE,
    
    UNIQUE(market_mapping_id, txn_id)
);

CREATE INDEX idx_oracle_submissions_market ON oracle_submissions(market_mapping_id);

-- Dispute log
CREATE TABLE disputes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    market_mapping_id UUID NOT NULL REFERENCES market_mappings(id) ON DELETE CASCADE,
    initiated_by VARCHAR(58) NOT NULL,        -- admin address
    reason TEXT,
    txn_id VARCHAR(64) NOT NULL,
    round_number BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ,
    resolution VARCHAR(50)                    -- upheld, rejected, escalated
);

CREATE INDEX idx_disputes_market ON disputes(market_mapping_id);

-- Fetcher health monitoring
CREATE TABLE fetcher_health (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    fetcher_name VARCHAR(100) NOT NULL,       -- gamma, clob, finality, indexer, onchain, secondary
    status VARCHAR(20) NOT NULL,              -- healthy, degraded, down
    last_success_at TIMESTAMPTZ,
    last_failure_at TIMESTAMPTZ,
    consecutive_failures INT NOT NULL DEFAULT 0,
    last_error TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    UNIQUE(fetcher_name)
);

-- Trigger to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_market_mappings_updated_at
    BEFORE UPDATE ON market_mappings
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();