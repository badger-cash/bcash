/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * Pool#scanRange: a range of an SPV chain scanned again for what a bloom
 * filter matches, across several peers at once, without moving the tip.
 * The peers here are stand-ins answering getdata from real blocks, so the
 * merkleblocks, partial trees and matched transactions are genuine.
 */

const assert = require('bsert');
const {randomBytes} = require('crypto');
const {BloomFilter} = require('bfilter');
const Chain = require('../lib/blockchain/chain');
const NetAddress = require('../lib/net/netaddress');
const Pool = require('../lib/net/pool');
const Peer = require('../lib/net/peer');
const packets = require('../lib/net/packets');
const Block = require('../lib/primitives/block');
const MemBlock = require('../lib/primitives/memblock');
const MerkleBlock = require('../lib/primitives/merkleblock');
const MTX = require('../lib/primitives/mtx');
const Script = require('../lib/script/script');
const Network = require('../lib/protocol/network');
const Headers = require('../lib/primitives/headers');
const common = require('../lib/net/common');

const network = Network.get('regtest');
const START = 1000;
const COUNT = 40;

// A transaction paying `hash` (P2PKH), from a made-up input.
const payTo = (hash) => {
  const mtx = new MTX();
  mtx.addInput({prevout: {hash: randomBytes(32), index: 0}});
  mtx.addOutput(Script.fromPubkeyhash(hash), 1000);
  return mtx.toTX();
};

// A coinbase at `height`, so a full block passes its body checks.
const coinbase = (height) => {
  const mtx = new MTX();
  mtx.addInput({prevout: {hash: Buffer.alloc(32), index: 0xffffffff},
    script: Script.fromRaw(Buffer.from([4, height, 0, 0, 0]))});
  mtx.addOutput(Script.fromPubkeyhash(randomBytes(20)), 5000);
  return mtx.toTX();
};

// COUNT chained blocks of a few transactions; every fifth pays `watched`,
// and `extra(i)` gives any more transactions for block i.
const buildBlocks = (watched, count = COUNT, extra = () => []) => {
  const blocks = [];
  let prev = randomBytes(32);
  for (let i = 0; i < count; i++) {
    const block = new Block({
      version: 1, prevBlock: prev, merkleRoot: Buffer.alloc(32),
      time: 1700000000 + i * 600,
      bits: 0x207fffff, nonce: 0
    });
    block.txs.push(coinbase(i));
    block.txs.push(payTo(randomBytes(20)));
    if (i % 5 === 0)
      block.txs.push(payTo(watched));
    block.txs.push(payTo(randomBytes(20)));
    block.txs.push(...extra(i));
    block.merkleRoot = block.createMerkleRoot();
    // Work for the easy regtest target, as a merkleblock must carry.
    for (block.refresh(); !block.verifyPOW(); block.refresh())
      block.nonce += 1;
    blocks.push(block);
    prev = block.hash();
  }
  return blocks;
};

