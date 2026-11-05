# Serum v3 Open-Orders Recovery

A static, single-page tool that finds funds still stranded in **Serum v3 open-orders
accounts** and withdraws them, in-browser, through your own wallet.

Serum was shut down in November 2022 after the FTX collapse, but the on-chain program
`9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin` is immutable and was never upgraded.
`settleFunds` still works. Anyone who traded on Serum and never settled still has
balances sitting in open-orders accounts, plus ~0.0234 SOL of rent per account that
`closeOpenOrders` returns.

This page finds those accounts, shows you exactly what they hold and what it will sign,
and withdraws them.

## Security model

- **No backend, no CDN, no analytics, no build step at runtime.** One HTML file plus one
  vendored JS bundle. Nothing is fetched except from the RPC *you* enter.
- **Your private key never leaves your wallet.** The page uses the injected provider
  (Phantom / Backpack / Solflare) and only ever receives a signed transaction back.
- **Nothing is broadcast blind.** Each transaction is simulated *before* your wallet is
  prompted, and sent with `skipPreflight: false` so the RPC re-simulates the *signed*
  transaction and refuses to broadcast one that would fail.
- **Every account is validated against live chain state before use** — existence, owning
  program, 165-byte length, mint, owner field, initialised state, and no delegate.
- The RPC URL is stored in `localStorage` only and sent nowhere but to itself.

It builds exactly two instructions: `settleFunds` and `closeOpenOrders`. Use **Preview
instruction** to see every account and flag before you sign, and compare it with your
wallet's own transaction preview.

## Use it

1. Enter an RPC that permits `getProgramAccounts` and press **Test**.
2. **Connect wallet** — or paste any address to inspect it read-only.
3. **Scan**. Each open-orders account is listed with its market, balances, recoverable
   rent, and whether it is safe to settle.
4. **Settle & close** on each account you want to recover.

The button stays disabled unless the connected wallet actually owns that account.

### RPC requirement

The scan uses `getProgramAccounts`, which free public endpoints refuse:

| Endpoint | Result |
|---|---|
| `api.mainnet-beta.solana.com` | times out / unavailable |
| `solana-rpc.publicnode.com` | `403 Indexed requests require a personal token` |
| `solana.drpc.org` | `chain is not available on free plan` |
| Helius / Triton / QuickNode / your own node | works |

Helius's free tier is sufficient. Your API key stays in your browser.

## Self-hosting

It is a static site — drop it on anything.

**GitHub Pages** (this repo): Settings → Pages → Source: *Deploy from a branch* →
`main` / root. The site appears at `https://<user>.github.io/<repo>/`. No Jekyll
processing is needed; `vendor/app-core.js` is served as-is.

**Any static host** (Netlify, Cloudflare Pages, S3, nginx): upload `index.html` and
`vendor/`.

**Locally:**

```bash
npm run serve        # python3 -m http.server 8765
# open http://localhost:8765/
```

Note that opening `index.html` via `file://` will **not** work — ES module imports are
blocked by CORS on the `file:` origin. Serve over HTTP.

## Development

```bash
npm install
npm run bundle       # esbuild core.js -> vendor/app-core.js (self-contained, no CDN)
npm test             # see below; requires RPC_URL and TEST_ADDRESS
```

`core.js` holds all logic (no DOM) so it can be imported by both the page and the test
harness. `index.html` is UI only. **Re-run `npm run bundle` after editing `core.js`** —
the page loads the bundle, not the source, and a stale bundle fails silently at import
time if an export is missing.

### What the test proves

`test-core.mjs` runs against live mainnet and asserts, for every account found:

1. The instructions `core.js` builds are **byte-identical** to
   `@project-serum/serum`'s `DexInstructions.settleFunds` / `.closeOpenOrders` — same
   program id, same 5 data bytes, same key order, same signer/writable flags.
2. `settleFunds` carries 10 accounts including the referrer slot, and that slot is the
   quote wallet.
3. There is exactly one signer and it is the owner.
4. The assembled transaction **simulates successfully** on mainnet.

```bash
RPC_URL='https://mainnet.helius-rpc.com/?api-key=...' \
TEST_ADDRESS='<any wallet>' \
  npm test

# verify the shipped bundle rather than the source:
CORE_MODULE=./vendor/app-core.js RPC_URL=... TEST_ADDRESS=... npm test
```

No address is hardcoded, so this repo is safe to publish.

## How it works

Offsets come from `serum-dex/dex/src/state.rs` and the `MARKET_STATE_LAYOUT_V3`
definition in `@project-serum/serum`:

```
OpenOrders (3228 bytes)
  0..5     b"serum"      ACCOUNT_HEAD_PADDING
  5..13    account_flags u64      Initialized|OpenOrders = 0x5
  13..45   market        pubkey
  45..77   owner         pubkey   <- the memcmp filter offset
  77..85   base free     u64
  85..93   base total    u64
  93..101  quote free    u64
  101..109 quote total   u64
  109..125 free_slot_bits  u128
  125..141 is_bid_bits     u128
  141..2189   orders[128]        u128
  2189..3213  client_order_ids[128] u64
  3213..3221  referrer_rebates_accrued u64
  3221..3228 b"padding"  ACCOUNT_TAIL_PADDING
```

So `5 + 3216 + 7 = 3228`, and `owner` sits at 45 rather than the 40 you would get from
the packed struct alone — the 5-byte head padding is what shifts it.

### Four traps this handles

1. **The vault signer is not a canonical PDA.** Serum uses
   `create_program_address([market, u64_le(vault_signer_nonce)])` with the nonce *stored
   in the market*. `PublicKey.findProgramAddress` searches bumps 255→0 and returns a
   **different** key. Getting this wrong produces an opaque
   `AssertionError` from `VaultSigner::new`.
2. **`free_slot_bits` is a u128.** Reading it as u64 silently truncates to the low half
   and reports 64 free slots instead of 128, which looks like "you have resting orders".
3. **`referrerQuoteWallet` is not optional.** Omit it and `process_settle_funds` takes the
   fallback branch — `market.pc_fees_accrued += open_orders.referrer_rebates_accrued` —
   and zeroes your balance. The rebates are forfeited to market fees.
4. **Ordering is load-bearing.** `process_close_open_orders` performs *no* balance check;
   it moves the lamports and sets `account_flags = Closed`. Closing before settling
   strands the funds permanently. Hence settle-then-close in one transaction. (Closing an
   account that still holds funds fails safely with `TooManyOpenOrders`, error 42.)

### Decoding serum errors

Serum encodes assertion failures as `line + (file_id << 24)`, where file_id 1 =
`state.rs`, 2 = `matching.rs`, 3 = `critbit.rs`. So `0x1000628` means `state.rs:1576`.
Small integers are `DexErrorCode` variants instead (`42` = `TooManyOpenOrders`). Line
numbers drift between the deployed build and current HEAD, so treat them as approximate
and read the surrounding validators.

## Refuses to act when

- the market's `account_flags` has `Disabled` (bit 7) set;
- any order slot is occupied, `free_slot_bits` is not all-ones, or `is_bid_bits` is
  non-zero — cancel resting orders first;
- `free != total` for either side (part of the balance is locked in an order);
- any vault or wallet fails validation;
- the connected wallet does not own the account.

## Scope

Serum v3 only. OpenBook v2 (`opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb`) uses a
different program and different layouts, and is not covered.

## License

MIT. Use at your own risk; this software is provided without warranty. Verify the
instruction preview before signing anything.
