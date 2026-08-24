import logging
import base64

import algokit_utils

logger = logging.getLogger(__name__)


def deploy() -> None:
    from smart_contracts.artifacts.prediction_market.prediction_market_client import (
        PredictionMarketFactory,
        PredictionMarketMethodCallCreateParams,
        CreateAppArgs,
    )

    algorand = algokit_utils.AlgorandClient.from_environment()
    deployer_ = algorand.account.from_environment("DEPLOYER")

    factory = algorand.client.get_typed_app_factory(
        PredictionMarketFactory, default_sender=deployer_.address
    )

    # Use a real ed25519 keypair for the oracle
    # Private key (base64): BoiPb+LD9FZeZwChd4dlOzbN547IBg5Y4+q/IgnJDEE=
    # Public key (base64): JqIZLptGkILqA6Yb+QWTEaq6QPJpB73iVViuPrJg0A4=
    oracle_pubkey_b64 = "JqIZLptGkILqA6Yb+QWTEaq6QPJpB73iVViuPrJg0A4="
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