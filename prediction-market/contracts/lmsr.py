"""
LMSR (Logarithmic Market Scoring Rule) Implementation for Algorand AVM

Uses piecewise-linear approximation with a precomputed lookup table.
This avoids floating-point math on the AVM while maintaining reasonable precision.

Reference formula:
    C(q_yes, q_no) = b * ln(e^(q_yes / b) + e^(q_no / b))
    P_yes = e^(q_yes / b) / (e^(q_yes / b) + e^(q_no / b))
"""

from typing import List, Tuple
import math


# Configuration constants
SCALE = 1_000_000  # 6 decimal places for fixed-point (micro-shares)
MAX_TRADE_SHARES = 10_000_000  # Max shares per trade (10 tokens max)
LOOKUP_TABLE_SIZE = 1000  # Number of points in lookup table


def compute_cost_exact(q_yes: int, q_no: int, b: int) -> float:
    """
    Reference implementation using Python floats for testing.
    q_yes, q_no, b are in micro-shares (scaled by SCALE).
    Returns cost in microAlgos (float).
    """
    q_yes_f = q_yes / SCALE
    q_no_f = q_no / SCALE
    b_f = b / SCALE
    
    if b_f == 0:
        return 0.0
    
    exp_yes = math.exp(q_yes_f / b_f)
    exp_no = math.exp(q_no_f / b_f)
    
    cost = b_f * math.log(exp_yes + exp_no)
    return cost * SCALE


def compute_price_yes_exact(q_yes: int, q_no: int, b: int) -> float:
    """Reference price calculation using Python floats."""
    q_yes_f = q_yes / SCALE
    q_no_f = q_no / SCALE
    b_f = b / SCALE
    
    if b_f == 0:
        return 0.5
    
    exp_yes = math.exp(q_yes_f / b_f)
    exp_no = math.exp(q_no_f / b_f)
    
    return exp_yes / (exp_yes + exp_no)


def build_lookup_table(b: int, max_q: int) -> List[int]:
    """
    Build a piecewise-linear lookup table for the cost function C(q, 0) - C(0, 0).
    
    For a given b, we precompute C(q, 0) - C(0, 0) for q from 0 to max_q.
    This makes C(0, 0) = 0 in the table, simplifying the math.
    
    Returns list of incremental costs scaled by SCALE (microAlgos).
    """
    table = []
    step = max_q // LOOKUP_TABLE_SIZE
    base_cost = compute_cost_exact(0, 0, b)
    
    for i in range(LOOKUP_TABLE_SIZE + 1):
        q = i * step
        if q > max_q:
            q = max_q
        cost = compute_cost_exact(q, 0, b) - base_cost
        table.append(int(cost))
    
    return table


def approx_cost_from_table(q_yes: int, q_no: int, b: int, table: List[int], max_q: int) -> int:
    """
    Approximate cost using piecewise-linear interpolation on the lookup table.
    
    Uses the identity: C(q_yes, q_no) = C(|q_yes - q_no|, 0) + min(q_yes, q_no)
    
    Let d = q_yes - q_no, m = min(q_yes, q_no)
    Then C(q_yes, q_no) = b * ln(e^((d+m)/b) + e^(m/b))
                       = b * ln(e^(m/b) * (e^(d/b) + 1))
                       = m + b * ln(e^(d/b) + 1)
                       = m + C(|d|, 0)
    
    So we only need a 1D table for C(q, 0) where q >= 0.
    """
    m = min(q_yes, q_no)
    d = abs(q_yes - q_no)
    
    # Get C(d, 0) from table
    if d >= max_q:
        # Extrapolate linearly beyond table
        last_idx = LOOKUP_TABLE_SIZE
        last_cost = table[last_idx]
        prev_cost = table[last_idx - 1]
        step = max_q // LOOKUP_TABLE_SIZE
        slope = (last_cost - prev_cost) / step
        cost_d = int(last_cost + slope * (d - max_q))
    else:
        # Interpolate within table
        step = max_q // LOOKUP_TABLE_SIZE
        idx = d // step
        if idx >= LOOKUP_TABLE_SIZE:
            idx = LOOKUP_TABLE_SIZE - 1
        
        t = (d % step) / step
        cost_low = table[idx]
        cost_high = table[idx + 1]
        cost_d = int(cost_low + t * (cost_high - cost_low))
    
    return m + cost_d


def compute_buy_cost(q_yes: int, q_no: int, buy_yes: bool, delta_q: int, b: int, table: List[int], max_q: int) -> int:
    """
    Compute the cost to buy delta_q shares of YES or NO.
    
    Args:
        q_yes: Current YES shares outstanding
        q_no: Current NO shares outstanding
        buy_yes: True for YES, False for NO
        delta_q: Number of shares to buy (scaled)
        b: Liquidity parameter (scaled)
        table: Precomputed lookup table
        max_q: Maximum q value in table
    
    Returns:
        Cost in microAlgos (scaled)
    """
    if buy_yes:
        new_q_yes = q_yes + delta_q
        new_q_no = q_no
    else:
        new_q_yes = q_yes
        new_q_no = q_no + delta_q
    
    cost_new = approx_cost_from_table(new_q_yes, new_q_no, b, table, max_q)
    cost_old = approx_cost_from_table(q_yes, q_no, b, table, max_q)
    
    return cost_new - cost_old


