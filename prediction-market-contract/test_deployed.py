#!/usr/bin/env python3
"""Test the deployed PredictionMarket contract on TestNet."""

import os
import base64
import time
import algokit_utils
from algokit_utils import (
    AlgorandClient, 
    AlgoAmount,
    AlgoClientConfigs,
    AlgoClientNetworkConfig,
    AssetCreateParams,
    AssetTransferParams,
    SendParams,
)
from smart_contracts.artifacts.prediction_market.prediction_market_client import (
    PredictionMarketClient,
    CreateMarketArgs,
    BuyPositionArgs,
    SubmitOutcomeArgs,
    ClaimPayoutArgs,
    OptInAssetArgs,
    OptInContractToAssetArgs,
)

# TestNet configuration
ALGOD_ADDRESS = "https://testnet-api.algonode.cloud"
ALGOD_TOKEN = ""
INDEXER_ADDRESS = "https://testnet-idx.algonode.cloud"
INDEXER_TOKEN = ""

# Deployed contract (Fixed version with off-chain lookup table)
APP_ID = 771008896

# Oracle keypair (from deploy_config.py)
ORACLE_PUBKEY_B64 = "Qk1rYDoiH0yy1T0j2xv9D+6HVKaIqdRCZyqas23CnRE="
ORACLE_PRIVATE_KEY_B64 = "hR3tpgnwQbUB9eGzxA8DTIL6Aw40SRAQ7L7Gbz+YmalCTWtgOiIfTLLVPSPbG/0P7odUpoip1EJnKpqzbcKdEQ=="

# Deployer (from .env)
DEPLOYER_MNEMONIC = "animal south script artwork churn wrong ankle siege session hamster toilet deal proof innocent raven churn bitter mammal ripple cry primary power entire absent budget"

# Test user
TEST_USER_MNEMONIC = "section insane outdoor idea destroy interest kind stamp next write please aspect junior mountain hub miss custom that series alpha honey jeans valve absent print"