describe('Pool#scanRange', function() {
  this.timeout(20000);

  const watched = randomBytes(20);
  const blocks = buildBlocks(watched);
  const byHash = new Map(blocks.map(b => [b.hash().toString('hex'), b]));
  const saved = {};
  let chain, behaviour, served;

  before(async () => {
    chain = new Chain({
      network, memory: true, spv: true,
      anchor: {height: START, headers: blocks.map(b => b.toHead())}
    });
    await chain.open();

    const stubbed =
      ['connect', 'open', 'sendFilterLoad', 'getBlock', 'destroy'];
    for (const name of stubbed)
      saved[name] = Peer.prototype[name];

    Peer.prototype.connect = function(addr) {
      this.address = addr;
    };
    Peer.prototype.open = async function() {
      const how = behaviour(this);
      if (how === 'refuse')
        throw new Error('connection refused');
      // As a full node serving filters says, unless one that does not.
      this.services = how === 'nobloom'
        ? common.services.NETWORK
        : common.services.NETWORK | common.services.BLOOM;
      this.agent = how === 'abc-full'
        ? '/Bitcoin ABC:0.33.6(EB32.0)/'
        : '/Bitcoin ABC:0.34.1(EB32.0)/';
    };
    Peer.prototype.sendFilterLoad = function(filter) {
      this.scanFilter = filter;
    };
    Peer.prototype.destroy = function() {
      this.emit('close');
    };
    // Answer as a peer would: each merkleblock, then its matched txs.
    Peer.prototype.getBlock = function(hashes) {
      const how = behaviour(this);
      if (how === 'stall')
        return;
      setImmediate(() => {
        for (const hash of hashes) {
          const block = byHash.get(hash.toString('hex'));
          if (how === 'full') {
            // As a peer's would arrive: parsed from the wire, a MemBlock.
          const raw = new packets.BlockPacket(block).toRaw();
          this.emit('packet', packets.BlockPacket.fromRaw(raw));
            continue;
          }
          const source = how === 'lie'
            ? blocks[(blocks.indexOf(block) + 1) % COUNT]
            : block;
          // As it arrives off the wire: header and tree, no txs yet.
          const mb = MerkleBlock.fromRaw(
            MerkleBlock.fromBlock(source, this.scanFilter).toRaw());
          served.push(this.address.host);
          this.emit('packet', new packets.MerkleBlockPacket(mb));
          for (const tx of source.txs) {
            if (mb.hasTX(tx.hash()))
              this.emit('packet', new packets.TXPacket(tx));
          }
        }
      });
    };
  });

  after(async () => {
    Object.assign(Peer.prototype, saved);
    await chain.close();
  });

  beforeEach(() => {
    served = [];
  });

  const poolWith = nodes => new Pool({
    network, chain, spv: true, memory: true, listen: false, nodes
  });
  const filterFor = (...data) => {
    const filter = BloomFilter.fromRate(10, 0.000001, BloomFilter.flags.NONE);
    for (const d of data)
      filter.add(d);
    return filter;
  };
  const scan = async (pool, options) => {
    const seen = [];
    await pool.scanRange({start: START, end: START + COUNT - 1, ...options},
      async (entry, block) => {
        seen.push({height: entry.height, txs: block.txs.map(tx => tx.txid())});
      });
    return seen;
  };
  const expected = () => blocks.map((b, i) => ({
    height: START + i,
    txs: i % 5 === 0 ? [b.txs[2].txid()] : []
  }));

  it('delivers every block in height order with its matches', async () => {
    behaviour = () => 'serve';
    const pool = poolWith(['10.0.0.1:18444', '10.0.0.2:18444',
      '10.0.0.3:18444']);
    const seen = await scan(pool, {filter: filterFor(watched), batch: 4});

    assert.deepStrictEqual(seen, expected());
    assert.strictEqual(chain.height, START + COUNT - 1);
  });

  it('spreads the range across peers', async () => {
    behaviour = () => 'serve';
    const pool = poolWith(['10.0.0.1:18444', '10.0.0.2:18444',
      '10.0.0.3:18444']);
    await scan(pool, {filter: filterFor(watched), batch: 2});

    assert(new Set(served).size > 1, 'only one peer served');
  });

  it('gives a silent, lying or full-block peer\'s heights to others',
    async () => {
    const hosts = {'10.0.0.1': 'stall', '10.0.0.2': 'lie', '10.0.0.3': 'full'};
    behaviour = peer => hosts[peer.address.host] || 'serve';
    const pool = poolWith(['10.0.0.1:18444', '10.0.0.2:18444',
      '10.0.0.3:18444', '10.0.0.4:18444']);
    const seen = await scan(pool, {
      filter: filterFor(watched), batch: 4, timeout: 200
    });

    assert.deepStrictEqual(seen, expected());
    // The silent and the full-block peer served nothing kept.
    assert(served.every(h => h !== '10.0.0.1' && h !== '10.0.0.3'));
  });

  it('asks no peer known to send full blocks for filtered ones', async () => {
    // Bitcoin ABC 0.32.4 to 0.33.10 would: left before any request, as is
    // a peer serving no filters.
    const hosts = {'10.0.0.1': 'abc-full', '10.0.0.2': 'nobloom'};
    behaviour = peer => hosts[peer.address.host] || 'serve';
    const pool = poolWith(['10.0.0.1:18444', '10.0.0.2:18444',
      '10.0.0.3:18444']);
    const seen = await scan(pool, {filter: filterFor(watched), batch: 4});

    assert.deepStrictEqual(seen, expected());
    assert(served.length > 0);
    assert(served.every(h => h !== '10.0.0.1' && h !== '10.0.0.2'));
  });

  it('fails when no peer can serve the range', async () => {
    behaviour = () => 'refuse';
    const pool = poolWith(['10.0.0.1:18444']);
    await assert.rejects(scan(pool, {filter: filterFor(watched)}),
      /connection refused/);
  });

  it('refuses a filter that would update itself', async () => {
    behaviour = () => 'serve';
    const pool = poolWith(['10.0.0.1:18444']);
    const filter = BloomFilter.fromRate(10, 0.000001, BloomFilter.flags.ALL);
    await assert.rejects(scan(pool, {filter}), /does not update itself/);
  });

  it('leaves the pool free to connect to the hosts it scanned from', () => {
    const pool = poolWith(['10.0.0.1:18444']);
    const peer = pool.createDirectPeer();
    peer.options.createNonce('10.0.0.1:18444');
    // The pool's own connection to that host can still take a nonce.
    pool.options.createNonce('10.0.0.1:18444');
  });

  it('refuses heights the chain has no headers for', async () => {
    behaviour = () => 'serve';
    const pool = poolWith(['10.0.0.1:18444']);
    await assert.rejects(pool.scanRange({
      start: START, end: START + COUNT, filter: filterFor(watched)
    }, async () => {}), /No header at height/);
  });
});

