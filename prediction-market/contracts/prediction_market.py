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
    Box,
    GlobalState,
    LocalState,
)


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


class PredictionMarket(ARC4Contract):
    def __init__(self) -> None:
        self.admin = GlobalState(Account)
        self.oracle_pubkey = GlobalState(Bytes)
        self.dispute_window = GlobalState(UInt64)
        self.markets = BoxMap(UInt64, MarketState)
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

    @arc4.abimethod
    def create_market(
        self,
        polymarket_condition_id: String,
        polymarket_question: String,
        end_time: UInt64,
        oracle_pubkey: arc4.StaticArray[arc4.Byte, arc4.Literal[32]],
    ) -> UInt64:
        assert Txn.sender == self.admin.value, "Only admin can create markets"
        assert end_time > Global.latest_timestamp, "End time must be in future"

        market_id = self.market_counter.value
        self.market_counter.value = market_id + 1

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

        assert Txn.sender == asset.freeze_address, "Must opt-in first"

        amount = payment.native
        fee = (amount * self.fee_bps.value) // 10_000
        position_amount = amount - fee

        itxn.AssetTransfer(
            xfer_asset=asset_id,
            asset_receiver=Txn.sender,
            asset_amount=position_amount,
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