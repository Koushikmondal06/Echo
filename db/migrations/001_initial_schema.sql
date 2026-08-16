-- Migration: 001_initial_schema
-- Description: Initial market mapping schema for Algorand Prediction Market
-- Author: Build Plan Phase 0
-- Date: 2026-08-16

-- This migration creates all tables needed for the market mapping and backend operations.
-- Run with: psql -d prediction_market -f db/migrations/001_initial_schema.sql

\i ../schema.sql