describe('Pool#directHosts', function() {
  it('dials each host once for a job of its own', async () => {
    const chain = new Chain({network, memory: true, spv: true});
    const pool = new Pool({
      network, chain, spv: true, memory: true, listen: false,
      nodes: ['10.0.0.1:18444', '10.0.0.2:18444', '10.0.0.1:18444']
    });
    const hosts = await pool.directHosts();
    // The nodes first, then the table (regtest's seed, 127.0.0.1).
    assert.deepStrictEqual(hosts.map(a => a.hostname),
      ['10.0.0.1:18444', '10.0.0.2:18444', '127.0.0.1:48444']);
  });

  it('adds the table\'s hosts, those that answered and serve filters first',
    async () => {
    const chain = new Chain({network, memory: true, spv: true});
    const pool = new Pool({network, chain, spv: true, memory: true,
      listen: false, nodes: ['10.0.0.9:18444']});
    // Only the hosts added here in the table: not regtest's seed.
    pool.hosts.remove('127.0.0.1:48444');

    const {NETWORK, BLOOM} = common.services;
    const add = (hostname, services, success) => {
      const addr = NetAddress.fromHostname(hostname, network);
      addr.services = services;
      addr.time = 1700000000;
      pool.hosts.add(addr);
      if (success)
        pool.hosts.markAck(addr.hostname, services);
      return addr;
    };
    add('10.0.1.1:18444', NETWORK, false);
    add('10.0.1.2:18444', NETWORK | BLOOM, false);
    add('10.0.1.3:18444', NETWORK, true);
    add('10.0.1.4:18444', common.services.NETWORK_LIMITED | BLOOM, false);
    add('10.0.1.5:18444', NETWORK | BLOOM, false);
    pool.hosts.ban('10.0.1.5');

    const hosts = (await pool.directHosts()).map(a => a.hostname);
    // The node; then the table: answered before, then serving filters;
    // never one not serving the full chain, nor a banned one.
    assert.deepStrictEqual(hosts.slice(0, 3),
      ['10.0.0.9:18444', '10.0.1.3:18444', '10.0.1.2:18444']);
    assert(hosts.includes('10.0.1.1:18444'));
    assert(!hosts.includes('10.0.1.4:18444'));
    assert(!hosts.includes('10.0.1.5:18444'));
  });

  it('keeps to the hosts `only` names', async () => {
    const chain = new Chain({network, memory: true, spv: true});
    const pool = new Pool({network, chain, spv: true, memory: true,
      listen: false, only: ['10.0.0.1:18444']});
    const hosts = await pool.directHosts();
    assert.deepStrictEqual(hosts.map(a => a.hostname), ['10.0.0.1:18444']);
  });

  it('asks the seeds again when a lookup comes back empty', async () => {
    this.timeout(10000);
    const chain = new Chain({network, memory: true, spv: true});
    const pool = new Pool({network, chain, spv: true, memory: true,
      listen: false});

    // The first lookup fails, the second answers.
    let lookups = 0;
    pool.hosts.dnsSeeds = ['seed.example'];
    pool.hosts.populate = async () => {
      lookups += 1;
      return lookups < 2
        ? []
        : [NetAddress.fromHostname('10.0.0.3:18444', network)];
    };

    const hosts = await pool.directHosts();
    assert.strictEqual(lookups, 2);
    assert.deepStrictEqual(hosts.map(a => a.hostname),
      ['10.0.0.3:18444', '127.0.0.1:48444']);
  });
});

