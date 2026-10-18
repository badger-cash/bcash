/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * Blocks below the last checkpoint skip script checks and go through
 * Chain#updateInputs. With canonical transaction ordering (Magnetic
 * Anomaly) a tx can spend an output of a tx that sorts after it in the
 * same block; that path must accept it exactly as Chain#verifyInputs does.
 * Found on eCash testnet: block 1267997 (the first Magnetic Anomaly block)
 * has three such spends and stopped a checkpointed sync at 1267996.
 */

const assert = require('bsert');
const Chain = require('../lib/blockchain/chain');
const BlockStore = require('../lib/blockstore/level');
const WorkerPool = require('../lib/workers/workerpool');
const Miner = require('../lib/mining/miner');
const KeyRing = require('../lib/primitives/keyring');
const MTX = require('../lib/primitives/mtx');
const Coin = require('../lib/primitives/coin');
const CoinView = require('../lib/coins/coinview');
const Network = require('../lib/protocol/network');

const network = Network.get('regtest');

const workers = new WorkerPool({enabled: false});

function createChain(checkpoints) {
  const blocks = new BlockStore({memory: true, network});
  const chain = new Chain({
    memory: true, blocks, network, workers, checkpoints
  });
  return {blocks, chain};
}

describe('Chain historical CTOR', function() {
  this.timeout(60000);

  const key = KeyRing.generate();
  const historical = createChain(true);
  const verified = createChain(false);
  const miner = new Miner({chain: historical.chain, workers});
  const mined = [];
  let lastCheckpoint;
  let parent, child;

  async function mine(build) {
    const job = await miner.cpu.createJob(null, key.getAddress());
    if (build)
      build(job);
    const block = await job.mineAsync();
    assert(await historical.chain.add(block));
    mined.push(block);
    return block;
  }

  before(async () => {
    // Treat everything we mine as below the last checkpoint.
    lastCheckpoint = network.lastCheckpoint;
    network.lastCheckpoint = 1000;

    for (const {blocks, chain} of [historical, verified]) {
      await blocks.open();
      await chain.open();
    }
    miner.addresses.push(key.getAddress());
  });

  after(async () => {
    network.lastCheckpoint = lastCheckpoint;
    for (const {blocks, chain} of [historical, verified]) {
      await chain.close();
      await blocks.close();
    }
  });

  it('runs with Magnetic Anomaly active, below the last checkpoint', () => {
    assert.strictEqual(network.block.magneticAnomalyHeight, 0);
    assert(historical.chain.isHistorical(historical.chain.tip));
    assert(!verified.chain.isHistorical(verified.chain.tip));
  });

  it('accepts a block whose child tx sorts before its parent', async () => {
    const funding = await mine();
    for (let i = 0; i < 100; i++)
      await mine();

    const cb = funding.txs[0];
    const coin = Coin.fromTX(cb, 0, 1);

    // Vary the parent's output until its child sorts first by txid.
    for (let fee = 1000; ; fee += 1) {
      const p = new MTX();
      p.addCoin(coin);
      p.addOutput(key.getAddress(), coin.value - fee);
      p.sign(key);
      parent = p.toTX();

      const c = new MTX();
      c.addCoin(Coin.fromTX(parent, 0, -1));
      c.addOutput(key.getAddress(), coin.value - fee - 1000);
      c.sign(key);
      child = c.toTX();

      if (child.txid() < parent.txid())
        break;
    }

    const block = await mine((job) => {
      const view = new CoinView();
      view.addCoin(coin);
      job.addTX(parent, view);
      const childView = new CoinView();
      childView.addTX(parent, -1);
      job.addTX(child, childView);
      job.attempt.sort();
      job.refresh();
    });

    const ids = block.txs.map(tx => tx.txid());
    assert(ids.indexOf(child.txid()) < ids.indexOf(parent.txid()),
      'child must precede its parent in the block');
  });

  it('leaves the same coins as full verification', async () => {
    for (const block of mined)
      assert(await verified.chain.add(block));

    assert.strictEqual(
      verified.chain.tip.rhash(), historical.chain.tip.rhash());

    for (const {chain} of [historical, verified]) {
      assert(!await chain.db.getCoin(parent.hash(), 0), 'parent output spent');
      assert(await chain.db.getCoin(child.hash(), 0), 'child output unspent');
    }
  });
});
