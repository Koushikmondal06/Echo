# Algorand Prediction Market — Polymarket-Anchored

A decentralized prediction market on Algorand whose market outcomes are externally anchored to established Polymarket results, settled trustlessly through smart contracts rather than a trusted backend.

## Core Idea

Users trade YES/NO positions on Algorand. Each market mirrors a real Polymarket question. When the market ends, an oracle/relayer layer verifies Polymarket's final outcome, submits a signed result on-chain, and the Algorand smart contract — not the backend — controls settlement and payout.

> "The platform can't simply change the answer to steal my money. The outcome is anchored to an existing external prediction market."

## Architecture

```
                    POLYMARKET
                        │
                        │ API (Gamma / CLOB)
                        ▼
              ┌──────────────────┐
              │ Reference Oracle │
              │    / Relayer     │
              └────────┬─────────┘
                       │
                 Signed outcome
                       │
                       ▼
┌──────────┐     ┌──────────────────┐
│  Users   │────▶│ Algorand Market  │
└──────────┘     │  Smart Contract  │
                 └────────┬─────────┘
                          │
                    Verify signature
                          │
                 Dispute window (timelock)
                          │
                       Payout
```

## Tech Stack

| Layer | Choice | Notes |
|---|---|---|
| Smart contracts | Algorand Python (Puya) / PyTeal | Deployed via AlgoKit |
| Dev toolkit | AlgoKit | Scaffolding, LocalNet, testing, deploy |
| Tokens | Algorand Standard Assets (ASA) | YES/NO position tokens |
| Signature verification | Native ed25519 (AVM) | Oracle submissions verified on-chain |
| Oracle/relayer | Node.js (TypeScript) | Standalone service, independently deployable |
| Job scheduling | node-cron / BullMQ + Redis | Polls near market end dates, not continuously |
| Backend API | Fastify / FastAPI | Serves market data, mapping table, admin dashboard |
| Database | PostgreSQL | Algorand↔Polymarket market mapping, cache |
| Indexer | Algorand Indexer | Historical transactions and positions |
| Frontend | Next.js + React | Market browsing, trading UI |
| Wallet | `use-wallet` (Pera, Defly) | Client-side signing via `algosdk` |
| Networks | LocalNet → TestNet → MainNet | Never skip TestNet |
| Hosting | Railway / Render / Fly.io | Sufficient for MVP scale |

## Data Fetchers

The relayer and backend rely on several independent fetchers. Keeping them as separate, swappable modules is what makes the multi-oracle and fallback stories possible later.

| Fetcher | Source | Purpose |
|---|---|---|
| **Gamma Market Fetcher** | Polymarket Gamma API | Market discovery, question text, condition IDs, metadata |
| **CLOB Price Fetcher** | Polymarket CLOB API | Live order book / price feed for display and sanity-checking |
| **Resolution Finality Fetcher** | Polymarket Gamma + UMA dispute status | Confirms a market's outcome is *actually final* on Polymarket before treating it as settleable — prevents early/wrong settlement during a UMA dispute window |
| **Algorand Indexer Fetcher** | Algorand Indexer | Historical transactions, market state, user positions |
| **On-Chain Event Fetcher** | Algorand node (algod) | Listens for contract events (market created, outcome submitted, disputed, settled) to drive the admin dashboard in real time |
| **Secondary Reference Fetcher** (fallback) | Kalshi API (or similar) | Optional cross-check source for multi-oracle setups and as a fallback if Polymarket access changes or is restricted |
| **Liquidity/Health Fetcher** | Internal (derived from CLOB + on-chain trade volume) | Flags thin-liquidity markets at risk of manipulation, surfaced on the admin dashboard |

Each fetcher is designed to run independently with its own caching and retry logic so a failure in one (e.g. Polymarket API downtime) doesn't take down the others.

## Project Phases

- **Phase 0 — Foundations**: Legal/ToS check on Polymarket API usage, lock the market mapping schema, AlgoKit scaffold.
- **Phase 1 — Core Smart Contract**: Market creation, ASA escrow, signature verification, dispute window, payout logic.
- **Phase 2 — Oracle/Relayer**: Fetchers above, resolution finality check, signing, caching.
- **Phase 3 — Backend + Indexer**: REST API, Algorand Indexer, admin dashboard (pending markets, oracle status, dispute flags, mapping health).
- **Phase 4 — Frontend**: Market list/detail with transparent Polymarket reference, trade UI, positions.
- **Phase 5 — TestNet Integration**: End-to-end test including dispute window and delayed-resolution scenarios.
- **Phase 6 — Post-MVP**: Multi-oracle (2-of-3, independently hosted), multi-outcome markets, AMM liquidity, permissionless market creation, formal dispute resolution.

## Key Risks to Design Around

1. **Market matching** — question wording must exactly match the referenced Polymarket question and resolution criteria.
2. **Oracle security** — no single backend should be able to unilaterally determine payout; signature verification + dispute window is the MVP mitigation, multi-oracle is the target state.
3. **Polymarket dependency** — API changes, downtime, or access restrictions need a fallback (see Secondary Reference Fetcher).
4. **Liquidity** — thin markets are manipulable; surfaced via the Liquidity/Health Fetcher.

## Getting Started

```bash
# Scaffold contract project
algokit init

# Run LocalNet
algokit localnet start

# Install backend/relayer dependencies
npm install

# Run tests
algokit test
```

## Status

MVP in planning — see Phases above. TestNet deployment is the first public milestone.