// Replace Peer methods for one describe block, restoring them after.
const stubPeers = (methods) => {
  const saved = {};
  before(() => {
    for (const [name, fn] of Object.entries(methods)) {
      saved[name] = Peer.prototype[name];
      Peer.prototype[name] = fn;
    }
  });
  after(() => {
    Object.assign(Peer.prototype, saved);
  });
};

// More legacy sigops than the limit eCash dropped for SigChecks: valid
// since Phonon, and in real blocks (mainnet 922709).
const sigopsHeavy = () => {
  const mtx = new MTX();
  mtx.addInput({prevout: {hash: randomBytes(32), index: 0}});
  mtx.addOutput(Script.fromRaw(Buffer.alloc(25000, 0xac)), 0);
  return mtx.toTX();
};

describe('Pool#scanRange with full blocks', function() {
  this.timeout(20000);

  const blocks = buildBlocks(randomBytes(20), COUNT,
    i => (i === 3 ? [sigopsHeavy()] : []));
  const byHash = new Map(blocks.map(b => [b.hash().toString('hex'), b]));
  let chain, behaviour, requested;

  stubPeers({
    connect(addr) {
      this.address = addr;
    },
    async open() {
      this.services = behaviour(this) === 'pruned'
        ? common.services.NETWORK_LIMITED
        : common.services.NETWORK;
    },
    destroy() {
      this.emit('close');
    },
    getItems(type, hashes) {
      const how = behaviour(this);
      for (const h of hashes)
        requested.push([this.address.host, h.toString('hex')]);
      // 'late' answers a little later, and gets the first block wrong.
      const first = blocks[0].hash().equals(hashes[0]);
      const answer = how === 'late' ? cb => setTimeout(cb, 100) : setImmediate;
      answer(() => {
        for (const hash of hashes) {
          let block = byHash.get(hash.toString('hex'));
          if (how === 'tamper' || (how === 'late' && first)) {
            // The real header, a transaction short: the root no longer fits.
            block = Block.fromRaw(block.toRaw());
            block.txs.pop();
            // Drop the serialization cached from fromRaw.
            block.refresh();
          }
          // As a peer's would arrive: parsed from the wire, a MemBlock.
          const raw = new packets.BlockPacket(block).toRaw();
          this.emit('packet', packets.BlockPacket.fromRaw(raw));
        }
      });
    }
  });

  before(async () => {
    chain = new Chain({
      network, memory: true, spv: true,
      anchor: {height: START, headers: blocks.map(b => b.toHead())}
    });
    await chain.open();
  });

  after(async () => {
    await chain.close();
  });

  beforeEach(() => {
    requested = [];
  });

  const poolWith = nodes => new Pool({
    network, chain, spv: true, memory: true, listen: false, nodes
  });
  const scan = async (pool, options = {}, slow = 0) => {
    const seen = [];
    await pool.scanRange({start: START, end: START + COUNT - 1, full: true,
      ...options}, async (entry, block) => {
      if (slow)
        await new Promise(r => setTimeout(r, slow));
      seen.push({height: entry.height, txs: block.txs.map(tx => tx.txid())});
    });
    return seen;
  };

  it('delivers every block whole, in order, with no filter', async () => {
    behaviour = () => 'serve';
    const seen = await scan(poolWith(['10.0.0.1:18444', '10.0.0.2:18444']));
    assert.deepStrictEqual(seen, blocks.map((b, i) => ({
      height: START + i, txs: b.txs.map(tx => tx.txid())
    })));
  });

  it('refuses a block whose transactions do not reach its root', async () => {
    const hosts = {'10.0.0.1': 'tamper'};
    behaviour = peer => hosts[peer.address.host] || 'serve';
    const seen = await scan(poolWith(['10.0.0.1:18444', '10.0.0.2:18444']));
    assert.strictEqual(seen.length, COUNT);
    assert(seen.every((s, i) => s.txs.length === blocks[i].txs.length));
  });

  it('asks only peers that serve the full chain', async () => {
    const hosts = {'10.0.0.1': 'pruned'};
    behaviour = peer => hosts[peer.address.host] || 'serve';
    await scan(poolWith(['10.0.0.1:18444', '10.0.0.2:18444']));
    assert(requested.length > 0);
    assert(requested.every(([host]) => host !== '10.0.0.1'));
  });

  it('fetches the next block to deliver when full', async function() {
    // The first block's peer fails it only after the other peer has filled
    // the buffer with the blocks after it.
    this.timeout(5000);
    const hosts = {'10.0.0.1': 'late'};
    behaviour = peer => hosts[peer.address.host] || 'serve';
    const seen = await scan(poolWith(['10.0.0.1:18444', '10.0.0.2:18444']),
      {maxBytes: blocks[0].getSize() * 2});
    assert.strictEqual(seen.length, COUNT);
  });

  it('keeps blocks serialized until handed on, then parses', async () => {
    behaviour = () => 'serve';
    const pool = poolWith(['10.0.0.1:18444']);
    const peer = pool.createDirectPeer();
    peer.connect(pool.hosts.nodes[0]);
    const kept = await pool.requestFullBlocks(peer,
      blocks.slice(0, 3).map(b => b.hash()), 1000);
    peer.destroy();
    assert(kept.every(b => b instanceof MemBlock));

    const handed = [];
    await pool.scanRange({start: START, end: START + 2, full: true},
      async (entry, block) => handed.push(block));
    assert(handed.every(b => b instanceof Block && b.txs.length > 0));
  });

  it('holds no more than maxBytes of blocks at once', async () => {
    behaviour = () => 'serve';
    const size = blocks[0].getSize();
    const maxBytes = size * 3;
    let outstanding = 0;
    let peak = 0;
    const pool = poolWith(['10.0.0.1:18444', '10.0.0.2:18444']);
    const orig = Peer.prototype.getItems;
    Peer.prototype.getItems = function(type, hashes) {
      outstanding += hashes.length;
      peak = Math.max(peak, outstanding);
      return orig.call(this, type, hashes);
    };
    try {
      await pool.scanRange({start: START, end: START + COUNT - 1, full: true,
        maxBytes, peers: 2}, async () => {
        await new Promise(r => setTimeout(r, 2));
        outstanding -= 1;
      });
    } finally {
      Peer.prototype.getItems = orig;
    }
    // The cap's three, one request a peer made before the cap was reached,
    // and the block being handed on.
    assert(peak <= 3 + 2 + 1, `peak ${peak} blocks`);
  });
});

