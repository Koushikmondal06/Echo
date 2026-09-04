import logging
import base64
import os

import algokit_utils
from algokit_utils import (
    AlgorandClient,
    AlgoClientConfigs,
    AlgoClientNetworkConfig,
)

logger = logging.getLogger(__name__)


def deploy() -> None:
    from smart_contracts.artifacts.prediction_market.prediction_market_client import (
        PredictionMarketFactory,
        PredictionMarketMethodCallCreateParams,
        CreateAppArgs,
    )

    # Configure for TestNet explicitly
    algod_config = AlgoClientNetworkConfig(
        server="https://testnet-api.algonode.cloud",
        token="",
    )
    indexer_config = AlgoClientNetworkConfig(
        server="https://testnet-idx.algonode.cloud",
        token="",
    )
    kmd_config = AlgoClientNetworkConfig(server="http://localhost:4002")
    client_config = AlgoClientConfigs(algod_config=algod_config, indexer_config=indexer_config, kmd_config=kmd_config)
    
    algorand = AlgorandClient(client_config)
    
    # Get deployer from mnemonic
    deployer_mnemonic = os.environ.get("DEPLOYER_MNEMONIC", "animal south script artwork churn wrong ankle siege session hamster toilet deal proof innocent raven churn bitter mammal ripple cry primary power entire absent budget")
    deployer_ = algorand.account.from_mnemonic(mnemonic=deployer_mnemonic)

    factory = algorand.client.get_typed_app_factory(
        PredictionMarketFactory, default_sender=deployer_.address
    )

    # Use relayer's ed25519 keypair for the oracle
    # Public key (base64): Qk1rYDoiH0yy1T0j2xv9D+6HVKaIqdRCZyqas23CnRE=
    oracle_pubkey_b64 = "Qk1rYDoiH0yy1T0j2xv9D+6HVKaIqdRCZyqas23CnRE="
    oracle_pubkey = base64.b64decode(oracle_pubkey_b64)
    
    app_client, result = factory.deploy(
        create_params=PredictionMarketMethodCallCreateParams(
            args=CreateAppArgs(
                admin=deployer_.address,
                oracle_pubkey=oracle_pubkey,
                dispute_window=86400,  # 24 hours
                fee_bps=100,  # 1% fee
            ),
        ),
        on_update=algokit_utils.OnUpdate.AppendApp,
        on_schema_break=algokit_utils.OnSchemaBreak.AppendApp,
    )

    if result.operation_performed in [
        algokit_utils.OperationPerformed.Create,
        algokit_utils.OperationPerformed.Replace,
    ]:
        algorand.send.payment(
            algokit_utils.PaymentParams(
                amount=algokit_utils.AlgoAmount(algo=1),
                sender=deployer_.address,
                receiver=app_client.app_address,
            )
        )

    logger.info(f"Deployed PredictionMarket app ({app_client.app_id})")
    logger.info(f"Oracle public key: {oracle_pubkey_b64}")