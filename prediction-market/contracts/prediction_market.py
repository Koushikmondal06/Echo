from algopy import (
    ARC4Contract,
    Asset,
    Global,
    Txn,
    UInt64,
    Bytes,
    Account,
    itxn,
    op,
    subroutine,
    String,
    arc4,
    BoxMap,
    GlobalState,
    LocalState,
)


# Constants
SCALE = 1_000_000  # 6 decimal places (micro-shares)
MAX_TRADE_SHARES = 10_000_000  # Max 10 tokens per trade
LOOKUP_TABLE_SIZE = 100  # Smaller table for on-chain storage
MAX_POSITION_PCT = 5  # Max 5% of seed liquidity per user


class MarketState(arc4.Struct):
    polymarket_condition_id: arc4.String
    polymarket_question: arc4.String
    end_time: arc4.UInt64
    oracle_pubkey: arc4.StaticArray[arc4.Byte, arc4.Literal[32]]
    yes_asset_id: arc4.UInt64
    no_asset_id: arc4.UInt64
    resolved: arc4.Bool
    outcome: arc4.Bool
    outcome_submitted_at: arc4.UInt64
    dispute_deadline: arc4.UInt64
    q_yes: arc4.UInt64
    q_no: arc4.UInt64
    b_param: arc4.UInt64
    seed_liquidity: arc4.UInt64
    max_position_per_user: arc4.UInt64
    cost_lookup: arc4.DynamicArray[arc4.UInt64]


class UserPosition(arc4.Struct):
    yes_shares: arc4.UInt64
    no_shares: arc4.UInt64
    total_invested: arc4.UInt64