def main():
    # Initialize Algorand client
    algod_config = AlgoClientNetworkConfig(server=ALGOD_ADDRESS, token=ALGOD_TOKEN)
    indexer_config = AlgoClientNetworkConfig(server=INDEXER_ADDRESS, token=INDEXER_TOKEN)
    kmd_config = AlgoClientNetworkConfig(server="http://localhost:4002")  # Not used for TestNet
    client_config = AlgoClientConfigs(algod_config=algod_config, indexer_config=indexer_config, kmd_config=kmd_config)
    algorand = AlgorandClient(client_config)
    
    # Get deployer account
    deployer = algorand.account.from_mnemonic(mnemonic=DEPLOYER_MNEMONIC)
    print(f"Deployer: {deployer.address}")
    
    # Get test user account (use deployer since test user has 0 ALGO on TestNet)
    test_user = deployer
    print(f"Test User (using deployer): {test_user.address}")
    
    # Initialize contract client
    client = PredictionMarketClient(algorand=algorand, app_id=APP_ID, default_sender=deployer.address)
    print(f"Contract App ID: {client.app_id}")
    print(f"Contract Address: {client.app_address}")
    
    # Fund contract with extra ALGO for asset minimum balance (0.1 ALGO per asset)
    print("\n=== Funding contract ===")
    contract_address = client.app_address
    algorand.send.payment(
        algokit_utils.PaymentParams(
            sender=deployer.address,
            receiver=contract_address,
            amount=AlgoAmount(algo=5),  # 5 ALGO for multiple asset opt-ins
        )
    )
    print(f"Funded contract with 5 ALGO: {contract_address}")
    
    # Check global state
    global_state = client.state.global_state.get_all()
    print(f"\nGlobal State: {global_state}")
    
    # Create YES and NO ASA assets
    print("\n=== Creating YES/NO ASA Assets ===")
    yes_asset_result = algorand.send.asset_create(
        AssetCreateParams(
            sender=deployer.address,
            total=1_000_000_000_000,  # 1M tokens with 6 decimals
            decimals=6,
            default_frozen=False,
            unit_name="YES",
            asset_name="Yes Position Token",
            manager=deployer.address,
            reserve=deployer.address,
            freeze=deployer.address,
            clawback=deployer.address,
            validity_window=1000,
        )
    )
    yes_asset_id = yes_asset_result.asset_id
    print(f"YES Asset ID: {yes_asset_id}")
    
    no_asset_result = algorand.send.asset_create(
        AssetCreateParams(
            sender=deployer.address,
            total=1_000_000_000_000,
            decimals=6,
            default_frozen=False,
            unit_name="NO",
            asset_name="No Position Token",
            manager=deployer.address,
            reserve=deployer.address,
            freeze=deployer.address,
            clawback=deployer.address,
            validity_window=1000,
        )
    )
    no_asset_id = no_asset_result.asset_id
    print(f"NO Asset ID: {no_asset_id}")
    
    # Wait for assets to be created
    time.sleep(3)
    
    # Opt-in deployer to both assets (for creating market)
    print("\n=== Opt-in to Assets ===")
    algorand.send.asset_transfer(
        AssetTransferParams(
            sender=deployer.address,
            receiver=deployer.address,
            asset_id=yes_asset_id,
            amount=0,
            validity_window=1000,
        )
    )
    algorand.send.asset_transfer(
        AssetTransferParams(
            sender=deployer.address,
            receiver=deployer.address,
            asset_id=no_asset_id,
            amount=0,
            validity_window=1000,
        )
    )
    print("Deployer opted in to both assets")
    
    # Create NEW assets with CONTRACT as clawback (required for contract to pull tokens from deployer)
    print("\n=== Creating assets with contract as clawback ===")
    contract_address = client.app_address
    yes_asset_result = algorand.send.asset_create(
        AssetCreateParams(
            sender=deployer.address,
            total=1_000_000_000_000,
            decimals=6,
            default_frozen=False,
            unit_name="YES",
            asset_name="Yes Position Token",
            manager=deployer.address,
            reserve=deployer.address,
            freeze=deployer.address,
            clawback=contract_address,  # Contract can pull from deployer
            validity_window=1000,
        )
    )
    yes_asset_id = yes_asset_result.asset_id
    print(f"YES Asset ID (contract clawback): {yes_asset_id}")
    
    no_asset_result = algorand.send.asset_create(
        AssetCreateParams(
            sender=deployer.address,
            total=1_000_000_000_000,
            decimals=6,
            default_frozen=False,
            unit_name="NO",
            asset_name="No Position Token",
            manager=deployer.address,
            reserve=deployer.address,
            freeze=deployer.address,
            clawback=contract_address,  # Contract can pull from deployer
            validity_window=1000,
        )
    )
    no_asset_id = no_asset_result.asset_id
    print(f"NO Asset ID (contract clawback): {no_asset_id}")
    
    time.sleep(3)
    
    # Opt-in deployer to new assets
    print("\n=== Opt-in to new assets ===")
    algorand.send.asset_transfer(
        AssetTransferParams(
            sender=deployer.address,
            receiver=deployer.address,
            asset_id=yes_asset_id,
            amount=0,
            validity_window=1000,
        )
    )
    algorand.send.asset_transfer(
        AssetTransferParams(
            sender=deployer.address,
            receiver=deployer.address,
            asset_id=no_asset_id,
            amount=0,
            validity_window=1000,
        )
    )
    print("Deployer opted in to new assets")
    
    # Opt-in contract to new assets (required for clawback)
    print("\n=== Opt-in contract to new assets ===")
    from smart_contracts.artifacts.prediction_market.prediction_market_client import OptInContractToAssetArgs
    client.send.opt_in_contract_to_asset(
        args=OptInContractToAssetArgs(asset_id=yes_asset_id),
        params=algokit_utils.CommonAppCallParams(
            validity_window=1000,
            extra_fee=AlgoAmount(micro_algo=2000),
        ),
        send_params=SendParams(max_rounds_to_wait_for_confirmation=20)
    )
    client.send.opt_in_contract_to_asset(
        args=OptInContractToAssetArgs(asset_id=no_asset_id),
        params=algokit_utils.CommonAppCallParams(
            validity_window=1000,
            extra_fee=AlgoAmount(micro_algo=2000),
        ),
        send_params=SendParams(max_rounds_to_wait_for_confirmation=20)
    )
    print("Contract opted in to new assets")
    
    # Create a market
    print("\n=== Creating Market ===")
    import base64
    oracle_pubkey = base64.b64decode(ORACLE_PUBKEY_B64)
    
    # Market parameters
    # polymarket_condition_id must be exactly 66 bytes: "0x" + 64 hex chars
    polymarket_condition_id_str = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"
    polymarket_condition_id = polymarket_condition_id_str.encode('utf-8')
    polymarket_question_str = "Will ETH price exceed $3000 by end of 2024?" + " " * (256 - 43)
    polymarket_question = polymarket_question_str.encode('utf-8')
    print(f"Condition ID length: {len(polymarket_condition_id)}")
    print(f"Question length: {len(polymarket_question)}")
    end_time = int(time.time()) + 86400  # 24 hours from now
    polymarket_price_yes = 650000  # 65% (scaled by 1_000_000)
    seed_liquidity = 1_000_000_000  # 1000 ALGO in microAlgos
    b_param = 1_000_000_000_000  # 1000 * SCALE
    
    # Pre-computed lookup table for b_param = 1_000_000_000_000
    # Using formula: cost = q * ln2_scaled + q^2 // (2 * b)
    # LOOKUP_STEP = 2_000_000, LOOKUP_TABLE_SIZE = 5 (6 points)
    cost_lookup = (0, 1388294, 2780588, 4176882, 5577176, 6981470)
    
    # Use send method with skip_simulation
    print("\n=== Creating Market (with pre-computed lookup table) ===")
    import struct
    market_id_bytes = struct.pack("<Q", 0)  # market_id=0
    cost_lookups_key = b"cost_lookups" + market_id_bytes
    markets_key = b"markets" + market_id_bytes
    result = client.send.create_market(
        args=CreateMarketArgs(
            polymarket_condition_id=polymarket_condition_id,
            polymarket_question=polymarket_question,
            end_time=end_time,
            oracle_pubkey=oracle_pubkey,
            polymarket_price_yes=polymarket_price_yes,
            seed_liquidity=seed_liquidity,
            b_param=b_param,
            yes_asset_id=yes_asset_id,
            no_asset_id=no_asset_id,
            cost_lookup=cost_lookup,
        ),
        params=algokit_utils.CommonAppCallParams(
            validity_window=1000,
            extra_fee=AlgoAmount(micro_algo=5000),
            box_references=[
                algokit_utils.BoxReference(app_id=771008896, name=cost_lookups_key),
                algokit_utils.BoxReference(app_id=771008896, name=markets_key),
            ],
        ),
        send_params=SendParams(
            max_rounds_to_wait_for_confirmation=20,
            populate_app_call_resources=False,
        )
    )
    market_id = result.abi_return
    print(f"Market created with ID: {market_id}")
    
    # Verify market creation
    market = client.send.get_market(
        args=(0,),
        params=algokit_utils.CommonAppCallParams(validity_window=1000)
    ).abi_return
    print(f"Market details:")
    print(f"  Condition ID: {market.polymarket_condition_id}")
    print(f"  Question: {market.polymarket_question}")
    print(f"  End Time: {market.end_time}")
    print(f"  YES Asset: {market.yes_asset_id}")
    print(f"  NO Asset: {market.no_asset_id}")
    print(f"  Resolved: {market.resolved}")
    print(f"  q_yes: {market.q_yes}")
    print(f"  q_no: {market.q_no}")
    print(f"  Implied Price: {market.q_yes * 1_000_000 // (market.q_yes + market.q_no) / 1_000_000:.4f}")
    
    # Test user opts in to assets
    print("\n=== Test User Opt-in ===")
    client_test_user = client.clone(default_sender=test_user.address)
    client_test_user.send.opt_in_asset(
        args=OptInAssetArgs(asset_id=yes_asset_id),
        params=algokit_utils.CommonAppCallParams(
            validity_window=1000,
            extra_fee=AlgoAmount(micro_algo=2000),  # Cover inner txn fee
        ),
        send_params=SendParams(max_rounds_to_wait_for_confirmation=20)
    )
    client_test_user.send.opt_in_asset(
        args=OptInAssetArgs(asset_id=no_asset_id),
        params=algokit_utils.CommonAppCallParams(
            validity_window=1000,
            extra_fee=AlgoAmount(micro_algo=2000),  # Cover inner txn fee
        ),
        send_params=SendParams(max_rounds_to_wait_for_confirmation=20)
    )
    print("Test user opted in to both assets")
    
    # Test user buys YES position
    print("\n=== Buying YES Position ===")
    payment = 10_000_000  # 10 ALGO in microAlgos
    result = client_test_user.send.buy_position(
        args=BuyPositionArgs(
            market_id=market_id,
            is_yes=True,
            payment=payment,
        ),
        params=algokit_utils.CommonAppCallParams(
            validity_window=1000,
            extra_fee=AlgoAmount(micro_algo=3000),  # Cover inner txn fees (asset transfer + payment)
        ),
        send_params=SendParams(
            max_rounds_to_wait_for_confirmation=20,
        )
    )
    print(f"Buy YES transaction: {result.tx_id}")
    print(f"Confirmed in round: {result.confirmed_round}")
    
    # Check market state after buy
    market = client.send.get_market(
        args=(market_id,),
        params=algokit_utils.CommonAppCallParams(validity_window=1000)
    ).abi_return
    print(f"Market after buy:")
    print(f"  q_yes: {market.q_yes}")
    print(f"  q_no: {market.q_no}")
    print(f"  Implied Price: {market.q_yes * 1_000_000 // (market.q_yes + market.q_no) / 1_000_000:.4f}")
    
    # Check user balance
    account_info = algorand.client.algod.account_info(test_user.address)
    for asset in account_info.get('assets', []):
        if asset['asset-id'] == yes_asset_id:
            print(f"User YES balance: {asset['amount']}")
        elif asset['asset-id'] == no_asset_id:
            print(f"User NO balance: {asset['amount']}")
    
    # Test get_implied_price
    price = client.send.get_implied_price(
        args=(market_id,),
        params=algokit_utils.CommonAppCallParams(validity_window=1000)
    ).abi_return
    print(f"Implied price (scaled): {price}")
    print(f"Implied price (%): {price / 1_000_000 * 100:.2f}%")
    
    print("\n=== Test Complete ===")
    print(f"Market ID: {market_id}")
    print(f"YES Asset ID: {yes_asset_id}")
    print(f"NO Asset ID: {no_asset_id}")
    print(f"Contract App ID: {APP_ID}")


if __name__ == "__main__":
    main()