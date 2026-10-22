/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * A bcash SPV node with avalanche on, connected to a Bitcoin ABC regtest
 * node that stakes a proof. With no coins of its own, it finds the stakes'
 * transactions by merkleblock and registers the proof. Runs only when
 * BITCOIN_ABC_BITCOIND is set.
 */

const assert = require('bsert');
const SPVNode = require('../lib/node/spvnode');
const Coin = require('../lib/primitives/coin');
const KeyRing = require('../lib/primitives/keyring');
const MTX = require('../lib/primitives/mtx');
const Script = require('../lib/script/script');
const Processor = require('../lib/avalanche/processor');
const ABCRegtest = require('./util/abc-regtest');

const {until} = ABCRegtest;

// Satoshis; regtest coinbases are below the mainnet threshold.
const DUST_THRESHOLD = 1000000;

const available = ABCRegtest.available();
const suite = available ? describe : describe.skip;
const title = 'Avalanche SPV against Bitcoin ABC regtest'
  + (available ? '' : ' (skipped: BITCOIN_ABC_BITCOIND is not set)');

suite(title, function() {
  this.timeout(120000);

  const abc = available ? new ABCRegtest([
    `-avaproofstakeutxodustthreshold=${DUST_THRESHOLD}`,
    '-avaproofstakeutxoconfirmations=1'
  ], {p2p: true}) : null;

  let node = null;
  let proof = null;
  let descriptor = null;
  let stakeKey = null;

  before(async () => {
    await abc.open();
    ({proof, descriptor, stakeKey} = await abc.stake());
    await abc.call('generatetodescriptor', 1, descriptor);

    node = new SPVNode({
      network: 'regtest',
      memory: true,
      only: [abc.p2pHost],
      avalanche: true,
      avaproofStakeUtxoDustThreshold: DUST_THRESHOLD,
      avaproofStakeUtxoConfirmations: 1
    });

    await node.open();
    await node.connect();
    node.startSync();
  });

  after(async () => {
    if (node) {
      await node.disconnect();
      await node.close();
    }
    await abc.close();
  });

  it('should sync headers from it', async () => {
    const {blocks} = await abc.call('getblockchaininfo');
    await until(() => node.chain.height === blocks);
  });

  it('should register its proof from merkleblocks', async () => {
    const processor = node.pool.avalanche;
    const pm = processor.peerManager;

    await abc.shareProof(descriptor);

    // ABC answers getavaproofs once a minute.
    const time = Math.floor(Date.now() / 1000);
    await abc.call('setmocktime', time + Processor.GETAVAPROOFS_INTERVAL + 1);
    processor.periodicNetworking();

    await until(() => pm.isBoundToPeer(proof.id()) && pm.getNodeCount() === 1);

    // Found by merkleblock, and watched for spends.
    const verifier = pm.verifier;
    assert.strictEqual(verifier.coins.size, proof.stakes.length);
    for (const {stake} of proof.stakes)
      assert(node.pool.spvFilter.test(stake.outpoint.toRaw()));
  });

  it('should drop its proof when a stake is spent', async () => {
    const pm = node.pool.avalanche.peerManager;
    const [{stake}] = proof.stakes;

    // Coinbases mature after 100 blocks.
    await abc.call('generatetodescriptor', 100, descriptor);

    // Spend the staked coin with the stake key.
    const ring = KeyRing.fromPrivate(stakeKey);
    const coin = Coin.fromOptions({
      hash: stake.outpoint.hash,
      index: stake.outpoint.index,
      value: stake.amount,
      script: Script.fromPubkeyhash(ring.getKeyHash()),
      height: stake.height,
      coinbase: true
    });

    const mtx = new MTX();
    mtx.addCoin(coin);
    mtx.addOutput(Script.fromPubkeyhash(ring.getKeyHash()),
      stake.amount - 10000);
    mtx.sign(ring);

    await abc.call('sendrawtransaction', mtx.toRaw().toString('hex'));
    await abc.call('generatetodescriptor', 1, descriptor);

    // The live filter matches the spend; the next tip drops the proof.
    await until(() => !pm.isBoundToPeer(proof.id()));
  });
});
