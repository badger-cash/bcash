/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * During a checkpointed (headers-first) sync the pool knows every header up
 * to the next checkpoint before it asks for blocks. It now asks every peer
 * that can serve them, not only the loader, and connects what arrives in
 * header order. Downloading from one peer was the bottleneck on eCash
 * testnet's 32 MB stress-test blocks (about 1.2 MB/s per peer at 250 ms).
 */

const assert = require('bsert');
const {randomBytes} = require('crypto');
const {BufferMap} = require('buffer-map');
const Chain = require('../lib/blockchain/chain');
const BlockStore = require('../lib/blockstore/level');
const Pool = require('../lib/net/pool');
const Network = require('../lib/protocol/network');
const common = require('../lib/net/common');

const network = Network.get('regtest');

// How many blocks of `size` a peer and the whole download may hold.
const perPeer = size => Math.floor(Pool.PEER_BLOCK_BYTES / size);
const window = size => Math.floor(Pool.BLOCK_BUFFER_BYTES / size);

let ids = 0;

function fakePeer(height = 1e6) {
  const id = ids++;
  return {
    id,
    prev: null,
    next: null,
    outbound: true,
    handshake: true,
    destroyed: false,
    loader: false,
    services: common.services.NETWORK,
    height,
    bestHeight: -1,
    blockMap: new BufferMap(),
    txMap: new BufferMap(),
    compactBlocks: new BufferMap(),
    requested: [],
    hostname: () => `10.0.0.${id}:18444`,
    getBlock(items) {
      this.requested.push(...items);
    },
    sendGetHeaders() {},
    reject() {},
    destroy() {
      this.destroyed = true;
    }
  };
}

function requestedBy(peers) {
  return new Set(peers.flatMap(p => p.requested.map(h => h.toString('hex'))));
}

function fakeBlock(node, size = 300) {
  return {hash: () => node.hash, getSize: () => size, time: 0, bits: 0};
}

