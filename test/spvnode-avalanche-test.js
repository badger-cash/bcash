/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * An SPV node with avalanche: it polls its own transactions for finality,
 * and learns staking reward winners, as a full node does, by default.
 */

const assert = require('bsert');
const SPVNode = require('../lib/node/spvnode');
const MTX = require('../lib/primitives/mtx');
const Outpoint = require('../lib/primitives/outpoint');
const KeyRing = require('../lib/primitives/keyring');

function createNode(options) {
  return new SPVNode({
    network: 'regtest',
    memory: true,
    workers: false,
    listen: false,
    ...options
  });
}

function makeTX() {
  const ring = KeyRing.generate();
  const mtx = new MTX();
  mtx.addOutpoint(new Outpoint(Buffer.alloc(32, 1), 0));
  mtx.addOutput(ring.getAddress(), 10000);
  return mtx.toTX();
}

describe('SPV node avalanche', function() {
  it('should poll its own transactions by default', async () => {
    const node = createNode({avalanche: true});
    const avalanche = node.pool.avalanche;
    assert(avalanche);
    assert.strictEqual(avalanche.preConsensus, true);

    // Broadcast without a network: watched all the same.
    node.pool.broadcast = async () => {};

    const tx = makeTX();
    await node.broadcast(tx);
    assert(avalanche.watchedTxs.has(tx.txid()));
  });

  it('should not poll with pre-consensus off', async () => {
    const node = createNode({
      avalanche: true,
      avalanchePreconsensus: false
    });
    const avalanche = node.pool.avalanche;
    assert.strictEqual(avalanche.preConsensus, false);

    node.pool.broadcast = async () => {};

    const tx = makeTX();
    await node.broadcast(tx);
    assert(!avalanche.watchedTxs.has(tx.txid()));
  });

  it('should learn staking reward winners where the network pays them',
    () => {
      // Off by default on regtest, as on Bitcoin ABC; asked for, on.
      const off = createNode({avalanche: true});
      assert.strictEqual(off.pool.avalanche.stakingRewardsEnabled, false);

      const on = createNode({
        avalanche: true,
        avalancheStakingRewards: true
      });
      assert.strictEqual(on.pool.avalanche.stakingRewardsEnabled, true);

      const main = createNode({network: 'main', avalanche: true});
      assert.strictEqual(main.pool.avalanche.stakingRewardsEnabled, true);
    });

  it('should have no avalanche without the option', () => {
    const node = createNode({});
    assert.strictEqual(node.pool.avalanche, null);
  });
});
