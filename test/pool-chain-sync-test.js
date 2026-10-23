/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * A full node drops an outbound peer left on a chain with less work than
 * ours, as Bitcoin ABC's ConsiderEviction, and dials it no more. On eCash
 * testnet, Bitcoin Cash nodes pass the handshake: kept, each asked for our
 * headers from the fork without end, and four of them kept a node busy
 * on one and a half cores.
 */

const assert = require('bsert');
const {randomBytes} = require('crypto');
const {BufferMap} = require('buffer-map');
const BN = require('bcrypto/lib/bn.js');
const Chain = require('../lib/blockchain/chain');
const BlockStore = require('../lib/blockstore/level');
const Pool = require('../lib/net/pool');
const Network = require('../lib/protocol/network');
const NetAddress = require('../lib/net/netaddress');

const network = Network.get('regtest');

const MINUTE = 60;

let ids = 0;

function fakePeer(options = {}) {
  const id = ids++;
  return {
    id,
    prev: null,
    next: null,
    outbound: true,
    handshake: true,
    destroyed: false,
    syncing: true,
    loader: false,
    bestKnown: null,
    chainSync: {timeout: 0, work: null, sentGetBlocks: false, protect: false},
    blockMap: new BufferMap(),
    txMap: new BufferMap(),
    compactBlocks: new BufferMap(),
    getBlocks: [],
    hostname: () => `10.0.0.${id}:18444`,
    sendGetBlocks(locator) {
      this.getBlocks.push(locator);
    },
    destroy() {
      this.destroyed = true;
    },
    ...options
  };
}

function entry(work, prevBlock = randomBytes(32)) {
  const hash = randomBytes(32);
  return {
    hash,
    prevBlock,
    chainwork: new BN(work),
    rhash: () => Buffer.from(hash).reverse().toString('hex')
  };
}

