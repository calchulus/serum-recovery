// Serum v3 open-orders recovery — core logic.
//
// No DOM, no globals: importable from both the browser page and the Node test
// harness so the exact code that builds signed transactions can be verified
// headlessly against live mainnet state.
//
// All byte offsets below were verified against serum-dex/dex/src/state.rs and
// the @project-serum/serum MARKET_STATE_LAYOUT_V3 definition.

import { Buffer } from 'buffer';
import { PublicKey, Transaction } from '@solana/web3.js';

// Re-exported so the page can import everything from the single vendored
// bundle — no CDN, no second module graph.
export { Connection, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';

export const SERUM     = new PublicKey('9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin');
export const SPL_TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const ATA_PROG  = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

// serum-dex AccountFlag bits (state.rs)
export const F_INIT = 1n, F_MARKET = 2n, F_OPEN_ORDERS = 4n,
             F_DISABLED = 128n, F_CLOSED = 256n;

// OpenOrders layout: head padding b"serum"(5) + flags(8) + market(32) + owner(32)
//   + base free/total(16) + quote free/total(16) + free_slot_bits u128(16)
//   + is_bid_bits u128(16) + orders(2048) + client_order_ids(1024)
//   + referrer_rebates_accrued(8) + tail padding b"padding"(7) = 3228
export const OO = {
  size: 3228, flags: 5, market: 13, owner: 45,
  baseFree: 77, baseTotal: 85, quoteFree: 93, quoteTotal: 101,
  freeSlotBits: 109, isBidBits: 125, rebates: 3213,
};

// MarketState V3 layout
export const MK = {
  flags: 5, ownAddress: 13, vaultSignerNonce: 45, baseMint: 53, quoteMint: 85,
  baseVault: 117, quoteVault: 165, baseLotSize: 349, quoteLotSize: 357,
};

// SPL Token account: mint 0..32, owner 32..64, amount 64..72,
//   delegateOption 72..76, state byte at 108. Account::LEN = 165.
export const TA_LEN = 165;

// Instruction data is 5 bytes: u8 version (0) + u32 LE variant index.
// Confirmed against DexInstructions.settleFunds / .closeOpenOrders output.
export const IX_SETTLE_FUNDS   = new Uint8Array([0, 5, 0, 0, 0]);
export const IX_CLOSE_OPEN_ORD = new Uint8Array([0, 14, 0, 0, 0]);

export const u64 = (b, o) => b.readBigUInt64LE(o);
export function u128(b, o) {
  let v = 0n;
  for (let i = 15; i >= 0; i--) v = (v << 8n) | BigInt(b[o + i]);
  return v;
}
export const short = (s) => s.slice(0, 4) + '…' + s.slice(-4);

// Serum derives the vault signer with create_program_address() using the nonce
// STORED IN THE MARKET. findProgramAddressSync searches bumps 255..0 and returns
// the canonical PDA, which is a DIFFERENT key. Do not substitute it here.
export function vaultSignerOf(marketPk, nonce) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(nonce));
  return PublicKey.createProgramAddressSync([marketPk.toBuffer(), b], SERUM);
}

// Associated token accounts DO use the canonical bump, so findProgramAddress
// is correct here (unlike the vault signer above).
export function ataOf(owner, mint) {
  const [a] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), SPL_TOKEN.toBuffer(), mint.toBuffer()], ATA_PROG);
  return a;
}

const fail = (reason) => ({ ok: false, reason });

