/**
 * Core type definitions for the backend API
 */

export interface MarketMapping {
  id: string;
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
  status: 'active' | 'resolved' | 'disputed' | 'settled';
  resolvedOutcome?: boolean;
  outcomeSubmittedAt?: Date;
  disputeDeadline?: Date;
  settledAt?: Date;
  oraclePubkey: string; // base64 encoded
  createdAt: Date;
  updatedAt: Date;
}

export interface UserPosition {
  id: string;
  marketMappingId: string;
  userAddress: string;
  yesAmount: number;
  noAmount: number;
  totalInvested: number;
  lastUpdated: Date;
}

export interface Trade {
  id: string;
  marketMappingId: string;
  userAddress: string;
  isYes: boolean;
  sharesAmount: number;
  costPaid: number;
  priceAtTrade: number;
  txnId: string;
  roundNumber: number;
  createdAt: Date;
}

export interface OracleSubmission {
  id: string;
  marketMappingId: string;
  outcome: boolean;
  signature: string; // base64
  submittedAt: Date;
  txnId: string;
  roundNumber: number;
  isValid: boolean;
}

export interface Dispute {
  id: string;
  marketMappingId: string;
  initiatedBy: string;
  reason?: string;
  txnId: string;
  roundNumber: number;
  createdAt: Date;
  resolvedAt?: Date;
  resolution?: 'upheld' | 'rejected' | 'escalated';
}

export interface FetcherHealth {
  id: string;
  fetcherName: string;
  status: 'healthy' | 'degraded' | 'down';
  lastSuccessAt?: Date;
  lastFailureAt?: Date;
  consecutiveFailures: number;
  lastError?: string;
  updatedAt: Date;
}

export interface MarketSummary {
  algorandMarketId: number;
  polymarketConditionId: string;
  question: string;
  endDate: Date;
  status: string;
  impliedPriceYes: number;
  impliedPriceNo: number;
  totalVolume: number;
  totalLiquidity: number;
  resolvedOutcome?: boolean;
}

export interface MarketDetail extends MarketSummary {
  polymarketMarketId: string;
  polymarketResolutionCriteria: string;
  seedLiquidity: number;
  bParam: number;
  oraclePubkey: string;
  yesAssetId: number;
  noAssetId: number;
  outcomeSubmittedAt?: Date;
  disputeDeadline?: Date;
  settledAt?: Date;
  recentTrades: Trade[];
  userPosition?: UserPosition;
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  meta?: {
    page?: number;
    limit?: number;
    total?: number;
  };
}

export interface PaginationParams {
  page?: number;
  limit?: number;
}

export interface MarketQueryParams extends PaginationParams {
  status?: string;
  conditionId?: string;
}

export interface PositionQueryParams {
  marketId: number;
  userAddress: string;
}

export interface TradeQueryParams extends PaginationParams {
  marketId?: number;
  userAddress?: string;
  isYes?: boolean;
}