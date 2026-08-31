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
from algosdk.atomic_transaction_composer import AtomicTransactionComposer, TransactionWithSigner
from algosdk.abi import Method, Argument
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
    params.fee = 10000  # 0.01 ALGO
    params.flat_fee = True
    
    # Decode signature
    signature = b64decode(signature_b64)
    
    # Define the method signature
    method = Method.from_signature("submit_outcome(uint64,bool,uint64,byte[64])void")
    
    # Box reference: "markets" + market_id (8 bytes BE)
    box_name = b'markets' + market_id.to_bytes(8, 'big')
    
    from algosdk.atomic_transaction_composer import AccountTransactionSigner
    
    signer = AccountTransactionSigner(private_key)
    
    # Create atomic transaction composer
    atc = AtomicTransactionComposer()
    
    # Add method call with proper ABI encoding
    atc.add_method_call(
        app_id=app_id,
        method=method,
        sender=sender,
        sp=params,
        signer=signer,
        method_args=[
            market_id,           # uint64
            outcome,             # bool
            timestamp,           # uint64
            signature,           # byte[64]
        ],
        boxes=[(app_id, box_name)],
    )
    
    # Execute
    result = atc.execute(client, 4)
    
    return result.tx_ids[0]


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