def init_market_from_polymarket_price(p_yes: float, b: int, seed_liquidity: int) -> Tuple[int, int]:
    """
    Initialize q_yes, q_no so that P_yes matches the given Polymarket price.
    
    We want P_yes = e^(q_yes/b) / (e^(q_yes/b) + e^(q_no/b)) = p_yes
    
    This gives: e^(q_yes/b) / e^(q_no/b) = p_yes / (1 - p_yes)
    So: (q_yes - q_no) / b = ln(p_yes / (1 - p_yes))
    And: q_yes - q_no = b * ln(p_yes / (1 - p_yes))
    
    We also want the initial cost to equal seed_liquidity (approximately).
    The cost at initialization is C(q_yes, q_no).
    
    For simplicity, we set q_no = 0 and solve for q_yes:
    C(q_yes, 0) = b * ln(e^(q_yes/b) + 1) = seed_liquidity
    
    But this doesn't match the price. Better approach:
    1. Set q_yes - q_no = b * ln(p_yes / (1 - p_yes))
    2. Choose q_yes + q_no such that cost ≈ seed_liquidity
    
    Actually, let's use the standard approach: start with q_yes = q_no = 0 (50/50),
    then the creator provides liquidity by "buying" both sides to match the price.
    
    For MVP: we'll set initial state to match price with minimal liquidity.
    """
    # Log-odds
    if p_yes <= 0:
        p_yes = 0.001
    elif p_yes >= 1:
        p_yes = 0.999
    
    log_odds = math.log(p_yes / (1 - p_yes))
    delta_q = int(log_odds * b / SCALE)
    
    # We need to also satisfy the seed liquidity constraint
    # For now, set symmetric around the delta
    # This is an approximation; real deployment would calibrate
    q_yes = max(0, delta_q)
    q_no = max(0, -delta_q)
    
    # Adjust to match seed liquidity
    # Cost at this state:
    table = build_lookup_table(b, MAX_TRADE_SHARES)
    cost = approx_cost_from_table(q_yes, q_no, b, table, MAX_TRADE_SHARES)
    
    # Scale up if needed
    if cost > 0 and cost < seed_liquidity:
        scale_factor = seed_liquidity / cost
        q_yes = int(q_yes * scale_factor)
        q_no = int(q_no * scale_factor)
    
    return q_yes, q_no


# AVM-compatible fixed-point math (for reference - actual contract uses lookup table)
def fixed_exp(x: int, scale: int = SCALE) -> int:
    """
    Fixed-point approximation of e^x.
    x is scaled by SCALE.
    Returns result scaled by SCALE.
    """
    # Using Taylor series approximation for small x
    # e^x ≈ 1 + x + x^2/2 + x^3/6 + x^4/24
    x_scaled = x
    result = scale
    term = scale
    
    for i in range(1, 10):
        term = (term * x_scaled) // (scale * i)
        if term == 0:
            break
        result += term
    
    return result


def fixed_ln(x: int, scale: int = SCALE) -> int:
    """
    Fixed-point approximation of ln(x).
    x is scaled by SCALE.
    Returns result scaled by SCALE.
    """
    # Using Newton's method: ln(x) = y where e^y = x
    # Initial guess: y = (x - scale) for x near scale
    if x <= 0:
        return -2147483648  # Negative infinity approximation
    
    y = (x - scale) * scale // x  # Rough initial guess
    
    for _ in range(10):
        ey = fixed_exp(y, scale)
        if ey == 0:
            break
        y = y + (x - ey) * scale // ey
    
    return y


def init_market_from_polymarket_price(p_yes: float, b: int, seed_liquidity: int) -> Tuple[int, int]:
    """
    Initialize q_yes, q_no so that P_yes matches the given Polymarket price.
    
    We want P_yes = e^(q_yes/b) / (e^(q_yes/b) + e^(q_no/b)) = p_yes
    
    This gives: e^(q_yes/b) / e^(q_no/b) = p_yes / (1 - p_yes)
    So: (q_yes - q_no) / b = ln(p_yes / (1 - p_yes))
    And: q_yes - q_no = b * ln(p_yes / (1 - p_yes))
    
    We also need the initial cost C(q_yes, q_no) ≈ seed_liquidity.
    
    Let d = q_yes - q_no = b * ln(p_yes / (1 - p_yes))
    Let m = min(q_yes, q_no)
    Then C = m + C(|d|, 0)
    
    We can solve for m: m = seed_liquidity - C(|d|, 0)
    
    Note: For initialization, we use exact math since it's a one-time computation.
    The lookup table is only used for runtime trade cost calculations.
    """
    if p_yes <= 0:
        p_yes = 0.001
    elif p_yes >= 1:
        p_yes = 0.999
    
    log_odds = math.log(p_yes / (1 - p_yes))
    # d = b * log_odds, in micro-shares (same scale as q_yes, q_no)
    d = int(log_odds * b)  # Already in micro-shares since b is in micro-shares
    
    # Use exact formula for C(|d|, 0) since d can be large (beyond lookup table range)
    cost_d = compute_cost_exact(abs(d), 0, b) - compute_cost_exact(0, 0, b)
    cost_d = int(cost_d)  # Already in microAlgos
    
    # m = seed_liquidity - cost_d (both in microAlgos)
    m = seed_liquidity - cost_d
    m = max(0, m)
    
    if d >= 0:
        q_yes = m + d
        q_no = m
    else:
        q_yes = m
        q_no = m - d
    
    return q_yes, q_no


