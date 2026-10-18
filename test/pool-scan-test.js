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
const Pool = require('../lib/net/pool');
const Peer = require('../lib/net/peer');
const packets = require('../lib/net/packets');
const Block = require('../lib/primitives/block');
const MerkleBlock = require('../lib/primitives/merkleblock');
const MTX = require('../lib/primitives/mtx');
const Script = require('../lib/script/script');
const Network = require('../lib/protocol/network');

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

// COUNT chained blocks of a few transactions; every fifth pays `watched`.
const buildBlocks = (watched) => {
  const blocks = [];
  let prev = randomBytes(32);
  for (let i = 0; i < COUNT; i++) {
    const block = new Block({
      version: 1, prevBlock: prev, merkleRoot: Buffer.alloc(32),
      time: 1700000000 + i * 600,
      bits: 0x207fffff, nonce: 0
    });
    block.txs.push(payTo(randomBytes(20)));
    if (i % 5 === 0)
      block.txs.push(payTo(watched));
    block.txs.push(payTo(randomBytes(20)));
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
      if (behaviour(this) === 'refuse')
        throw new Error('connection refused');
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
            this.emit('packet', new packets.BlockPacket(block));
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
    txs: i % 5 === 0 ? [b.txs[1].txid()] : []
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
    assert(served.every(h => h === '10.0.0.4' || h === '10.0.0.2'));
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