describe('Pool headers-first', function() {
  this.timeout(60000);

  let blocks, chain, pool, connected, nodes;

  // A header chain of `length` blocks, as _handleHeaders leaves it once
  // the checkpoint header has arrived. The last entry is the checkpoint.
  function setHeaders(length) {
    pool.clearHeaderChain();
    pool.checkpoints = true;
    nodes = [];
    for (let height = 1; height <= length; height++) {
      const node = {hash: randomBytes(32), height, prev: null, next: null};
      pool.headerChain.push(node);
      pool.headerIndex.set(node.hash, node);
      nodes.push(node);
    }
    pool.headerNext = pool.headerChain.head;
    pool.headerTip = nodes[nodes.length - 1];
    pool.blockSizes = [];
    connected = [];
  }

  function addPeers(n, height) {
    const peers = [];
    for (let i = 0; i < n; i++) {
      const peer = fakePeer(height);
      pool.peers.add(peer);
      peers.push(peer);
    }
    return peers;
  }

  // Deliver one block the way handleBlock() does.
  async function deliver(peer, node, size) {
    await pool._addBlock(peer, fakeBlock(node, size), 0);
  }

  before(async () => {
    blocks = new BlockStore({network, memory: true});
    chain = new Chain({network, memory: true, blocks});
    await blocks.open();
    await chain.open();

    // Record the connect order instead of validating fake blocks.
    chain.add = async (block) => {
      connected.push(block.hash());
      return {hash: block.hash()};
    };
  });

  beforeEach(() => {
    pool = new Pool({network, chain, memory: true, listen: false});
    pool.opened = true;
    pool.syncing = true;
  });

  after(async () => {
    await chain.close();
    await blocks.close();
  });

  it('spreads the requests over every peer that can serve them', () => {
    setHeaders(5000);
    const peers = addPeers(4);
    const short = addPeers(1, 10);

    pool.requestHeaderBlocks();

    for (const peer of peers)
      assert(peer.requested.length > 0);

    assert.strictEqual(short[0].requested.length, 0, 'peer without the blocks');

    const total = peers.reduce((n, p) => n + p.requested.length, 0);
    assert(total <= Pool.MAX_HEADER_WINDOW);

    assert.strictEqual(requestedBy(peers).size, total, 'no duplicates');
  });

  it('leaves room for peers that connect after the first request', () => {
    setHeaders(5000);
    const [first] = addPeers(1);

    pool.requestHeaderBlocks();

    const late = addPeers(3);
    pool.requestHeaderBlocks();

    for (const peer of late)
      assert(peer.requested.length > 0, 'late peer got nothing');

    assert(first.requested.length <= late[0].requested.length);
  });

  // A peer is dropped when a block it was asked for is 120 s old, so its
  // queue must be small enough to arrive in time even before any block
  // has been seen, and as soon as large blocks start.
  it('plans for the largest blocks until sizes are known', () => {
    setHeaders(5000);
    const peers = addPeers(4);

    pool.requestHeaderBlocks();

    const depth = perPeer(Pool.INITIAL_BLOCK_SIZE);
    for (const peer of peers)
      assert.strictEqual(peer.requested.length, depth);
  });

  it('cuts the queue at the first large block after small ones', async () => {
    setHeaders(5000);
    const peers = addPeers(4);
    pool.blockSizes = [300];

    pool.requestHeaderBlocks();
    const peer = peers.find(p => p.blockMap.has(nodes[0].hash));
    await deliver(peer, nodes[0], 32 << 20);

    assert.strictEqual(pool.blockSizeEstimate(), 32 << 20);
  });

  it('lets queues grow again after a run of small blocks', async () => {
    setHeaders(5000);
    const [peer] = addPeers(1);
    pool.blockSizes = [32 << 20];
    for (let i = 1; i < Pool.BLOCK_SIZE_SAMPLES; i++)
      pool.blockSizes.push(300);

    pool.requestHeaderBlocks();
    const large = perPeer(32 << 20);
    assert.strictEqual(peer.blockMap.size, large);

    // The 32 MB sample falls out of the window.
    await deliver(peer, nodes[0]);
    assert.strictEqual(pool.blockSizeEstimate(), 300);
    assert(peer.blockMap.size > large);
  });

  it('times a delivering peer from its last block', async () => {
    setHeaders(5000);
    const [peer] = addPeers(1);
    pool.blockSizes = [300];

    pool.requestHeaderBlocks();
    assert(peer.blockMap.size > 1);

    // As if every request were old enough to time out.
    for (const key of peer.blockMap.keys())
      peer.blockMap.set(key, 0);

    await deliver(peer, nodes[0]);

    for (const time of peer.blockMap.values())
      assert(time > 0, 'request still timed from when it was sent');
  });

  it('caps each peer at its share of 32 MB blocks', async () => {
    setHeaders(5000);
    const peers = addPeers(4);
    pool.blockSizes = [32 << 20];

    pool.requestHeaderBlocks();

    for (const peer of peers)
      assert.strictEqual(peer.requested.length, perPeer(32 << 20));
  });

  it('connects in header order, whatever the arrival order', async () => {
    setHeaders(200);
    const peers = addPeers(3);

    pool.requestHeaderBlocks();

    const owner = new BufferMap();
    for (const peer of peers) {
      for (const hash of peer.requested)
        owner.set(hash, peer);
    }

    // Deliver everything requested so far, last first.
    const count = owner.size;
    assert(count > 1);

    for (const node of nodes.slice(0, count).reverse())
      await deliver(owner.get(node.hash), node);

    assert.strictEqual(connected.length, count);
    connected.forEach((hash, i) => assert(hash.equals(nodes[i].hash)));
    assert.strictEqual(pool.blockBuffer.size, 0);
  });

  it('asks the other peers for what a departing peer still owed', async () => {
    setHeaders(500);
    const [gone, ...rest] = addPeers(3);

    pool.requestHeaderBlocks();

    const owed = gone.requested.map(h => h.toString('hex'));
    assert(owed.length > 0);

    pool.disconnecting = true; // keep handleClose from refilling peers
    await pool.handleClose(gone, true);
    pool.disconnecting = false;

    // The others are full; they take it on as they deliver their own.
    for (const peer of rest) {
      for (const hash of peer.requested.slice()) {
        if (peer.blockMap.has(hash))
          await deliver(peer, pool.headerIndex.get(hash));
      }
    }

    const asked = requestedBy(rest);
    for (const hash of owed)
      assert(asked.has(hash), 'owed block not requested again');
  });

  it('shrinks the window for large blocks', async () => {
    setHeaders(5000);
    const peers = addPeers(4);

    pool.requestHeaderBlocks();

    // Every block turns out to be 32 MB; answer them in order.
    for (const node of nodes.slice(0, 400)) {
      const peer = peers.find(p => p.blockMap.has(node.hash));
      assert(peer, `block ${node.height} was never requested`);
      await deliver(peer, node, 32 << 20);
    }

    assert.strictEqual(pool.blockSizeEstimate(), 32 << 20);
    const held = pool.blockMap.size + pool.blockBuffer.size;
    assert(held <= window(32 << 20), `${held} blocks in flight`);
    assert(held >= peers.length);
  });

  it('downloads a gap longer than the in-flight limit', async () => {
    const gap = common.MAX_BLOCK_REQUEST + 10000;
    setHeaders(gap + 1);
    const [peer] = addPeers(1);

    pool.requestHeaderBlocks();

    for (const node of nodes.slice(0, gap)) {
      assert(!peer.destroyed);
      assert(peer.blockMap.size < common.MAX_BLOCK_REQUEST);
      await deliver(peer, node);
    }

    assert.strictEqual(connected.length, gap);
  });
});
