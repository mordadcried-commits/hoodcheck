# HoodCheck

**Token risk scanner for Robinhood Chain (4663).** Live: https://hoodcheck.onrender.com

Before you buy a token, check that you can sell it.

## Why this exists

On this chain the usual safety tools do not work. Measured on 2026-09-08:

| Service | Result on chain 4663 |
|---|---|
| GoPlus | supports the chain but returns **empty** `buy_tax` / `sell_tax` |
| Honeypot.is | `{"code":400,"error":"Invalid chain"}` |
| Rugcheck | Solana only |

HoodCheck simulates a real buy and a real sell in **two separate virtual blocks, 90 seconds
apart** — so anti-bot rules like "no buy and sell in the same block" do not raise a false
alarm — then computes what would actually land back in your wallet.

## What it checks

- **Can you actually sell it** — full round trip simulated, not a heuristic
- **Round-trip cost** — hidden taxes and thin liquidity show up here. A loss above 50% is
  treated as fatal: the sell may technically succeed while your money does not come back.
- **Exit currency** — on this chain many pools are quoted in tokenised equities (SPY, NVDA,
  HOOD…) or USDG, so selling gives you *that* asset and needs a second swap
- **First 60 seconds of trading** — how many separate wallets actually traded
- **Symbol collisions** — how many different tokens share the name
- **Holders, top-10 concentration, dev holding, source verification, launchpad**

## What it deliberately does NOT show

Fields such as *Insiders*, *Phishing*, *Bundler* and *Dex Paid* come from proprietary wallet
labelling that does not exist for this chain. Printing `0%` for something unknown would be
false reassurance, so those fields are omitted entirely rather than shown as zero.

The audit section is informational and does not affect the score. Dev holding was measured
against 24 of our own closed trades and did **not** separate winners from losers, so it is
shown but never scored.

## Run it yourself

    git clone https://github.com/mordadcried-commits/hoodcheck.git
    cd hoodcheck
    npm install
    npm start

Opens on http://127.0.0.1:8080. **No API key needed** — it falls back to the public RPC
(slower: ~19 s per scan instead of ~7 s).

### Optional environment variables

| Variable | Purpose |
|---|---|
| `HOODCHECK_RPC` | Private RPC endpoint. Much faster and avoids public-RPC rate limits. |
| `HOODCHECK_HOST` | `0.0.0.0` to accept outside connections. Defaults to localhost only. |
| `HOODCHECK_PORT` | Default 8080. |
| `SITE_URL` | Absolute URL, needed for social share cards. |
| `TRUST_PROXY` | Set to `1` behind a reverse proxy or CDN, otherwise rate limiting treats every visitor as one IP. |

## Safety

This service is **read-only**. It never handles a wallet key, never sends a transaction, and
deletes `PRIVATE_KEY` / `MNEMONIC` / `SEED_PHRASE` from its own environment at startup.
See [GUVENLIK.md](GUVENLIK.md) for the security review, including two holes that were found
by testing the live deployment and closed.

## This is not investment advice

The simulation measures the pool as it is right now; liquidity can be pulled in the very next
block. A token marked "low risk" can still lose you money — the tool detects traps, it does
not predict price. It reads on-chain data and it can be wrong.

Built with an AI agent, using an agentic loop.

MIT licensed.
