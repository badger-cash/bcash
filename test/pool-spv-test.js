/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * An SPV pool requests only filtered blocks. A full block it did not ask
 * for gets the peer dropped. (One it asked for is filtered by the pool,
 * as Bitcoin ABC 0.33.6 nodes answer a filtered getdata with full blocks:
 * see pool-spv-fullblock-test.js.)
 */

const assert = require('bsert');
const {BufferMap} = require('buffer-map');
const Chain = require('../lib/blockchain/chain');
const Pool = require('../lib/net/pool');
const Block = require('../lib/primitives/block');
const Network = require('../lib/protocol/network');

const network = Network.get('regtest');

function fakePeer() {
  return {
    blockMap: new BufferMap(),
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

  it('drops a peer that sends a full block not asked for', async () => {
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
