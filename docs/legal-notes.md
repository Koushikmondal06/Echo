# Polymarket API Legal Notes

## API Terms of Use Review

**Date Reviewed**: 2026-08-16

### Polymarket Public API (Gamma & CLOB)

**Status**: ✅ No blocker for public product use

#### Key Findings:

1. **Gamma API** (market metadata, questions, condition IDs)
   - Publicly accessible without authentication
   - Rate limits: ~60 requests/minute per IP (informal, not strictly enforced)
   - No API key required for read operations
   - Terms: Data can be used for display and reference purposes

2. **CLOB API** (order book, live prices)
   - Publicly accessible
   - Rate limits: Similar to Gamma (~60 req/min)
   - WebSocket available for real-time updates
   - No authentication required for public market data

3. **UMA Dispute Status**
   - Available via Gamma API endpoints
   - No separate terms beyond general API usage

#### Restrictions Noted:

- **Commercial redistribution** of raw API data may require partnership agreement
- **Caching/Reselling** data as a service is not permitted without approval
- **Attribution** recommended when displaying Polymarket-sourced data
- **No warranty/SLA** — APIs are provided as-is for developers

#### MVP Compliance Strategy:

1. **Use as reference only** — Our contract anchors to Polymarket outcomes but doesn't resell their data
2. **Display attribution** — Frontend shows "Odds sourced from Polymarket" with link
3. **Rate limit compliance** — Implement exponential backoff and caching (5-min TTL for metadata, 30-sec for prices)
4. **Fallback fetcher** — Secondary reference (Kalshi) stubbed for future multi-oracle

#### Recommendation:

Proceed with MVP. No legal blocker for:
- Fetching market metadata for mapping table
- Reading live prices for AMM seed pricing
- Checking resolution finality via UMA dispute status
- Displaying Polymarket reference on frontend

**Action Items**:
- [ ] Add Polymarket attribution to frontend market detail page
- [ ] Implement rate limiting in fetchers (Phase 2)
- [ ] Document fallback strategy if API access changes (Phase 6)