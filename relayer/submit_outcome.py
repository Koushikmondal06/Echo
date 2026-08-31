#!/usr/bin/env python3
"""
Submit oracle outcome to Algorand smart contract.
Called from TypeScript relayer via subprocess.
"""
import sys
import os
# Use the virtual environment's Python packages
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '.venv', 'lib', 'python3.13', 'site-packages'))

import sys
import json
import os
from algosdk import account, mnemonic, transaction, encoding
from algosdk.v2client import algod as algod_client
from base64 import b64decode

def submit_outcome(
    algod_address: str,
    algod_token: str,
    app_id: int,
    sender_mnemonic: str,
    market_id: int,
    outcome: bool,
    timestamp: int,
    signature_b64: str
) -> str:
    """Submit outcome to the prediction market contract."""
    
    # Initialize algod client
    client = algod_client.AlgodClient(algod_token, algod_address)
    
    # Get sender account
    private_key = mnemonic.to_private_key(sender_mnemonic)
    sender = account.address_from_private_key(private_key)
    
    # Get suggested params
    params = client.suggested_params()
    # Increase fee for multiple box_replace operations (each box_replace costs extra)
    params.fee = 10000  # 0.01 ALGO
    params.flat_fee = True
    
    # Decode signature
    signature = b64decode(signature_b64)
    
    # Prepare app call arguments
    # Method: submit_outcome(uint64, bool, uint64, byte[64])
    # First arg is method selector (4 bytes), then ABI-encoded args
    # Selector from compiled contract: 0xa2083a1c
    selector = bytes.fromhex('a2083a1c')
    
    app_args = [
        selector,
        market_id.to_bytes(8, 'little'),
        b'\x01' if outcome else b'\x00',
        timestamp.to_bytes(8, 'little'),
        signature,
    ]
    
    # Box reference: "markets" + market_id (8 bytes LE) (matching contract: "markets" + itob(market_id))
    box_name = b'markets' + market_id.to_bytes(8, 'little')
    
    # Create application call transaction (NoOp) with box reference
    txn = transaction.ApplicationNoOpTxn(
        sender=sender,
        sp=params,
        index=app_id,
        app_args=app_args,
        boxes=[(app_id, box_name)],
    )
    
    # Sign transaction
    signed_txn = txn.sign(private_key)
    
    # Submit transaction
    tx_id = client.send_transaction(signed_txn)
    
    # Wait for confirmation
    confirmed_txn = transaction.wait_for_confirmation(client, tx_id, 4)
    
    return tx_id


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python submit_outcome.py <config_json>", file=sys.stderr)
        sys.exit(1)
    
    try:
        config = json.loads(sys.argv[1])
        
        tx_id = submit_outcome(
            algod_address=config["algod_address"],
            algod_token=config["algod_token"],
            app_id=config["app_id"],
            sender_mnemonic=config["sender_mnemonic"],
            market_id=config["market_id"],
            outcome=config["outcome"],
            timestamp=config["timestamp"],
            signature_b64=config["signature_b64"],
        )
        
        print(json.dumps({"tx_id": tx_id}))
        
    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)