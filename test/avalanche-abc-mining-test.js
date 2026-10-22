/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * Blocks bcash mines, against a Bitcoin ABC regtest node that enforces
 * the miner fund and avalanche staking rewards (-enableminerfund,
 * -avalanchestakingrewards): ABC takes one paying both, and parks one
 * that does not pay the fund or pays another staking winner. Both nodes
 * are given the winner by hand (ABC's setstakingreward), as a quorum
 * would choose it, since regtest has no stakers to poll.
 */

const assert = require('bsert');
const random = require('bcrypto/lib/random');
const secp256k1 = require('bcrypto/lib/secp256k1');
const FullNode = require('../lib/node/fullnode');
const KeyRing = require('../lib/primitives/keyring');
const MTX = require('../lib/primitives/mtx');
const Output = require('../lib/primitives/output');
const Script = require('../lib/script/script');
const ABCRegtest = require('./util/abc-regtest');

const {until} = ABCRegtest;

const available = ABCRegtest.available();
const suite = available ? describe : describe.skip;
const title = 'Mining against Bitcoin ABC regtest'
  + (available ? '' : ' (skipped: BITCOIN_ABC_BITCOIND is not set)');

// A block with its coinbase outputs replaced, mined again.
function withOutputs(block, outputs) {
  const mtx = MTX.fromTX(block.txs[0]);
  mtx.outputs = outputs.map(o => new Output(o));
  block.txs[0] = mtx.toTX();
  block.merkleRoot = block.createMerkleRoot();
  block.refresh();
  while (!block.verifyPOW()) {
    block.nonce++;
    block.refresh();
  }
  return block;
}

suite(title, function() {
  this.timeout(120000);

  const abc = available ? new ABCRegtest([
    '-enableminerfund=1',
    '-avalanchestakingrewards=1',
    // Regtest blocks come seconds apart, as ABC's own tests turn it off.
    '-enablertt=0'
  ], {p2p: true}) : null;

  const ring = KeyRing.fromPrivate(secp256k1.privateKeyGenerate());
  const address = ring.getAddress();
  let node = null;

  before(async () => {
    await abc.open();

    const {descriptor} = await abc.call('getdescriptorinfo', 'raw(51)');
    await abc.call('generatetodescriptor', 10, descriptor);

    node = new FullNode({
      network: 'regtest',
      memory: true,
      workers: false,
      listen: false,
      only: [abc.p2pHost],
      avalanche: true,
      enableMinerFund: true,
      avalancheStakingRewards: true,
      enableRtt: false
    });

    await node.open();
    await node.connect();
    node.startSync();

    const {blocks} = await abc.call('getblockchaininfo');
    await until(() => node.chain.height === blocks);
  });

  after(async () => {
    if (node) {
      await node.disconnect();
      await node.close();
    }
    await abc.close();
  });

  // The staking reward winner of the next block, on both nodes.
  async function setWinner(payout) {
    const prev = node.chain.tip;
    assert.strictEqual(await abc.call('setstakingreward', prev.rhash(),
      payout.toRaw().toString('hex')), true);
    node.pool.avalanche.setStakingRewardWinners(prev, [payout]);
  }

  // What ABC makes of a block: its tip, or a parked chain tip.
  async function submit(block) {
    const result = await abc.call('submitblock', block.toRaw().toString('hex'));
    const best = await abc.call('getbestblockhash');
    const tips = await abc.call('getchaintips');
    const tip = tips.find(t => t.hash === block.rhash());
    return {result, best, status: tip ? tip.status : null};
  }

  it('should have ABC take a block paying the fund and winner', async () => {
    const winner = Script.fromPubkeyhash(random.randomBytes(20));
    await setWinner(winner);

    const block = await node.miner.mineBlock(node.chain.tip, address);
    const [, fund, staking] = block.txs[0].outputs;
    assert(fund && staking);
    assert.bufferEqual(staking.script.toRaw(), winner.toRaw());

    const {best} = await submit(block);
    assert.strictEqual(best, block.rhash());

    // bcash takes it too.
    assert(await node.chain.add(block));
  });

  it('should have ABC park a block paying another winner', async () => {
    const winner = Script.fromPubkeyhash(random.randomBytes(20));
    await setWinner(winner);

    const good = await node.miner.mineBlock(node.chain.tip, address);
    const [miner, fund, staking] = good.txs[0].outputs;
    const block = withOutputs(good, [
      {script: miner.script, value: miner.value},
      {script: fund.script, value: fund.value},
      {script: Script.fromPubkeyhash(random.randomBytes(20)),
        value: staking.value}
    ]);

    const tip = await abc.call('getbestblockhash');
    const {best, status} = await submit(block);
    assert.strictEqual(best, tip);
    assert.strictEqual(status, 'parked');
  });

  it('should have ABC park a block not paying the fund', async () => {
    const winner = Script.fromPubkeyhash(random.randomBytes(20));
    await setWinner(winner);

    const good = await node.miner.mineBlock(node.chain.tip, address);
    const [miner, fund, staking] = good.txs[0].outputs;
    const block = withOutputs(good, [
      {script: miner.script, value: miner.value + fund.value},
      {script: staking.script, value: staking.value}
    ]);

    const tip = await abc.call('getbestblockhash');
    const {best, status} = await submit(block);
    assert.strictEqual(best, tip);
    assert.strictEqual(status, 'parked');
  });
});
