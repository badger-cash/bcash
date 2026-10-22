/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * Some peers answer an SPV node's filtered getdata with the full block
 * (an ABC 0.33.6 testnet node does). The pool filters it itself rather
 * than dropping the peer, which had cost SPV syncs most of their peers.
 */

const assert = require('bsert');
const {BloomFilter} = require('bfilter');
const {BufferMap} = require('buffer-map');
const random = require('bcrypto/lib/random');
const Chain = require('../lib/blockchain/chain');
const Pool = require('../lib/net/pool');
const Network = require('../lib/protocol/network');
const Block = require('../lib/primitives/block');
const MemBlock = require('../lib/primitives/memblock');
const MerkleBlock = require('../lib/primitives/merkleblock');
const MTX = require('../lib/primitives/mtx');
const Outpoint = require('../lib/primitives/outpoint');
const Script = require('../lib/script/script');

const network = Network.get('regtest');

function tx(script) {
  const mtx = new MTX();
  mtx.addInput({prevout: new Outpoint(random.randomBytes(32), 0)});
  mtx.addOutput(script, 1000);
  return mtx.toTX();
}

function coinbase() {
  const mtx = new MTX();
  mtx.addInput({
    prevout: new Outpoint(),
    script: Script.fromRaw(random.randomBytes(8))
  });
  mtx.addOutput(new Script(), 5000000000);
  return mtx.toTX();
}

// A regtest block with valid proof of work, after a coinbase.
function mineBlock(txs) {
  const block = new Block();
  block.version = 1;
  block.bits = network.pow.bits;
  block.time = network.now();
  block.txs.push(coinbase(), ...txs);
  block.merkleRoot = block.createMerkleRoot();
  while (!block.verifyPOW()) {
    block.nonce++;
    block.refresh();
  }
  return block;
}

function fakePeer() {
  return {
    blockMap: new BufferMap(),
    destroyed: false,
    ban: 0,
    hostname: () => '10.0.0.1:18444',
    destroy() {
      this.destroyed = true;
    },
    increaseBan(score) {
      this.ban += score;
    }
  };
}

describe('Pool SPV full blocks', function() {
  let pool, added;

  beforeEach(async () => {
    const chain = new Chain({network, memory: true, spv: true});
    await chain.open();
    pool = new Pool({network, chain, spv: true, memory: true,
      listen: false});
    added = [];
    pool.addBlock = async (peer, block) => {
      added.push(block);
    };
  });

  const packetOf = block => ({block: MemBlock.fromRaw(block.toRaw())});

  it('should filter a requested full block itself', async () => {
    const watched = Script.fromPubkeyhash(random.randomBytes(20));
    const mine = tx(watched);
    const other = tx(Script.fromPubkeyhash(random.randomBytes(20)));
    const block = mineBlock([other, mine]);

    pool.spvFilter = BloomFilter.fromRate(10, 0.000001,
      BloomFilter.flags.NONE);
    pool.spvFilter.add(watched.getPubkeyhash());

    const peer = fakePeer();
    peer.blockMap.set(block.hash(), Date.now());

    await pool.handleBlock(peer, packetOf(block));

    assert.strictEqual(peer.destroyed, false);
    assert.strictEqual(added.length, 1);

    const merkle = added[0];
    assert(merkle instanceof MerkleBlock);
    assert.bufferEqual(merkle.hash(), block.hash());
    assert(merkle.verify());
    assert.deepStrictEqual(merkle.txs.map(t => t.txid()), [mine.txid()]);

    // The window is sized for the full block, not the merkleblock.
    assert.strictEqual(pool.blockSizeEstimate(), block.getSize());
  });

  it('should still drop a peer for a block not asked for', async () => {
    const block = mineBlock([]);
    const peer = fakePeer();

    await pool.handleBlock(peer, packetOf(block));

    assert.strictEqual(peer.destroyed, true);
    assert.strictEqual(added.length, 0);
  });

  it('should ban a peer for a bad block', async () => {
    // Proof of work for the header, but a body that does not match it.
    const block = mineBlock([tx(new Script())]);
    block.txs.push(tx(new Script()));
    const peer = fakePeer();
    peer.blockMap.set(block.hash(), Date.now());

    await pool.handleBlock(peer, packetOf(block));

    assert.strictEqual(peer.ban, 100);
    assert.strictEqual(added.length, 0);
  });
});
