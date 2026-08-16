"""
Tests for LMSR (Logarithmic Market Scoring Rule) Implementation
"""

import pytest
import math
from contracts.lmsr import (
    SCALE,
    MAX_TRADE_SHARES,
    LOOKUP_TABLE_SIZE,
    compute_cost_exact,
    compute_price_yes_exact,
    build_lookup_table,
    approx_cost_from_table,
    compute_buy_cost,
    init_market_from_polymarket_price,
)


class TestLMSRReference:
    """Tests using the exact Python float reference implementation."""

    def test_cost_at_zero(self):
        """Cost at (0, 0) should be b * ln(2)."""
        b = 1000 * SCALE
        cost = compute_cost_exact(0, 0, b)
        expected = b * math.log(2)
        assert abs(cost - expected) < 1.0  # Within 1 microAlgo

    def test_cost_symmetry(self):
        """C(q_yes, q_no) should equal C(q_no, q_yes)."""
        b = 1000 * SCALE
        cost1 = compute_cost_exact(500_000, 300_000, b)
        cost2 = compute_cost_exact(300_000, 500_000, b)
        assert abs(cost1 - cost2) < 1.0

    def test_price_sum_to_one(self):
        """P_yes + P_no should equal 1."""
        b = 1000 * SCALE
        for qy, qn in [(0, 0), (100_000, 0), (500_000, 200_000), (1_000_000, 1_000_000)]:
            p_yes = compute_price_yes_exact(qy, qn, b)
            p_no = 1 - p_yes
            # Also compute P_no directly
            p_no_direct = compute_price_yes_exact(qn, qy, b)
            assert abs(p_no - p_no_direct) < 1e-10

    def test_price_range(self):
        """Price should always be in (0, 1)."""
        b = 1000 * SCALE
        for qy, qn in [(0, 0), (10_000_000, 0), (0, 10_000_000), (5_000_000, 5_000_000)]:
            p = compute_price_yes_exact(qy, qn, b)
            assert 0 < p < 1

    def test_monotonic_price(self):
        """Increasing q_yes should increase P_yes."""
        b = 1000 * SCALE
        p1 = compute_price_yes_exact(100_000, 100_000, b)
        p2 = compute_price_yes_exact(200_000, 100_000, b)
        p3 = compute_price_yes_exact(500_000, 100_000, b)
        assert p1 < p2 < p3


class TestLMSRLookupTable:
    """Tests for the piecewise-linear lookup table approximation."""

    def setup_method(self):
        self.b = 1000 * SCALE
        self.table = build_lookup_table(self.b, MAX_TRADE_SHARES)

    def test_table_size(self):
        """Table should have LOOKUP_TABLE_SIZE + 1 entries."""
        assert len(self.table) == LOOKUP_TABLE_SIZE + 1

    def test_table_starts_at_zero(self):
        """C(0, 0) incremental cost should be 0."""
        assert self.table[0] == 0

    def test_table_monotonic(self):
        """Table values should be monotonically increasing."""
        for i in range(1, len(self.table)):
            assert self.table[i] >= self.table[i - 1]

    def test_approx_cost_at_zero(self):
        """Approx cost at (0, 0) should be 0."""
        cost = approx_cost_from_table(0, 0, self.b, self.table, MAX_TRADE_SHARES)
        assert cost == 0

    def test_approx_cost_symmetry(self):
        """Approx cost should be symmetric."""
        cost1 = approx_cost_from_table(500_000, 300_000, self.b, self.table, MAX_TRADE_SHARES)
        cost2 = approx_cost_from_table(300_000, 500_000, self.b, self.table, MAX_TRADE_SHARES)
        assert cost1 == cost2

    def test_approx_vs_exact_accuracy(self):
        """Approximation should be within 0.5% of exact for test points."""
        test_points = [
            (0, 0),
            (100_000, 0),
            (500_000, 100_000),
            (1_000_000, 1_000_000),
            (2_000_000, 500_000),
            (5_000_000, 2_000_000),
            (8_000_000, 3_000_000),
        ]
        
        max_error = 0.0
        for qy, qn in test_points:
            exact_inc = (compute_cost_exact(qy, qn, self.b) - compute_cost_exact(0, 0, self.b)) / SCALE
            approx = approx_cost_from_table(qy, qn, self.b, self.table, MAX_TRADE_SHARES) / SCALE
            if exact_inc > 0:
                error_pct = abs(exact_inc - approx) / exact_inc * 100
                max_error = max(max_error, error_pct)
        
        assert max_error < 0.5, f"Max error {max_error:.3f}% exceeds 0.5% tolerance"

    def test_buy_cost_positive(self):
        """Buy cost should always be positive."""
        qy, qn = 1_000_000, 500_000
        for delta in [100_000, 500_000, 1_000_000]:
            cost_yes = compute_buy_cost(qy, qn, True, delta, self.b, self.table, MAX_TRADE_SHARES)
            cost_no = compute_buy_cost(qy, qn, False, delta, self.b, self.table, MAX_TRADE_SHARES)
            assert cost_yes > 0
            assert cost_no > 0

    def test_buy_cost_increases_with_size(self):
        """Larger trades should cost more."""
        qy, qn = 1_000_000, 500_000
        cost_small = compute_buy_cost(qy, qn, True, 100_000, self.b, self.table, MAX_TRADE_SHARES)
        cost_large = compute_buy_cost(qy, qn, True, 500_000, self.b, self.table, MAX_TRADE_SHARES)
        assert cost_large > cost_small