describe('Pool#syncHeaders', function() {
  this.timeout(60000);

  // More than one getheaders answer's worth.
  const TOTAL = 2100;
  const blocks = buildBlocks(randomBytes(20), TOTAL);
  const index = new Map(blocks.map((b, i) => [b.hash().toString('hex'), i]));
  let chain, behaviour, asked;

  stubPeers({
    connect(addr) {
      this.address = addr;
    },
    async open() {},
    destroy() {
      this.emit('close');
    },
    sendGetHeaders(locator) {
      const how = behaviour(this);
      asked.push(this.address.host);
      setImmediate(() => {
        if (how === 'junk') {
          const stray = buildBlocks(randomBytes(20), 2);
          const items = stray.map(b => Headers.fromBlock(b));
          this.emit('packet', new packets.HeadersPacket(items));
          return;
        }
        const from = index.get(locator[0].toString('hex')) + 1;
        const next = blocks.slice(from, from + 2000)
          .map(b => Headers.fromBlock(b));
        this.emit('packet', new packets.HeadersPacket(next));
      });
    }
  });

  beforeEach(async () => {
    asked = [];
    chain = new Chain({
      network, memory: true, spv: true,
      anchor: {height: START, headers: [blocks[0].toHead()]}
    });
    await chain.open();
  });

  afterEach(async () => {
    await chain.close();
  });

  const poolWith = nodes => new Pool({
    network, chain, spv: true, memory: true, listen: false, nodes
  });

  it('brings the chain to the tip, 2000 headers a request', async () => {
    behaviour = () => 'serve';
    const tip = await poolWith(['10.0.0.1:18444']).syncHeaders();
    assert.strictEqual(tip.height, START + TOTAL - 1);
    assert.strictEqual(chain.tip.rhash(), blocks[TOTAL - 1].rhash());
    assert.strictEqual(asked.length, 2);
  });

  it('moves on from a peer whose headers do not connect', async () => {
    const hosts = {'10.0.0.1': 'junk'};
    behaviour = peer => hosts[peer.address.host] || 'serve';
    const pool = poolWith(['10.0.0.1:18444', '10.0.0.2:18444']);
    const tip = await pool.syncHeaders();
    assert.strictEqual(tip.height, START + TOTAL - 1);
  });
});