if __name__ == "__main__":
    # Demo / self-test
    print("LMSR Module Demo")
    print("=" * 50)
    
    # Test parameters - use consistent values per LMSR design
    # Max loss = b * ln(2), so seed_liquidity ≈ b * ln(2)
    b = 1000 * SCALE  # b = 1000 tokens (liquidity parameter)
    seed = int(b * math.log(2))  # seed_liquidity = b * ln(2) ≈ 693 ALGO
    p_yes = 0.65  # Polymarket says 65% YES
    
    print(f"b = {b / SCALE} tokens")
    print(f"seed_liquidity = {seed / SCALE:.4f} ALGO (≈ b * ln(2))")
    print(f"Polymarket P_yes = {p_yes}")
    
    # Build lookup table
    table = build_lookup_table(b, MAX_TRADE_SHARES)
    print(f"\nLookup table built: {len(table)} points")
    print(f"C(0,0) = {table[0] / SCALE:.6f}")
    print(f"C({MAX_TRADE_SHARES/SCALE:.1f}, 0) = {table[-1] / SCALE:.6f}")
    
    # Initialize market
    q_yes, q_no = init_market_from_polymarket_price(p_yes, b, seed)
    print(f"\nInitial state: q_yes={q_yes/SCALE:.4f}, q_no={q_no/SCALE:.4f}")
    
    # Check price
    price = compute_price_yes_exact(q_yes, q_no, b)
    print(f"Implied P_yes = {price:.4f} (target: {p_yes})")
    
    # Check cost (incremental from base)
    cost = approx_cost_from_table(q_yes, q_no, b, table, MAX_TRADE_SHARES)
    base_cost_float = compute_cost_exact(0, 0, b)
    total_cost = base_cost_float + cost / SCALE
    print(f"Base cost (b*ln2) = {base_cost_float/SCALE:.4f} ALGO")
    print(f"Incremental cost = {cost/SCALE:.4f} ALGO")
    print(f"Total cost = {total_cost:.4f} ALGO (seed: {seed/SCALE:.4f})")
    
    # Test trades
    print("\n--- Trade Examples ---")
    for delta in [100_000, 500_000, 1_000_000, 5_000_000]:  # 0.1 to 5 tokens
        cost_yes = compute_buy_cost(q_yes, q_no, True, delta, b, table, MAX_TRADE_SHARES)
        cost_no = compute_buy_cost(q_yes, q_no, False, delta, b, table, MAX_TRADE_SHARES)
        price_yes = compute_price_yes_exact(q_yes + delta, q_no, b) if delta > 0 else price
        print(f"Buy {delta/SCALE:.2f} YES: cost={cost_yes/SCALE:.4f} ALGO, new P_yes={price_yes:.4f}")
        print(f"Buy {delta/SCALE:.2f} NO:  cost={cost_no/SCALE:.4f} ALGO")
    
    # Test approximation accuracy
    print("\n--- Approximation Accuracy (incremental cost) ---")
    test_points = [
        (0, 0),
        (100_000, 0),
        (500_000, 100_000),
        (1_000_000, 1_000_000),
        (5_000_000, 2_000_000),
    ]
    
    max_error = 0.0
    for qy, qn in test_points:
        exact_inc = (compute_cost_exact(qy, qn, b) - compute_cost_exact(0, 0, b)) / SCALE
        approx = approx_cost_from_table(qy, qn, b, table, MAX_TRADE_SHARES) / SCALE
        error_pct = abs(exact_inc - approx) / exact_inc * 100 if exact_inc > 0 else 0
        max_error = max(max_error, error_pct)
        print(f"q_yes={qy/SCALE:.2f}, q_no={qn/SCALE:.2f}: exact_inc={exact_inc:.4f}, approx={approx:.4f}, error={error_pct:.3f}%")
    
    print(f"\nMax approximation error: {max_error:.3f}%")
    assert max_error < 0.5, f"Error {max_error:.3f}% exceeds 0.5% tolerance"
    print("✓ Accuracy test passed (< 0.5% error)")