describe('Pool chain sync eviction', function() {
  let blocks, chain, pool, entries, now;

  // Our chain: tips with growing work, the entries the chain knows.
  const setTip = (e) => {
    entries.set(e.hash, e);
    chain.tip = e;
  };

  const check = () => pool.checkChainSync();

  const later = (secs) => {
    now += secs;
  };

  beforeEach(async () => {
    blocks = new BlockStore({network, memory: true});
    chain = new Chain({network, memory: true, blocks});
    await blocks.open();
    await chain.open();
    pool = new Pool({network, chain, listen: false});

    entries = new BufferMap();
    chain.synced = true;
    chain.getEntryByHash = async hash => entries.get(hash) || null;
    chain.getLocator = async hash => [hash];

    now = 1700000000;
    pool.network = Object.create(network);
    pool.network.now = () => now;

    setTip(entry(100));
  });

  afterEach(async () => {
    await chain.close();
    await blocks.close();
  });

  const addPeer = (options) => {
    const peer = fakePeer(options);
    pool.peers.add(peer);
    return peer;
  };

  // Four peers that gave us our tip, protected: one more is not.
  const fillProtected = () => {
    for (let i = 0; i < 4; i++)
      pool.noteEntry(addPeer(), chain.tip);
  };

  it('drops a peer that never shows our tip, and dials it no more',
    async () => {
      const peer = addPeer();
      const tip = chain.tip;

      await check();
      assert.strictEqual(peer.chainSync.timeout, now + 20 * MINUTE);

      later(20 * MINUTE);
      await check();
      assert.strictEqual(peer.getBlocks.length, 0);

      // Past the timeout: one getblocks from our tip's parent.
      later(10);
      await check();
      assert.deepStrictEqual(peer.getBlocks, [[tip.prevBlock]]);
      assert(!peer.destroyed);

      later(2 * MINUTE);
      await check();
      assert(!peer.destroyed);

      later(10);
      await check();
      assert(peer.destroyed);
      assert(pool.oldChain.has(peer.hostname()));

      // Not dialed again.
      pool.peers.remove(peer);
      const [host, port] = peer.hostname().split(':');
      pool.knownGood.push(NetAddress.fromHost(host, Number(port), network));
      const next = pool.getHost();
      assert(!next || next.hostname !== peer.hostname());
    });

  it('keeps its time behind across reconnects', async () => {
    const hostname = () => '203.0.113.9:18444';
    const connect = () => addPeer({hostname});
    const disconnect = (peer) => {
      peer.destroy();
      pool.peers.remove(peer);
    };

    let peer = connect();
    await check();
    later(15 * MINUTE);
    disconnect(peer);

    // Back 5 minutes later: its 20 minutes are up.
    peer = connect();
    later(5 * MINUTE + 10);
    await check();
    assert.strictEqual(peer.getBlocks.length, 1);
    later(MINUTE);
    disconnect(peer);

    // Back again, its getblocks unanswered: it goes.
    peer = connect();
    later(MINUTE + 10);
    await check();
    assert(peer.destroyed);
    assert(pool.oldChain.has(hostname()));
    assert(!pool.chainSyncHosts.has(hostname()));
  });

  it('forgets a host that showed our tip', async () => {
    fillProtected();
    const hostname = () => '203.0.113.10:18444';

    const first = addPeer({hostname});
    await check();
    assert(pool.chainSyncHosts.has(hostname()));

    await pool.noteBlock(first, chain.tip.hash);
    await check();
    assert(!pool.chainSyncHosts.has(hostname()));

    // A new connection starts its own 20 minutes.
    pool.peers.remove(first);
    const again = addPeer({hostname});
    later(15 * MINUTE);
    await check();
    assert.strictEqual(again.chainSync.timeout, now + 20 * MINUTE);
  });

  it('keeps a peer that announces our tip', async () => {
    fillProtected();
    const peer = addPeer();

    await check();
    later(25 * MINUTE);
    await pool.noteBlock(peer, chain.tip.hash);
    await check();

    assert(!peer.chainSync.protect);
    assert.strictEqual(peer.chainSync.timeout, 0);
    assert.strictEqual(peer.getBlocks.length, 0);
    assert(!peer.destroyed);
  });

  it('keeps a peer that answers the getblocks in time', async () => {
    fillProtected();
    const peer = addPeer();

    await check();
    later(20 * MINUTE + 10);
    await check();
    assert.strictEqual(peer.getBlocks.length, 1);

    // Its inv names our tip.
    later(30);
    await pool.noteBlock(peer, chain.tip.hash);
    later(2 * MINUTE);
    await check();

    assert(!peer.destroyed);
    assert.strictEqual(peer.chainSync.timeout, 0);
  });

  it('gives a new timeout to a peer that caught up with an older tip',
    async () => {
      const peer = addPeer();
      const old = chain.tip;

      await check();
      setTip(entry(200, old.hash));
      later(10 * MINUTE);

      // It has the tip we first checked against, not the new one.
      await pool.noteBlock(peer, old.hash);
      await check();

      assert.strictEqual(peer.chainSync.timeout, now + 20 * MINUTE);
      assert.strictEqual(peer.chainSync.work, chain.tip);
      assert(!peer.destroyed);
    });

  it('ignores a block it announces that we do not know', async () => {
    const peer = addPeer();

    await check();
    await pool.noteBlock(peer, randomBytes(32));
    assert.strictEqual(peer.bestKnown, null);

    later(20 * MINUTE + 10);
    await check();
    later(2 * MINUTE + 10);
    await check();
    assert(peer.destroyed);
  });

  it('never drops inbound peers, the nodes we were given, or one syncing',
    async () => {
      const inbound = addPeer({outbound: false});
      const manual = addPeer();
      const notSyncing = addPeer({syncing: false});
      pool.hosts.nodes.push(NetAddress.fromHostname(manual.hostname(),
        network));

      for (let i = 0; i < 4; i++) {
        later(20 * MINUTE + 10);
        await check();
      }

      for (const peer of [inbound, manual, notSyncing]) {
        assert(!peer.destroyed);
        assert.strictEqual(peer.getBlocks.length, 0);
      }
    });

  it('protects the first four outbound peers to give us our tip',
    async () => {
      const peers = [];
      for (let i = 0; i < 5; i++)
        peers.push(addPeer());

      const inbound = addPeer({outbound: false});
      pool.noteEntry(inbound, chain.tip);

      for (const peer of peers)
        pool.noteEntry(peer, chain.tip);

      assert(!inbound.chainSync.protect);
      assert.deepStrictEqual(peers.map(p => p.chainSync.protect),
        [true, true, true, true, false]);

      // A new tip none of them has: the protected stay, the fifth goes.
      setTip(entry(200, chain.tip.hash));
      for (let i = 0; i < 3; i++) {
        await check();
        later(20 * MINUTE + 10);
      }
      await check();

      assert.deepStrictEqual(peers.map(p => p.destroyed),
        [false, false, false, false, true]);
    });

  it('keeps no best known on an SPV node', async () => {
    const spv = new Chain({network, memory: true, spv: true});
    await spv.open();
    const pool = new Pool({network, chain: spv, spv: true, listen: false});
    const peer = fakePeer();

    pool.noteEntry(peer, chain.tip);
    assert.strictEqual(peer.bestKnown, null);
    assert(!peer.chainSync.protect);
    await spv.close();
  });
});