// Analyse one open-orders account. Returns {ok:true, ...detail} or {ok:false, reason}.
export async function analyse(conn, ooKey, ooAcct, ownerPk) {
  if (!ooAcct) return fail('open-orders account does not exist');
  const d = Buffer.from(ooAcct.data);

  if (d.length !== OO.size) return fail(`size ${d.length} != 3228`);
  if (d.subarray(0, 5).toString('latin1') !== 'serum') return fail('bad head padding (not a serum account)');
  if (d.subarray(-7).toString('latin1') !== 'padding') return fail('bad tail padding');

  const flags = u64(d, OO.flags);
  if (flags & F_CLOSED) return fail('account already closed');
  if (!(flags & F_INIT) || !(flags & F_OPEN_ORDERS)) return fail(`unexpected flags 0x${flags.toString(16)}`);

  const marketPk = new PublicKey(d.subarray(OO.market, OO.market + 32));
  const owner    = new PublicKey(d.subarray(OO.owner, OO.owner + 32));
  if (!owner.equals(ownerPk)) return fail(`owner mismatch: ${owner.toBase58()}`);

  const baseFree = u64(d, OO.baseFree),  baseTotal = u64(d, OO.baseTotal);
  const quoteFree = u64(d, OO.quoteFree), quoteTotal = u64(d, OO.quoteTotal);
  const rebates = u64(d, OO.rebates);
  // u128 — reading this as u64 truncates and reports 64 free slots instead of 128
  const freeBits = u128(d, OO.freeSlotBits), bidBits = u128(d, OO.isBidBits);
  const rent = BigInt(ooAcct.lamports);
  const resting = 128 - [...freeBits.toString(2)].filter((x) => x === '1').length;

  const mkAcct = await conn.getAccountInfo(marketPk);
  if (!mkAcct) return fail(`market ${marketPk.toBase58()} does not exist`);
  const mk = Buffer.from(mkAcct.data);
  const mkFlags = u64(mk, MK.flags);
  if (!(mkFlags & F_INIT) || !(mkFlags & F_MARKET)) return fail('market flags invalid');
  if (mkFlags & F_DISABLED) return fail('market is DISABLED — settleFunds may be blocked');
  if (!new PublicKey(mk.subarray(MK.ownAddress, MK.ownAddress + 32)).equals(marketPk)) {
    return fail('market ownAddress does not match its pubkey');
  }

  const baseMint   = new PublicKey(mk.subarray(MK.baseMint, MK.baseMint + 32));
  const quoteMint  = new PublicKey(mk.subarray(MK.quoteMint, MK.quoteMint + 32));
  const baseVault  = new PublicKey(mk.subarray(MK.baseVault, MK.baseVault + 32));
  const quoteVault = new PublicKey(mk.subarray(MK.quoteVault, MK.quoteVault + 32));
  const nonce = u64(mk, MK.vaultSignerNonce);

  let vaultSigner;
  try { vaultSigner = vaultSignerOf(marketPk, nonce); }
  catch (e) { return fail(`vault signer derivation failed: ${e.message}`); }

  const baseWallet  = ataOf(ownerPk, baseMint);
  const quoteWallet = ataOf(ownerPk, quoteMint);

  // Validate every token account against live chain state. A wrong address
  // arrives as a system-owned 0-byte AccountInfo and fails deep inside the
  // program with an opaque line-encoded AssertionError, so catch it here.
  const tkeys = [baseVault, quoteVault, baseWallet, quoteWallet];
  const tinfo = await conn.getMultipleAccountsInfo(tkeys);
  const names = ['baseVault', 'quoteVault', 'baseWallet', 'quoteWallet'];
  const wantMint = [baseMint, quoteMint, baseMint, quoteMint];
  for (let k = 0; k < 4; k++) {
    const a = tinfo[k];
    if (!a) return fail(`${names[k]} ${tkeys[k].toBase58()} does not exist on-chain`);
    if (!a.owner.equals(SPL_TOKEN)) return fail(`${names[k]} is not an SPL Token account`);
    if (a.data.length !== TA_LEN) return fail(`${names[k]} is ${a.data.length} bytes, serum requires 165`);
    if (a.data[108] !== 1) return fail(`${names[k]} state=${a.data[108]}, expected 1 (initialized)`);
    if (!new PublicKey(a.data.subarray(0, 32)).equals(wantMint[k])) return fail(`${names[k]} has the wrong mint`);
    const ownField = new PublicKey(a.data.subarray(32, 64));
    const want = k < 2 ? vaultSigner : ownerPk; // vaults -> vaultSigner, wallets -> you
    if (!ownField.equals(want)) return fail(`${names[k]} owner field ${ownField.toBase58()} != ${want.toBase58()}`);
    if (a.data.readUInt32LE(72) !== 0) return fail(`${names[k]} has a delegate set — serum rejects it`);
  }

  return {
    ok: true, ooKey, marketPk, owner, baseMint, quoteMint, baseVault, quoteVault,
    vaultSigner, nonce, baseWallet, quoteWallet,
    baseMintB58: baseMint.toBase58(), quoteMintB58: quoteMint.toBase58(),
    baseFree, baseTotal, quoteFree, quoteTotal, rebates, rent, resting, freeBits, bidBits,
    nothing: quoteFree === 0n && baseFree === 0n && rebates === 0n && rent === 0n,
    blocked: resting > 0 || freeBits !== (2n ** 128n) - 1n || bidBits !== 0n
             || baseFree !== baseTotal || quoteFree !== quoteTotal,
  };
}

