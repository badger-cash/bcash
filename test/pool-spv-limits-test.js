/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * How large a block an SPV pool's peers may send. An SPV chain never
 * computes its deployment state, so the pool decides from the tip's
 * height rather than from the chain's state.
 */

const assert = require('bsert');
const {randomBytes} = require('crypto');
const Chain = require('../lib/blockchain/chain');
const Pool = require('../lib/net/pool');
const packets = require('../lib/net/packets');
const Parser = require('../lib/net/parser');
const Framer = require('../lib/net/framer');
const Block = require('../lib/primitives/block');
const MTX = require('../lib/primitives/mtx');
const Script = require('../lib/script/script');
const Network = require('../lib/protocol/network');
const consensus = require('../lib/protocol/consensus');

const network = Network.get('regtest');

// A block of `txs` on `prev`, with work for the easy regtest target.
const mine = (prev, txs) => {
  const block = new Block({
    version: 1, prevBlock: prev, merkleRoot: Buffer.alloc(32),
    time: 1700000000, bits: 0x207fffff, nonce: 0
  });
  block.txs.push(...txs);
  block.merkleRoot = block.createMerkleRoot();
  for (block.refresh(); !block.verifyPOW(); block.refresh())
    block.nonce += 1;
  return block;
};

const coinbase = () => {
  const mtx = new MTX();
  mtx.addInput({prevout: {hash: Buffer.alloc(32), index: 0xffffffff},
    script: Script.fromRaw(Buffer.from([4, 1, 0, 0, 0]))});
  mtx.addOutput(Script.fromPubkeyhash(randomBytes(20)), 5000);
  return mtx.toTX();
};

describe('Pool (SPV) block size', function() {
  this.timeout(20000);

  const anchor = mine(randomBytes(32), [coinbase()]);
  let chain;

  before(async () => {
    // Past regtest's UAHF height, as any chain anchored today is.
    chain = new Chain({
      network, memory: true, spv: true,
      anchor: {height: 1000, headers: [anchor.toHead()]}
    });
    await chain.open();
  });

  after(async () => {
    await chain.close();
  });

  const poolWith = nodes => new Pool({
    network, chain, spv: true, memory: true, listen: false, nodes
  });

  it('takes blocks over 2 MB off the wire, past the UAHF', () => {
    // An SPV chain checks no deployments, so it must not size blocks by
    // the 1 MB limit from before the fork.
    const txs = [coinbase()];
    for (let i = 0; i < 3; i++) {
      const mtx = new MTX();
      mtx.addInput({prevout: {hash: randomBytes(32), index: 0}});
      // A long script of OP_1s: only its size matters here.
      mtx.addOutput(Script.fromRaw(Buffer.alloc(900000, 0x51)), 0);
      txs.push(mtx.toTX());
    }
    const big = mine(anchor.hash(), txs);
    assert(big.getSize() > 2 * consensus.MAX_BLOCK_SIZE);

    const pool = poolWith(['10.0.0.1:18444']);
    const parser = new Parser(network, pool.options.maxBlockSize);
    const got = [];
    parser.on('packet', p => got.push(p));
    parser.on('error', e => got.push(e));
    parser.feed(new Framer(network).packet('block', big.toRaw()));
    assert.strictEqual(got.length, 1);
    assert.strictEqual(got[0].type, packets.types.BLOCK);
  });
});