class TestLMSRMarketInit:
    """Tests for market initialization from Polymarket price."""

    def test_init_matches_price(self):
        """Initialized market should match target Polymarket price."""
        b = 1000 * SCALE
        seed = int(b * math.log(2))
        p_yes = 0.65
        
        q_yes, q_no = init_market_from_polymarket_price(p_yes, b, seed)
        actual_price = compute_price_yes_exact(q_yes, q_no, b)
        
        assert abs(actual_price - p_yes) < 0.001  # Within 0.1%

    def test_init_cost_matches_seed(self):
        """Initialized market cost should approximately match seed liquidity."""
        b = 1000 * SCALE
        seed = int(b * math.log(2))
        p_yes = 0.65
        
        q_yes, q_no = init_market_from_polymarket_price(p_yes, b, seed)
        table = build_lookup_table(b, MAX_TRADE_SHARES)
        cost = approx_cost_from_table(q_yes, q_no, b, table, MAX_TRADE_SHARES)
        base_cost = compute_cost_exact(0, 0, b)
        total_cost = base_cost + cost / SCALE
        
        # Should be close to seed (within 1%)
        assert abs(total_cost - seed) / seed < 0.01

    def test_init_extreme_prices(self):
        """Initialization should handle extreme prices (near 0 or 1)."""
        b = 1000 * SCALE
        seed = int(b * math.log(2))
        
        for p_yes in [0.01, 0.1, 0.9, 0.99]:
            q_yes, q_no = init_market_from_polymarket_price(p_yes, b, seed)
            actual_price = compute_price_yes_exact(q_yes, q_no, b)
            assert abs(actual_price - p_yes) < 0.005  # Within 0.5%

    def test_init_different_b_values(self):
        """Initialization should work with different b values."""
        for b_tokens in [100, 500, 1000, 5000]:
            b = b_tokens * SCALE
            seed = int(b * math.log(2))
            p_yes = 0.65
            
            q_yes, q_no = init_market_from_polymarket_price(p_yes, b, seed)
            actual_price = compute_price_yes_exact(q_yes, q_no, b)
            assert abs(actual_price - p_yes) < 0.001


class TestLMSREdgeCases:
    """Edge case tests."""

    def test_large_q_values(self):
        """Should handle large q values without overflow."""
        b = 1000 * SCALE
        table = build_lookup_table(b, MAX_TRADE_SHARES)
        
        # Large but within max trade
        qy, qn = MAX_TRADE_SHARES, MAX_TRADE_SHARES // 2
        cost = approx_cost_from_table(qy, qn, b, table, MAX_TRADE_SHARES)
        assert cost > 0

    def test_buy_cost_consistency(self):
        """Buying YES then NO should be consistent with buying NO then YES (approximately)."""
        b = 1000 * SCALE
        table = build_lookup_table(b, MAX_TRADE_SHARES)
        qy, qn = 1_000_000, 500_000
        
        # Path 1: Buy YES then NO
        cost_yes1 = compute_buy_cost(qy, qn, True, 100_000, b, table, MAX_TRADE_SHARES)
        cost_no1 = compute_buy_cost(qy + 100_000, qn, False, 100_000, b, table, MAX_TRADE_SHARES)
        
        # Path 2: Buy NO then YES
        cost_no2 = compute_buy_cost(qy, qn, False, 100_000, b, table, MAX_TRADE_SHARES)
        cost_yes2 = compute_buy_cost(qy, qn + 100_000, True, 100_000, b, table, MAX_TRADE_SHARES)
        
        # Total cost should be similar (path independence approximately holds for small trades)
        total1 = cost_yes1 + cost_no1
        total2 = cost_no2 + cost_yes2
        assert abs(total1 - total2) / total1 < 0.02  # Within 2%


if __name__ == "__main__":
    pytest.main([__file__, "-v"])