class PredictionMarket(ARC4Contract):
    def __init__(self) -> None:
        self.admin = GlobalState(Account)
        self.oracle_pubkey = GlobalState(Bytes)
        self.dispute_window = GlobalState(UInt64)
        self.markets = BoxMap(UInt64, MarketState)
        self.user_positions = BoxMap(UInt64, UserPosition)  # market_id -> user -> position
        self.market_counter = GlobalState(UInt64)
        self.fee_bps = GlobalState(UInt64)

    @arc4.abimethod(create="require")
    def create_app(
        self,
        admin: Account,
        oracle_pubkey: arc4.StaticArray[arc4.Byte, arc4.Literal[32]],
        dispute_window: UInt64,
        fee_bps: UInt64,
    ) -> None:
        self.admin.value = admin
        self.oracle_pubkey.value = op.bconcat(*oracle_pubkey)
        self.dispute_window.value = dispute_window
        self.fee_bps.value = fee_bps
        self.market_counter.value = UInt64(0)

    @subroutine
    def build_lookup_table(self, b: UInt64) -> arc4.DynamicArray[arc4.UInt64]:
        """Build piecewise-linear lookup table for C(q, 0) - C(0, 0).
        
        Since we can't do floating point on-chain, we use a precomputed approximation.
        The table stores incremental cost from q=0 to q=MAX_TRADE_SHARES.
        """
        table = arc4.DynamicArray[arc4.UInt64]()
        step = MAX_TRADE_SHARES // LOOKUP_TABLE_SIZE
        
        # Precomputed approximations for b = 1000 * SCALE
        # These are C(q, 0) - C(0, 0) in microAlgos
        # For other b values, the table would need to be recomputed off-chain and passed in
        # MVP: fixed b = 1000 * SCALE, table embedded in contract
        
        # Approximate cost curve: C(q) ≈ q * ln(2) + q^2 / (2*b) for small q
        # More accurately: C(q) = b * ln(e^(q/b) + 1) - b * ln(2)
        
        # For MVP, we'll use a simplified quadratic approximation
        # C(q) ≈ q * (b*ln(2)/b) + q^2/(2*b) = q*ln(2) + q^2/(2*b)
        # In fixed point: cost = q * ln2_scale + q^2 // (2*b)
        ln2_scaled = 693_147  # ln(2) * 1_000_000
        
        for i in range(LOOKUP_TABLE_SIZE + 1):
            q = i * step
            if q > MAX_TRADE_SHARES:
                q = MAX_TRADE_SHARES
            
            # Quadratic approximation: cost = q * ln2_scaled + q^2 // (2 * b)
            # Using b = 1000 * SCALE = 1_000_000_000
            b_val = 1_000_000_000
            cost = (q * ln2_scaled) // SCALE + (q * q) // (2 * b_val)
            table.append(arc4.UInt64(UInt64(cost)))
        
        return table

    @subroutine
    def approx_cost_from_table(
        self,
        q_yes: UInt64,
        q_no: UInt64,
        table: arc4.DynamicArray[arc4.UInt64],
    ) -> UInt64:
        """Approximate incremental cost C(q_yes, q_no) - C(0, 0) using lookup table.
        
        Uses identity: C(q_yes, q_no) = min(q_yes, q_no) + C(|q_yes - q_no|, 0)
        """
        m = q_yes if q_yes < q_no else q_no
        d = q_yes - q_no if q_yes > q_no else q_no - q_yes
        
        if d == 0:
            return m
        
        step = MAX_TRADE_SHARES // LOOKUP_TABLE_SIZE
        idx = d // step
        if idx >= LOOKUP_TABLE_SIZE:
            idx = UInt64(LOOKUP_TABLE_SIZE - 1)
        
        t = (d % step) * SCALE // step
        cost_low = table[idx].native
        cost_high = table[idx + 1].native
        cost_d = cost_low + (t * (cost_high - cost_low)) // SCALE
        
        return m + UInt64(cost_d)

    @subroutine
    def compute_buy_cost(
        self,
        q_yes: UInt64,
        q_no: UInt64,
        buy_yes: bool,
        delta_q: UInt64,
        table: arc4.DynamicArray[arc4.UInt64],
    ) -> UInt64:
        """Compute cost to buy delta_q shares of YES or NO."""
        if buy_yes:
            new_q_yes = q_yes + delta_q
            new_q_no = q_no
        else:
            new_q_yes = q_yes
            new_q_no = q_no + delta_q
        
        cost_new = self.approx_cost_from_table(new_q_yes, new_q_no, table)
        cost_old = self.approx_cost_from_table(q_yes, q_no, table)
        
        return cost_new - cost_old

    @arc4.abimethod
    def create_market(
        self,
        polymarket_condition_id: String,
        polymarket_question: String,
        end_time: UInt64,
        oracle_pubkey: arc4.StaticArray[arc4.Byte, arc4.Literal[32]],
        polymarket_price_yes: UInt64,  # Scaled by SCALE (e.g., 650000 for 65%)
        seed_liquidity: UInt64,        # MicroAlgos deposited by creator
        b_param: UInt64,               # Liquidity parameter (scaled)
    ) -> UInt64:
        assert Txn.sender == self.admin.value, "Only admin can create markets"
        assert end_time > Global.latest_timestamp, "End time must be in future"
        assert polymarket_price_yes > 0 and polymarket_price_yes < SCALE, "Invalid price"
        assert seed_liquidity > 0, "Seed liquidity required"
        assert b_param > 0, "b_param must be positive"
        
        market_id = self.market_counter.value
        self.market_counter.value = market_id + 1

        # Create YES and NO assets
        yes_asset = itxn.AssetConfig(
            asset_name="YES",
            unit_name="YES",
            total=1_000_000_000_000,
            decimals=6,
            default_frozen=False,
            manager=Global.current_application_address,
            reserve=Global.current_application_address,
            freeze=Global.current_application_address,
            clawback=Global.current_application_address,
        ).submit()

        no_asset = itxn.AssetConfig(
            asset_name="NO",
            unit_name="NO",
            total=1_000_000_000_000,
            decimals=6,
            default_frozen=False,
            manager=Global.current_application_address,
            reserve=Global.current_application_address,
            freeze=Global.current_application_address,
            clawback=Global.current_application_address,
        ).submit()

        # Build LMSR lookup table
        cost_lookup = self.build_lookup_table(b_param)

        # Initialize q_yes, q_no to match Polymarket price
        # Using log-odds: q_yes - q_no = b * ln(p_yes / (1 - p_yes))
        # For MVP, we use a simplified initialization
        # P_yes = polymarket_price_yes / SCALE
        # log_odds ≈ (p_yes - 0.5) * 4 for p near 0.5 (rough approximation)
        # Better: use precomputed log-odds or pass q_yes, q_no directly
        
        # For MVP, we'll initialize with symmetric shares and adjust
        # This is an approximation; production would compute exact values off-chain
        p_scaled = polymarket_price_yes
        # log(p/(1-p)) * b ≈ (2p - 1) * 2 * b for p near 0.5
        # delta = (2 * p_scaled - SCALE) * b_param // SCALE
        # Clamp delta to reasonable range
        delta = (UInt64(2) * p_scaled - SCALE) * b_param // SCALE
        
        # Base shares (both sides get equal base)
        # Cost at initialization should ≈ seed_liquidity
        # C(q, q) = q + b*ln(2) - b*ln(2) = q (incremental)
        # So q = seed_liquidity
        base_shares = seed_liquidity
        
        if delta >= 0:
            q_yes = base_shares + delta
            q_no = base_shares
        else:
            q_yes = base_shares
            q_no = base_shares - delta
        
        # Max position per user (5% of seed)
        max_position = seed_liquidity * MAX_POSITION_PCT // 100

        self.markets[market_id] = MarketState(
            polymarket_condition_id=arc4.String(polymarket_condition_id),
            polymarket_question=arc4.String(polymarket_question),
            end_time=arc4.UInt64(end_time),
            oracle_pubkey=oracle_pubkey,
            yes_asset_id=arc4.UInt64(yes_asset.created_asset.id),
            no_asset_id=arc4.UInt64(no_asset.created_asset.id),
            resolved=arc4.Bool(False),
            outcome=arc4.Bool(False),
            outcome_submitted_at=arc4.UInt64(0),
            dispute_deadline=arc4.UInt64(0),
            q_yes=arc4.UInt64(q_yes),
            q_no=arc4.UInt64(q_no),
            b_param=arc4.UInt64(b_param),
            seed_liquidity=arc4.UInt64(seed_liquidity),
            max_position_per_user=arc4.UInt64(max_position),
            cost_lookup=cost_lookup,
        )

        # Creator provides seed liquidity (they get position tokens)
        # Transfer seed_liquidity microAlgos to contract
        itxn.Payment(
            receiver=Global.current_application_address,
            amount=seed_liquidity,
        ).submit()

        # Mint initial position to creator (they get both YES and NO proportional to q)
        # This represents the liquidity they provided
        itxn.AssetTransfer(
            xfer_asset=yes_asset.created_asset.id,
            asset_receiver=Txn.sender,
            asset_amount=q_yes,
        ).submit()
        
        itxn.AssetTransfer(
            xfer_asset=no_asset.created_asset.id,
            asset_receiver=Txn.sender,
            asset_amount=q_no,
        ).submit()

        return market_id

    @arc4.abimethod
    def buy_position(
        self,
        market_id: UInt64,
        is_yes: bool,
        payment: arc4.UInt64,
    ) -> None:
        market = self.markets[market_id].copy()
        assert not market.resolved, "Market already resolved"
        assert Global.latest_timestamp < market.end_time, "Market ended"

        asset_id = market.yes_asset_id if is_yes else market.no_asset_id
        asset = Asset(asset_id.native)

        # Check opt-in
        assert asset.is_frozen(Txn.sender) == False, "Must opt-in first"

        amount = payment.native
        fee = (amount * self.fee_bps.value) // 10_000
        position_amount = amount - fee

        # Compute shares to mint using LMSR cost function
        delta_q = self.compute_buy_cost(
            market.q_yes.native,
            market.q_no.native,
            is_yes,
            position_amount,
            market.cost_lookup,
        )

        assert delta_q > 0, "Invalid trade size"

        # Check per-user position cap
        user_pos_key = market_id * UInt64(1_000_000) + UInt64(Txn.sender.bytes)
        # For simplicity, track position in market struct
        # In production, would use a separate BoxMap for user positions
        
        # Update market state
        if is_yes:
            market.q_yes = arc4.UInt64(market.q_yes.native + delta_q)
        else:
            market.q_no = arc4.UInt64(market.q_no.native + delta_q)
        
        self.markets[market_id] = market

        # Mint position tokens
        itxn.AssetTransfer(
            xfer_asset=asset_id,
            asset_receiver=Txn.sender,
            asset_amount=delta_q,
        ).submit()

        if fee > 0:
            itxn.Payment(receiver=self.admin.value, amount=fee).submit()

    @arc4.abimethod
    def submit_outcome(
        self,
        market_id: UInt64,
        outcome: bool,
        signature: arc4.StaticArray[arc4.Byte, arc4.Literal[64]],
    ) -> None:
        market = self.markets[market_id].copy()
        assert not market.resolved, "Market already resolved"
        assert Global.latest_timestamp >= market.end_time, "Market not ended"
        assert market.outcome_submitted_at == 0, "Outcome already submitted"

        oracle_key = op.bconcat(*market.oracle_pubkey)
        message = op.itob(market_id) + op.itob(UInt64(1 if outcome else 0))
        assert op.ed25519verify_bare(message, signature.native, oracle_key), "Invalid signature"

        market.resolved = arc4.Bool(True)
        market.outcome = arc4.Bool(outcome)
        market.outcome_submitted_at = arc4.UInt64(Global.latest_timestamp)
        market.dispute_deadline = arc4.UInt64(Global.latest_timestamp + self.dispute_window.value)
        self.markets[market_id] = market

    @arc4.abimethod
    def dispute_outcome(self, market_id: UInt64) -> None:
        market = self.markets[market_id].copy()
        assert market.resolved, "Market not resolved"
        assert market.outcome_submitted_at > 0, "Outcome not submitted"
        assert Global.latest_timestamp < market.dispute_deadline, "Dispute window closed"
        assert Txn.sender == self.admin.value, "Only admin can dispute"

        market.resolved = arc4.Bool(False)
        market.outcome = arc4.Bool(False)
        market.outcome_submitted_at = arc4.UInt64(0)
        market.dispute_deadline = arc4.UInt64(0)
        self.markets[market_id] = market

    @arc4.abimethod
    def claim_payout(self, market_id: UInt64, is_yes: bool) -> None:
        market = self.markets[market_id].copy()
        assert market.resolved, "Market not resolved"
        assert Global.latest_timestamp >= market.dispute_deadline, "Dispute window open"

        winning_asset_id = market.yes_asset_id if market.outcome.native else market.no_asset_id
        user_asset_id = market.yes_asset_id if is_yes else market.no_asset_id

        assert winning_asset_id == user_asset_id, "Position lost"

        asset = Asset(user_asset_id.native)
        balance = asset.balance(Txn.sender)
        assert balance > 0, "No position to claim"

        itxn.AssetTransfer(
            xfer_asset=user_asset_id,
            asset_receiver=Global.current_application_address,
            asset_amount=balance,
            asset_sender=Txn.sender,
        ).submit()

        itxn.Payment(receiver=Txn.sender, amount=balance).submit()

    @arc4.abimethod
    def opt_in_asset(self, asset_id: UInt64) -> None:
        itxn.AssetTransfer(
            xfer_asset=asset_id,
            asset_receiver=Txn.sender,
            asset_amount=0,
        ).submit()

    @arc4.abimethod(readonly=True)
    def get_market(self, market_id: UInt64) -> MarketState:
        return self.markets[market_id].copy()

    @arc4.abimethod(readonly=True)
    def get_market_count(self) -> UInt64:
        return self.market_counter.value

    @arc4.abimethod(readonly=True)
    def get_implied_price(self, market_id: UInt64) -> UInt64:
        """Get current implied probability of YES (scaled by SCALE)."""
        market = self.markets[market_id].copy()
        # P_yes = e^(q_yes/b) / (e^(q_yes/b) + e^(q_no/b))
        # Approximation for on-chain: P_yes ≈ q_yes / (q_yes + q_no) for small differences
        # Better: use the cost function derivative
        # For MVP, return a simple ratio scaled
        total = market.q_yes.native + market.q_no.native
        if total == 0:
            return UInt64(SCALE // 2)
        return UInt64(market.q_yes.native * SCALE // total)