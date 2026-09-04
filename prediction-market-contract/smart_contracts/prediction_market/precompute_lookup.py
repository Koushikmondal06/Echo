#!/usr/bin/env python3
"""
Pre-compute LMSR lookup table off-chain for efficient on-chain storage.
Run this script to generate lookup table values for create_market calls.
"""

SCALE = 1_000_000
MAX_TRADE_SHARES = 10_000_000
LOOKUP_TABLE_SIZE = 5
LOOKUP_STEP = MAX_TRADE_SHARES // LOOKUP_TABLE_SIZE

def compute_lookup_table(b_param: int) -> list[int]:
    """Compute the 6-point piecewise-linear LMSR cost lookup table.
    
    Formula: cost = q * ln2_scaled + q^2 // (2 * b)
    Where b is the LMSR liquidity parameter.
    """
    ln2_scaled = 693_147  # ln(2) * 1_000_000
    table = []
    
    for i in range(LOOKUP_TABLE_SIZE + 1):
        q = i * LOOKUP_STEP
        max_q = MAX_TRADE_SHARES
        if q > max_q:
            q = max_q
        
        cost = (q * ln2_scaled) // SCALE + (q * q) // (2 * b_param)
        table.append(cost)
    
    return table


def print_lookup_table(b_param: int) -> None:
    """Print lookup table as comma-separated values for easy copy-paste."""
    table = compute_lookup_table(b_param)
    print(f"b_param = {b_param}")
    print(f"LOOKUP_STEP = {LOOKUP_STEP}")
    print("Lookup table (6 values):")
    print(", ".join(str(v) for v in table))
    print()
    
    # Also print as ARC4 StaticArray constructor format
    print("For contract call (as tuple):")
    print(f"({', '.join(str(v) for v in table)})")


if __name__ == "__main__":
    import sys
    
    if len(sys.argv) > 1:
        b_param = int(sys.argv[1])
    else:
        # Default b_param for ~100 ALGO seed liquidity at 50/50
        b_param = 1_000_000_000
    
    print_lookup_table(b_param)
    
    # Example for different b_params
    print("=" * 50)
    print("Common b_param values:")
    for bp in [500_000_000, 1_000_000_000, 2_000_000_000, 5_000_000_000]:
        table = compute_lookup_table(bp)
        print(f"b={bp}: {table}")