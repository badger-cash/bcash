/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * An SPV pool requests only filtered blocks. A peer that answers with full
 * blocks must be dropped rather than kept as the sync loader, where it would
 * stall the sync (observed from a Bitcoin ABC 0.33.6 node answering a
 * 500-block filtered getdata with 500 full blocks).
 */

const assert = require('bsert');
const Chain = require('../lib/blockchain/chain');
const Pool = require('../lib/net/pool');
const Block = require('../lib/primitives/block');
const Network = require('../lib/protocol/network');

const network = Network.get('regtest');

function fakePeer() {
  return {
    destroyed: false,
    hostname: () => '127.0.0.1:18444',
    destroy() {
      this.destroyed = true;
    }
  };
}

describe('Pool (SPV)', function() {
  let chain, pool;

  before(async () => {
    chain = new Chain({network, memory: true, spv: true});
    await chain.open();
    pool = new Pool({network, chain, spv: true, memory: true, listen: false});
  });

  after(async () => {
    await chain.close();
  });

  it('drops a peer that sends a full block', async () => {
    const peer = fakePeer();
    const block = Block.fromRaw(network.genesisBlock, 'hex');

    await pool.handleBlock(peer, {block});

    assert.strictEqual(peer.destroyed, true);
  });

  it('does not add the full block to the chain', async () => {
    const height = chain.height;
    const block = new Block({
      version: 1,
      prevBlock: chain.tip.hash,
      merkleRoot: Buffer.alloc(32),
      time: chain.tip.time + 600,
      bits: chain.tip.bits,
      nonce: 0
    });

    await pool.handleBlock(fakePeer(), {block});

    assert.strictEqual(chain.height, height);
  });
});
