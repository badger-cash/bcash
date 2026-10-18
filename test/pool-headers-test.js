/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * During a checkpointed (headers-first) sync, Pool#resolveHeaders requests
 * the blocks between two checkpoints, and runs again for every block that
 * arrives. If each run asks for another 27000 blocks, a gap longer than
 * MAX_BLOCK_REQUEST puts the loader over the in-flight limit after the
 * first block and getBlock() drops it, so the sync advances one block per
 * loader. Observed on eCash testnet between checkpoints 1188697 and
 * 1303885 (115188 blocks apart).
 */

const assert = require('bsert');
const {randomBytes} = require('crypto');
const Chain = require('../lib/blockchain/chain');
const BlockStore = require('../lib/blockstore/level');
const Pool = require('../lib/net/pool');
const Network = require('../lib/protocol/network');
const common = require('../lib/net/common');

const network = Network.get('regtest');

function fakePeer() {
  return {
    destroyed: false,
    handshake: true,
    blockMap: new Map(),
    requested: 0,
    hostname: () => '127.0.0.1:18444',
    getBlock(items) {
      this.requested += items.length;
    },
    destroy() {
      this.destroyed = true;
    }
  };
}

describe('Pool headers-first', function() {
  this.timeout(60000);

  // Longer than the in-flight limit, like the testnet checkpoint gap.
  const GAP = common.MAX_BLOCK_REQUEST + 10000;
  let blocks, chain, pool;

  before(async () => {
    blocks = new BlockStore({network, memory: true});
    chain = new Chain({network, memory: true, blocks});
    await blocks.open();
    await chain.open();
    pool = new Pool({network, chain, memory: true, listen: false});
    pool.opened = true;

    for (let height = 1; height <= GAP; height++) {
      pool.headerChain.push({hash: randomBytes(32), height, prev: null, next: null});
    }
    pool.headerNext = pool.headerChain.head;
  });

  after(async () => {
    pool.opened = false;
    await chain.close();
    await blocks.close();
  });

  it('requests a long checkpoint gap without dropping the loader', () => {
    const peer = fakePeer();
    let peak = 0;

    pool.resolveHeaders(peer);

    // Deliver blocks one at a time, as handleBlock() does.
    while (peer.blockMap.size > 0) {
      assert(!peer.destroyed, `loader dropped after ${peer.requested} requests`);
      peak = Math.max(peak, peer.blockMap.size);

      const [hash] = peer.blockMap.keys();
      peer.blockMap.delete(hash);
      pool.blockMap.delete(hash);
      pool.resolveHeaders(peer);
    }

    assert(!peer.destroyed);
    assert(peak < common.MAX_BLOCK_REQUEST);
    assert.strictEqual(peer.requested, GAP);
    assert.strictEqual(pool.headerNext, null);
  });
});
