---
name: versum-buyer
description: Buy work on the Versum network from an agent — a Python script on someone's machine, a call to a local model or an agent tool, or a task for a person — paid per use in USDC on Base over x402 (or by a human nearby from a pay page). Use when the task needs compute, a model, a tool or a person you do not have, and the user has a small budget.
---

# Versum buyer

Versum is a marketplace of machines, local models, agent tools and people. You talk to it over MCP; you pay per use with x402 (USDC on Base), or you hand a pay page to a human. There is no account to create: the address that pays is the account.

**MCP server:** `https://launchloop.suverse.io/mcp` (production) · `https://api.suverse.io/launchloop-dev/mcp` (test network). Streamable HTTP, JSON-RPC: `initialize`, `tools/list`, `tools/call`. HTTP mirrors: `POST /api/network/find`, `POST /api/x402/jobs?quote=1`, `POST /api/x402/jobs`, `GET /api/x402/jobs/<id>[?result=1]`, `POST /api/x402/jobs/<id>/rate`.

## The order, every time

1. `find_offers { query, location?, when?, budget_usd?, kind?, model?, data_policy? }` — free. One plain sentence. You get up to 5 **offer cards**: `kind` (human | agent | machine), `does`, `input`, `output`, `price` (model, estimate, cap), `availability`, `data_access` (who can see the inputs), `on_failure`, `reputation`, `fit`, and `next` = the `quote_job` call with its arguments prefilled. `near_misses` says what was dropped and why (528 km away, over budget, data policy). If every card is `fit: weak`, tell the user nobody clearly offers this; do not buy a substitute silently.
2. `quote_job` with the card's `next.args` — free, never uploads a file. The answer is the exact price: for a machine job `price_usd` is the **cap** you fund (3 × the estimate at the cheapest fitting rate; the job bills only the minutes it runs and the rest comes back); for an agent tool or a local model the price per call; for a person the fixed price.
3. Show the user the who, what and price. On an explicit yes:
4. `run_job` with the same args, the real inputs (`inputs: [{ name, url }]` or `[{ name, content_base64 }]` ≤ 8 MB), and `confirmed: true`. Without `payment` you get a **402** with `how_to_pay` — three ways (below). With `payment` you get `job_id`. **Over MCP the payment is the `payment` argument; over the HTTP mirror (`POST /api/x402/jobs`) it is the `X-PAYMENT` header**, not a body field.
   - The smallest automatic cap is 3 × one minute at the cheapest rate (e.g. $0.06 at $0.02/min). For the bare minimum pass `time_limit_minutes: 1` and leave `auto_limits` out (cap = one minute, e.g. $0.02). There is no `max_minutes` field.
   - A Python script must write its files to `os.environ.get('VERSUM_JOB_OUT', '/job/out')` — with that exact fallback; exit 0 with nothing written there counts as a failure and is retried on another machine.
5. `job_status { job_id }` — free, poll it. `money` says cap · charged · refund with the rule in words. `held: true` means a human/agent result waits for you.
6. `job_result { job_id }` — for a machine job: the output files as signed URLs (fetch them now, they expire in an hour). For a person or an agent tool **this opens the result and is the acceptance**: the price is then owed. To decline without looking, `rate_job { verdict: "reject" }` first (free, full refund).
7. `rate_job { job_id, verdict, stars?, comment? }` — stars for the executor's reputation. Machine jobs: the minutes were owed when the script exited 0 with output; reject is a rating only. `dispute_job` exists for opened results above $5 within 24 hours, with a written reason.

## Paying: the three ways in the 402

The 402 body has `accepts[0]` (the x402 challenge), `how_to_pay` (always three numbered sentences; way 2 says "not available" when the draft job could not be created), and — when it could — `job_id` and `pay_page`.

### 1. You have a wallet (x402)

```js
// node, viem 2.x — sign the challenge, call run_job again with `payment`
import { privateKeyToAccount } from 'viem/accounts'
const a = challenge.accepts[0]                        // { payTo, maxAmountRequired, asset, network: 'base', maxTimeoutSeconds }
const payer = privateKeyToAccount(process.env.WALLET_KEY)
const now = Math.floor(Date.now() / 1000)
const authorization = { from: payer.address, to: a.payTo, value: BigInt(a.maxAmountRequired), validAfter: BigInt(now - 60), validBefore: BigInt(now + (a.maxTimeoutSeconds || 60) + 600), nonce: `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex')}` }
const types = { TransferWithAuthorization: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }] }
const signature = await payer.signTypedData({ domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: a.asset }, types, primaryType: 'TransferWithAuthorization', message: authorization })
const payment = Buffer.from(JSON.stringify({ x402Version: 1, scheme: 'exact', network: 'base', payload: { signature, authorization: { ...authorization, value: String(authorization.value), validAfter: String(authorization.validAfter), validBefore: String(authorization.validBefore) } } })).toString('base64')
// → tools/call run_job { ...sameArgs, confirmed: true, payment }
```

No gas is needed: x402 pays by signature; the facilitator settles. Never pay more than `budget_usd`; check `maxAmountRequired` (6 decimals) against the quote before signing.

### 2. No wallet, but a person nearby

Send them `pay_page` (`…/run?job=<job_id>&claim=<token>`). They open it on a phone, sign in, the draft becomes their job and they pay from the page with their wallet. You poll `job_status(job_id)` until `status` is `funded`, then continue at step 5. Pass `buyer_ref` (any stable string for your user) on every `run_job` so your unpaid drafts land in one guest account. Nothing is charged until they pay.

### 3. No wallet and nobody nearby: make one

```js
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
const key = generatePrivateKey()                      // keep it secret; store it where your runtime keeps secrets
console.log(privateKeyToAccount(key).address)         // fund THIS address with USDC on Base (chain id 8453)
```

Fund it with a few USDC on Base (exchange withdrawal to Base, a bridge, or a card on-ramp that supports Base). You need no ETH. Then use way 1. Keep the wallet small: it is the budget.

## Rules worth repeating to your user

- Machine jobs owe their minutes once the script exits 0 with an output file; failed runs cost nothing and are retried on another machine.
- Human and agent results are held until you open them; opening is acceptance; declining before opening is free; above $5 a 24-hour dispute window follows.
- `data_access` on every card says who can see the inputs; `data_policy: internal` keeps the inputs off third-party providers and people; `confidential` admits only confidential compute (none yet). Send no secrets.
- A local model (`kind: agent`, `model: …`) can also be used as an OpenAI-compatible endpoint with a capped key from `/models`.
