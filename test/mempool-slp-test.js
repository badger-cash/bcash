/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * A node indexing SLP keeps the SLP records of mempool transactions: not
 * in the mempool's entries, which code walking the mempool takes every
 * value of to be. With an SLP transaction in it, the mempool counts it
 * once, the miner builds a block, and getrawmempool lists it.
 */

const assert = require('bsert');
const FullNode = require('../lib/node/fullnode');
const KeyRing = require('../lib/primitives/keyring');
const MTX = require('../lib/primitives/mtx');
const Coin = require('../lib/primitives/coin');
const Script = require('../lib/script/script');

// An SLP token GENESIS: ticker T, name Test, no document, 0 decimals, no
// baton, 1000 tokens to output 1. Empty fields as OP_PUSHDATA1 0.
const GENESIS = Script.fromRaw(Buffer.from('6a'
  + '04534c5000' + '0101' + '0747454e45534953' + '0154' + '0454657374'
  + '4c00' + '4c00' + '0100' + '4c00' + '0800000000000003e8', 'hex'));

describe('Mempool SLP records', function() {
  this.timeout(60000);

  const node = new FullNode({
    network: 'regtest',
    memory: true,
    workers: false,
    indexTX: true,
    indexSLP: true
  });

  const ring = KeyRing.generate();
  const address = ring.getAddress().toString('regtest');
  const rpc = async (method, ...params) => {
    const json = await node.rpc.call({method, params}, {});
    if (json.error)
      throw new Error(json.error.message);
    return json.result;
  };

  before(async () => {
    await node.open();
    await rpc('generatetoaddress', 101, address);
  });

  after(() => node.close());

  it('should keep them apart from the mempool\'s entries', async () => {
    const first = await node.chain.getEntryByHeight(1);
    const block = await node.chain.getBlock(first.hash);
    const coinbase = block.txs[0];

    const mtx = new MTX();
    mtx.addCoin(Coin.fromTX(coinbase, 0, 1));
    mtx.addOutput(GENESIS, 0);
    mtx.addOutput(ring.getAddress(), 546);
    mtx.addOutput(ring.getAddress(), coinbase.outputs[0].value - 546 - 10000);
    mtx.sign(ring);
    const tx = mtx.toTX();

    await node.mempool.addTX(tx);

    // The transaction once, its records apart.
    assert.strictEqual(node.mempool.map.size, 1);
    const records = node.mempool.getSlp(tx.hash());
    assert(records && records.length > 0);
    assert.deepStrictEqual(await rpc('getrawmempool'), [tx.txid()]);

    // The miner walks the mempool: it builds a block with it.
    const attempt = await node.miner.createBlock();
    assert(attempt.items.some(item => item.tx.hash().equals(tx.hash())));

    // Mined: gone, records and all.
    await rpc('generatetoaddress', 1, address);
    assert.strictEqual(node.mempool.map.size, 0);
    assert.strictEqual(node.mempool.getSlp(tx.hash()), null);
  });
});