// Find and analyse every open-orders account owned by `ownerPk`.
export async function scanOpenOrders(conn, ownerPk, log = () => {}) {
  log(`scanning open-orders owned by ${ownerPk.toBase58()}`);
  // Stage 1: gpa filtered by size + owner, slicing only the market key so the
  // response stays small. Full data comes in stage 2.
  const hits = await conn.getProgramAccounts(SERUM, {
    encoding: 'base64',
    dataSlice: { offset: OO.market, length: 32 },
    filters: [
      { dataSize: OO.size },
      { memcmp: { offset: OO.owner, bytes: ownerPk.toBase58() } },
    ],
  });
  log(`found ${hits.length} open-orders account(s)`);
  if (!hits.length) return [];

  const ooKeys = hits.map((h) => h.pubkey);
  const ooFull = await conn.getMultipleAccountsInfo(ooKeys);
  const list = [];
  for (let i = 0; i < ooKeys.length; i++) list.push(await analyse(conn, ooKeys[i], ooFull[i], ownerPk));

  // decimals + best-effort symbols for display
  const mints = [...new Set(list.flatMap((a) => (a.ok ? [a.baseMintB58, a.quoteMintB58] : [])))];
  const mintInfo = await conn.getMultipleAccountsInfo(mints.map((m) => new PublicKey(m)));
  const decMap = {};
  mints.forEach((m, i) => { decMap[m] = mintInfo[i] ? mintInfo[i].data[44] : 6; });
  list.forEach((a) => {
    if (!a.ok) return;
    a.baseDec = decMap[a.baseMintB58];
    a.quoteDec = decMap[a.quoteMintB58];
  });
  return list;
}

// Fetch token symbols via DAS getAsset. Helius/Triton support it; other RPCs
// return nothing and we fall back to a truncated mint address.
export async function fetchSymbols(rpcUrl, mints) {
  const out = {};
  await Promise.all(mints.map(async (m) => {
    try {
      const r = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAsset', params: { id: m } }),
      }).then((x) => x.json());
      out[m] = r?.result?.content?.metadata?.symbol || '';
    } catch { out[m] = ''; }
  }));
  return out;
}

// Build the two instructions. Account order and signer/writable flags were
// dumped from DexInstructions.settleFunds / .closeOpenOrders and match exactly.
export function buildInstructions(a) {
  const settle = {
    name: 'settleFunds (variant 5)',
    programId: SERUM,
    data: IX_SETTLE_FUNDS,
    keys: [
      { pubkey: a.marketPk,    isSigner: false, isWritable: true  },
      { pubkey: a.ooKey,       isSigner: false, isWritable: true  },
      { pubkey: a.owner,       isSigner: true,  isWritable: false },
      { pubkey: a.baseVault,   isSigner: false, isWritable: true  },
      { pubkey: a.quoteVault,  isSigner: false, isWritable: true  },
      { pubkey: a.baseWallet,  isSigner: false, isWritable: true  },
      { pubkey: a.quoteWallet, isSigner: false, isWritable: true  },
      { pubkey: a.vaultSigner, isSigner: false, isWritable: false },
      { pubkey: SPL_TOKEN,     isSigner: false, isWritable: false },
      // REQUIRED: omit it and the fallback branch runs
      // market.pc_fees_accrued += open_orders.referrer_rebates_accrued,
      // forfeiting the rebates to market fees.
      { pubkey: a.quoteWallet, isSigner: false, isWritable: true  },
    ],
  };
  const close = {
    name: 'closeOpenOrders (variant 14)',
    programId: SERUM,
    data: IX_CLOSE_OPEN_ORD,
    keys: [
      { pubkey: a.ooKey,    isSigner: false, isWritable: true  },
      { pubkey: a.owner,    isSigner: true,  isWritable: false },
      { pubkey: a.owner,    isSigner: false, isWritable: true  }, // rent returns to you
      { pubkey: a.marketPk, isSigner: false, isWritable: false },
    ],
  };
  return { ixs: [settle, close] };
}

// Assemble one legacy transaction: settle first, then close. Ordering is
// load-bearing — close_open_orders does no balance check, it just zeroes the
// lamports and sets account_flags = Closed, which would strand the funds.
export function buildTransaction(a, ownerPk, blockhash) {
  const { ixs } = buildInstructions(a);
  const tx = new Transaction({ feePayer: ownerPk, recentBlockhash: blockhash });
  ixs.forEach((ix) => tx.add(ix));
  return tx;
}
