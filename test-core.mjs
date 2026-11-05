// Verification harness for core.js.
//
// Proves two things against live mainnet state:
//   1. core.js builds BYTE-IDENTICAL instructions to @project-serum/serum's
//      DexInstructions.settleFunds / .closeOpenOrders — same program id, same
//      data bytes, same key order, same signer/writable flags.
//   2. The resulting transaction SIMULATES SUCCESSFULLY on mainnet.
//
// The address is read from the environment, never hardcoded, so this file is
// safe to publish.
//
//   RPC_URL='https://...' TEST_ADDRESS='<wallet>' npm test

import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js';
import serumPkg from '@project-serum/serum';

// Test the source module by default; set CORE_MODULE=./vendor/app-core.js to
// verify the exact bundled artifact the browser loads.
const CORE_MODULE = process.env.CORE_MODULE || './core.js';
const {
  scanOpenOrders, buildInstructions, buildTransaction, short, SERUM: SERUM_PROGRAM,
} = await import(CORE_MODULE);
console.log(`\nmodule under test: ${CORE_MODULE}`);

const { DexInstructions } = serumPkg;

const RPC_URL = process.env.RPC_URL;
const ADDRESS = process.env.TEST_ADDRESS;
if (!RPC_URL || !ADDRESS) {
  console.error('RPC_URL and TEST_ADDRESS must both be set (see the header of this file).');
  process.exit(2);
}

let failures = 0;
const check = (label, cond, extra = '') => {
  if (cond) console.log(`  PASS  ${label}`);
  else { console.log(`  FAIL  ${label} ${extra}`); failures++; }
};

const norm = (ix) => ({
  programId: ix.programId.toBase58(),
  data: [...ix.data],
  keys: ix.keys.map((k) => [k.pubkey.toBase58(), !!k.isSigner, !!k.isWritable]),
});
const show = (n) => JSON.stringify(n);

const conn = new Connection(RPC_URL, 'confirmed');
const owner = new PublicKey(ADDRESS);

console.log(`\ntarget  ${owner.toBase58()}`);
console.log('--- scan (core.js) ---');
const list = await scanOpenOrders(conn, owner, (m) => console.log('  ' + m));
console.log(`  ${list.length} account(s) returned\n`);

const settleable = list.filter((a) => a.ok);
check('at least one account analysed successfully', settleable.length > 0);
list.filter((a) => !a.ok).forEach((a) => console.log(`  note: rejected — ${a.reason}`));

for (const a of settleable) {
  console.log(`\n=== ${a.ooKey.toBase58()} ===`);
  console.log(`    market       ${a.marketPk.toBase58()}`);
  console.log(`    vaultSigner  ${a.vaultSigner.toBase58()} (nonce ${a.nonce})`);
  console.log(`    quoteFree    ${a.quoteFree}   rebates ${a.rebates}   rent ${a.rent}`);
  console.log(`    resting      ${a.resting}/128   blocked=${a.blocked}`);

  // ---- 1. equivalence against the reference library ----
  const mine = buildInstructions(a).ixs.map(norm);
  const reference = [
    norm(DexInstructions.settleFunds({
      market: a.marketPk, openOrders: a.ooKey, owner: a.owner,
      baseVault: a.baseVault, quoteVault: a.quoteVault, vaultSigner: a.vaultSigner,
      baseWallet: a.baseWallet, quoteWallet: a.quoteWallet,
      referrerQuoteWallet: a.quoteWallet, programId: SERUM_PROGRAM,
    })),
    norm(DexInstructions.closeOpenOrders({
      market: a.marketPk, openOrders: a.ooKey, owner: a.owner,
      solWallet: a.owner, programId: SERUM_PROGRAM,
    })),
  ];

  check('settleFunds identical to @project-serum/serum',
    show(mine[0]) === show(reference[0]),
    `\n    mine: ${show(mine[0])}\n    ref : ${show(reference[0])}`);
  check('closeOpenOrders identical to @project-serum/serum',
    show(mine[1]) === show(reference[1]),
    `\n    mine: ${show(mine[1])}\n    ref : ${show(reference[1])}`);

  check('settleFunds data bytes are 00 05 00 00 00',
    show(mine[0].data) === show([0, 5, 0, 0, 0]), show(mine[0].data));
  check('closeOpenOrders data bytes are 00 0e 00 00 00',
    show(mine[1].data) === show([0, 14, 0, 0, 0]), show(mine[1].data));
  check('settleFunds carries 10 accounts (incl. referrer)', mine[0].keys.length === 10,
    `got ${mine[0].keys.length}`);
  check('referrer slot equals the quote wallet (rebates are kept, not forfeited)',
    mine[0].keys[9][0] === a.quoteWallet.toBase58());
  check('exactly one signer, and it is the owner',
    mine[0].keys.filter((k) => k[1]).length === 1 && mine[0].keys[2][1] === true
    && mine[0].keys[2][0] === a.owner.toBase58());

  // ---- 2. end-to-end simulation ----
  if (a.blocked) {
    console.log('  SKIP  simulation (account has resting orders — settling would be wrong)');
    continue;
  }
  const { blockhash } = await conn.getLatestBlockhash('confirmed');
  const tx = buildTransaction(a, owner, blockhash);
  const vtx = new VersionedTransaction(tx.compileMessage());
  const sim = await conn.simulateTransaction(vtx, { sigVerify: false, replaceRecentBlockhash: true });
  const err = sim.value.err;
  check('transaction simulates SUCCESS on mainnet', !err, err ? show(err) : '');
  console.log(`        ${sim.value.unitsConsumed} CU, blockhash ${short(blockhash)}`);
  if (err && sim.value.logs) sim.value.logs.slice(-12).forEach((l) => console.log('        | ' + l));
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
