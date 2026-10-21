/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * Avalanche finalization in the chain, following Bitcoin ABC's
 * AvalancheFinalizeBlock and its parking of chains that fork before the
 * finalized tip. Unlike Bitcoin ABC, bcash keeps the finalized tip across
 * restarts.
 */

const assert = require('bsert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Chain = require('../lib/blockchain/chain');
const BlockStore = require('../lib/blockstore/level');
const Miner = require('../lib/mining/miner');
const Network = require('../lib/protocol/network');

const network = Network.get('regtest');

async function createChain(prefix) {
  const memory = !prefix;
  const blocks = new BlockStore({network, memory,
    location: prefix && path.join(prefix, 'blocks')});
  const chain = new Chain({network, memory, prefix, blocks});
  await blocks.open();
  await chain.open();
  const miner = new Miner({chain, version: 4});
  return {chain, blocks, miner};
}

async function close({chain, blocks}) {
  await chain.close();
  await blocks.close();
}

// Mine on a block, the tip by default.
async function mine({chain, miner}, prev) {
  const job = await miner.cpu.createJob(prev);
  const block = await job.mineAsync();
  const entry = await chain.add(block);
  return entry || await chain.getEntry(block.hash());
}

async function mineMany(node, count, prev) {
  let entry = prev || node.chain.tip;
  const entries = [];
  for (let i = 0; i < count; i++) {
    entry = await mine(node, entry);
    entries.push(entry);
  }
  return entries;
}

describe('Chain finalization', function() {
  this.timeout(30000);

  let node;

  beforeEach(async () => {
    node = await createChain();
  });

  afterEach(async () => {
    await close(node);
  });

  it('should finalize nothing without avalanche', async () => {
    const [entry] = await mineMany(node, 1);
    assert.strictEqual(node.chain.getFinalizedTip(), null);
    assert.strictEqual(node.chain.isFinalized(entry), false);
    assert.strictEqual(node.chain.isFinalized(entry.hash), false);
  });

  it('should finalize a block and those below it', async () => {
    const {chain} = node;
    const entries = await mineMany(node, 5);

    const events = [];
    chain.on('finalized', entry => events.push(entry.height));

    assert.strictEqual(await chain.finalize(entries[2]), true);
    assert.strictEqual(chain.getFinalizedTip(), entries[2]);
    assert.deepStrictEqual(events, [3]);

    for (const entry of entries.slice(0, 3)) {
      assert.strictEqual(chain.isFinalized(entry), true);
      assert.strictEqual(chain.isFinalized(entry.hash), true);
    }

    for (const entry of entries.slice(3)) {
      assert.strictEqual(chain.isFinalized(entry), false);
      assert.strictEqual(chain.isFinalized(entry.hash), false);
    }

    // Below the finalized tip: already final, nothing new.
    assert.strictEqual(await chain.finalize(entries[1]), true);
    assert.strictEqual(chain.getFinalizedTip(), entries[2]);
    assert.deepStrictEqual(events, [3]);

    // Higher: moves up.
    assert.strictEqual(await chain.finalize(entries[4]), true);
    assert.deepStrictEqual(events, [3, 5]);
    assert.strictEqual(chain.isFinalized(entries[3]), true);
  });

  it('should not finalize a block off the main chain', async () => {
    const {chain} = node;
    const [base] = await mineMany(node, 1);
    const [main] = await mineMany(node, 2, base);
    const [side] = await mineMany(node, 1, base);

    assert.strictEqual(await chain.isMainChain(main), true);
    assert.strictEqual(await chain.isMainChain(side), false);

    assert.strictEqual(await chain.finalize(side), false);
    assert.strictEqual(chain.getFinalizedTip(), null);
    assert.strictEqual(chain.isFinalized(side), false);
  });

  it('should not reorganize below the finalized tip', async () => {
    const {chain} = node;
    const [base] = await mineMany(node, 1);
    const main = await mineMany(node, 2, base);

    await chain.finalize(main[0]);

    // A longer fork from below the finalized tip is parked.
    const fork = await mineMany(node, 4, base);

    assert.bufferEqual(chain.tip.hash, main[1].hash);
    assert(fork[3].chainwork.gt(main[1].chainwork));
    assert.strictEqual(await chain.isMainChain(fork[3]), false);
    assert.strictEqual(chain.isFinalized(main[0]), true);
  });

  it('should still reorganize above the finalized tip', async () => {
    const {chain} = node;
    const [base] = await mineMany(node, 1);
    const main = await mineMany(node, 2, base);

    await chain.finalize(base);

    const disconnected = [];
    chain.on('disconnect', entry => disconnected.push(entry.height));

    const fork = await mineMany(node, 3, base);

    assert.bufferEqual(chain.tip.hash, fork[2].hash);
    assert.deepStrictEqual(disconnected.sort(), [main[0].height,
      main[1].height].sort());
    assert.strictEqual(chain.isFinalized(base), true);
  });

  it('should move the finalized tip down on a reset', async () => {
    const {chain} = node;
    const entries = await mineMany(node, 4);

    await chain.finalize(entries[3]);
    await chain.reset(entries[1].height);

    assert.strictEqual(chain.getFinalizedTip().height, entries[1].height);
    assert.strictEqual(chain.isFinalized(entries[1]), true);
  });
});

describe('Chain finalization across restarts', function() {
  this.timeout(30000);

  let prefix;

  beforeEach(() => {
    prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'bcash-final-'));
  });

  afterEach(() => {
    fs.rmSync(prefix, {recursive: true, force: true});
  });

  it('should keep the finalized tip', async () => {
    let node = await createChain(prefix);
    const entries = await mineMany(node, 3);
    await node.chain.finalize(entries[1]);
    await close(node);

    node = await createChain(prefix);
    const tip = node.chain.getFinalizedTip();
    assert(tip);
    assert.bufferEqual(tip.hash, entries[1].hash);
    assert.strictEqual(node.chain.isFinalized(entries[0].hash), true);
    assert.strictEqual(node.chain.isFinalized(entries[2].hash), false);
    await close(node);
  });
});
