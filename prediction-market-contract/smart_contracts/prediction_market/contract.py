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
    urange,
    ensure_budget,
)
from typing import Literal


# Constants (Python integers for compile-time computation)
SCALE = 1_000_000  # 6 decimal places (micro-shares)
MAX_TRADE_SHARES = 10_000_000  # Max 10 tokens per trade
LOOKUP_TABLE_SIZE = 10  # Minimal for opcode budget
MAX_POSITION_PCT = 5  # Max 5% of seed liquidity per user

# Precomputed step size for lookup table (as Python int for compile-time)
LOOKUP_STEP = MAX_TRADE_SHARES // LOOKUP_TABLE_SIZE


class MarketState(arc4.Struct):
    polymarket_condition_id: arc4.StaticArray[arc4.Byte, Literal[66]]  # "0x" + 64 hex chars = 66
    polymarket_question: arc4.StaticArray[arc4.Byte, Literal[256]]  # Max 256 bytes
    end_time: arc4.UInt64
    oracle_pubkey: arc4.StaticArray[arc4.Byte, Literal[32]]
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
        self.cost_lookups = BoxMap(UInt64, arc4.StaticArray[arc4.UInt64, Literal[11]])
        self.user_positions = BoxMap(UInt64, UserPosition)
        self.market_counter = GlobalState(UInt64)
        self.fee_bps = GlobalState(UInt64)

    @arc4.abimethod(create="require")
    def create_app(
        self,
        admin: Account,
        oracle_pubkey: arc4.StaticArray[arc4.Byte, Literal[32]],
        dispute_window: UInt64,
        fee_bps: UInt64,
    ) -> None:
        self.admin.value = admin
        pk_bytes = Bytes()
        for i in urange(32):
            pk_bytes += oracle_pubkey[i].bytes
        self.oracle_pubkey.value = pk_bytes
        self.dispute_window.value = dispute_window
        self.fee_bps.value = fee_bps
        self.market_counter.value = UInt64(0)

    @subroutine
    def concat_bytes(self, arr: arc4.StaticArray[arc4.Byte, Literal[32]]) -> Bytes:
        """Concatenate 32 bytes into a single Bytes value."""
        result = Bytes()
        for i in urange(32):
            result += arr[i].bytes
        return result

    @subroutine
    def build_and_store_lookup_table(self, market_id: UInt64, b: UInt64) -> None:
        """Build and store piecewise-linear lookup table for C(q, 0) - C(0, 0)."""
        temp_table = arc4.DynamicArray[arc4.UInt64]()
        step = UInt64(LOOKUP_STEP)
        
        # Quadratic approximation: cost = q * ln2_scaled + q^2 // (2*b)
        ln2_scaled = UInt64(693_147)  # ln(2) * 1_000_000
        b_val = UInt64(1_000_000_000)
        
        for i in urange(LOOKUP_TABLE_SIZE + 1):
            q = i * step
            max_q = UInt64(MAX_TRADE_SHARES)
            if q > max_q:
                q = max_q
            
            cost = (q * ln2_scaled) // SCALE + (q * q) // (2 * b_val)
            temp_table.append(arc4.UInt64(cost))
        
        # Convert to StaticArray
        table = arc4.StaticArray[arc4.UInt64, Literal[11]](
            temp_table[0], temp_table[1], temp_table[2], temp_table[3],
            temp_table[4], temp_table[5], temp_table[6], temp_table[7],
            temp_table[8], temp_table[9], temp_table[10]
        )
        
        self.cost_lookups[market_id] = table.copy()

    @subroutine
    def approx_cost_from_table(
        self,
        q_yes: UInt64,
        q_no: UInt64,
        table: arc4.StaticArray[arc4.UInt64, Literal[11]],
    ) -> UInt64:
        """Approximate incremental cost C(q_yes, q_no) - C(0, 0) using lookup table.
        
        Uses identity: C(q_yes, q_no) = min(q_yes, q_no) + C(|q_yes - q_no|, 0)
        """
        m: UInt64 = q_yes if q_yes < q_no else q_no
        d: UInt64 = q_yes - q_no if q_yes > q_no else q_no - q_yes
        
        if d == 0:
            return m
        
        step = UInt64(LOOKUP_STEP)
        idx = d // step
        max_idx = UInt64(LOOKUP_TABLE_SIZE - 1)
        if idx >= LOOKUP_TABLE_SIZE:
            idx = max_idx
        
        t = (d % step) * SCALE // step
        cost_low: UInt64 = table[idx].native
        cost_high: UInt64 = table[idx + 1].native
        cost_d: UInt64 = cost_low + (t * (cost_high - cost_low)) // SCALE
        
        result: UInt64 = m + cost_d
        return result

    @subroutine
    def compute_buy_cost(
        self,
        q_yes: UInt64,
        q_no: UInt64,
        buy_yes: bool,
        delta_q: UInt64,
        table: arc4.StaticArray[arc4.UInt64, Literal[11]],
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
        polymarket_condition_id: arc4.StaticArray[arc4.Byte, Literal[66]],
        polymarket_question: arc4.StaticArray[arc4.Byte, Literal[256]],
        end_time: UInt64,
        oracle_pubkey: arc4.StaticArray[arc4.Byte, Literal[32]],
        polymarket_price_yes: UInt64,
        seed_liquidity: UInt64,
        b_param: UInt64,
        yes_asset_id: UInt64,
        no_asset_id: UInt64,
    ) -> UInt64:
        assert Txn.sender == self.admin.value, "Only admin can create markets"
        assert end_time > Global.latest_timestamp, "End time must be in future"
        assert polymarket_price_yes > 0 and polymarket_price_yes < SCALE, "Invalid price"
        assert seed_liquidity > 0, "Seed liquidity required"
        assert b_param > 0, "b_param must be positive"
        assert yes_asset_id > 0 and no_asset_id > 0, "Asset IDs required"
        
        market_id = self.market_counter.value
        self.market_counter.value = market_id + 1

        # Initialize q_yes, q_no to match Polymarket price
        p_scaled = polymarket_price_yes
        delta = (UInt64(2) * p_scaled - SCALE) * b_param // SCALE
        
        base_shares = seed_liquidity
        
        if delta >= 0:
            q_yes = base_shares + delta
            q_no = base_shares
        else:
            q_yes = base_shares
            q_no = base_shares - delta
        
        max_position = seed_liquidity * MAX_POSITION_PCT // 100

        # Build and store LMSR lookup table
        self.build_and_store_lookup_table(market_id, b_param)

        self.markets[market_id] = MarketState(
            polymarket_condition_id=polymarket_condition_id.copy(),
            polymarket_question=polymarket_question.copy(),
            end_time=arc4.UInt64(end_time),
            oracle_pubkey=oracle_pubkey.copy(),
            yes_asset_id=arc4.UInt64(yes_asset_id),
            no_asset_id=arc4.UInt64(no_asset_id),
            resolved=arc4.Bool(False),
            outcome=arc4.Bool(False),
            outcome_submitted_at=arc4.UInt64(0),
            dispute_deadline=arc4.UInt64(0),
            q_yes=arc4.UInt64(q_yes),
            q_no=arc4.UInt64(q_no),
            b_param=arc4.UInt64(b_param),
            seed_liquidity=arc4.UInt64(seed_liquidity),
            max_position_per_user=arc4.UInt64(max_position),
        )

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
        assert asset.frozen(Txn.sender) == False, "Must opt-in first"

        amount = payment.native
        fee = (amount * self.fee_bps.value) // 10_000
        position_amount = amount - fee

        # Get cost lookup from separate box
        cost_lookup = self.cost_lookups[market_id].copy()

        # Compute shares to mint using LMSR cost function
        delta_q = self.compute_buy_cost(
            market.q_yes.native,
            market.q_no.native,
            is_yes,
            position_amount,
            cost_lookup,
        )

        assert delta_q > 0, "Invalid trade size"

        # Update market state
        if is_yes:
            market.q_yes = arc4.UInt64(market.q_yes.native + delta_q)
        else:
            market.q_no = arc4.UInt64(market.q_no.native + delta_q)
        
        self.markets[market_id] = market.copy()

        # Mint position tokens
        itxn.AssetTransfer(
            xfer_asset=asset_id.native,
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
        timestamp: UInt64,
        signature: arc4.StaticArray[arc4.Byte, Literal[64]],
    ) -> None:
        # Read market box directly to avoid copying full struct
        # BoxMap key format: "markets" + market_id (8 bytes LE)
        box_key = Bytes(b"markets") + op.itob(market_id)
        box_val, exists = op.Box.get(box_key)
        assert exists, "Market not found"
        
        # Read resolved field (offset 378, 1 byte)
        resolved_bytes = op.Box.extract(box_key, 378, 1)
        assert resolved_bytes == b"\x00", "Market already resolved"
        
        # Check end_time (offset 322, 8 bytes)
        end_time_bytes = op.Box.extract(box_key, 322, 8)
        end_time = op.btoi(end_time_bytes)
        assert Global.latest_timestamp >= end_time, "Market not ended"
        
        # Check outcome_submitted_at (offset 380, 8 bytes)
        submitted_at_bytes = op.Box.extract(box_key, 380, 8)
        submitted_at = op.btoi(submitted_at_bytes)
        assert submitted_at == 0, "Outcome already submitted"
        
        # Verify signature using ed25519verify with oracle address in accounts[1]
        # Message format: market_id (8 bytes LE) + outcome (1 byte) + timestamp (8 bytes LE)
        outcome_byte = arc4.Byte(1 if outcome else 0)
        message = op.itob(market_id) + outcome_byte.bytes + op.itob(timestamp)
        assert op.ed25519verify(message, signature.bytes, Txn.accounts[1]), "Invalid signature"
        
        # Update market state using splice for efficiency (single operation per field)
        # resolved = True (offset 378, 1 byte)
        op.Box.splice(box_key, 378, 1, b"\x01")
        # outcome (offset 379, 1 byte)
        outcome_byte = arc4.Byte(1 if outcome else 0)
        op.Box.splice(box_key, 379, 1, outcome_byte.bytes)
        # outcome_submitted_at = Global.latest_timestamp (offset 380, 8 bytes)
        op.Box.splice(box_key, 380, 8, op.itob(Global.latest_timestamp))
        # dispute_deadline = Global.latest_timestamp + dispute_window (offset 388, 8 bytes)
        dispute_deadline = Global.latest_timestamp + self.dispute_window.value
        op.Box.splice(box_key, 388, 8, op.itob(dispute_deadline))

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
        self.markets[market_id] = market.copy()

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
            xfer_asset=user_asset_id.native,
            asset_receiver=Global.current_application_address,
            asset_amount=balance,
            asset_sender=Txn.sender,
        ).submit()

        itxn.Payment(receiver=Txn.sender, amount=balance).submit()

    @arc4.abimethod
    def opt_in_asset(self, asset_id: arc4.UInt64) -> None:
        itxn.AssetTransfer(
            xfer_asset=asset_id.native,
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
    def get_implied_price(self, market_id: UInt64) -> arc4.UInt64:
        """Get current implied probability of YES (scaled by SCALE)."""
        market = self.markets[market_id].copy()
        total = market.q_yes.native + market.q_no.native
        if total == 0:
            return arc4.UInt64(SCALE // 2)
        return arc4.UInt64(market.q_yes.native * SCALE // total)