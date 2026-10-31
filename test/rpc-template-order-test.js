/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * eCash blocks order transactions by txid, so in a block template a
 * child may come before its parent. getblocktemplate asserted a parent
 * always came first, from Bitcoin's ordering, and failed outright when
 * the mempool held such a pair. It lists the parent among the child's
 * dependencies, wherever it is.
 */

const assert = require('bsert');
const FullNode = require('../lib/node/fullnode');
const KeyRing = require('../lib/primitives/keyring');
const MTX = require('../lib/primitives/mtx');
const Coin = require('../lib/primitives/coin');

describe('getblocktemplate in txid order', function() {
  this.timeout(60000);

  const node = new FullNode({
    network: 'regtest',
    memory: true,
    workers: false
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

  it('should list a parent that comes after its child', async () => {
    const first = await node.chain.getEntryByHeight(1);
    const block = await node.chain.getBlock(first.hash);
    const coinbase = block.txs[0];

    const parent = new MTX();
    parent.addCoin(Coin.fromTX(coinbase, 0, 1));
    parent.addOutput(ring.getAddress(), coinbase.outputs[0].value - 10000);
    parent.sign(ring);
    const ptx = parent.toTX();

    // A child whose txid sorts before its parent's.
    let ctx = null;
    for (let locktime = 0; !ctx; locktime++) {
      const child = new MTX();
      child.addCoin(Coin.fromTX(ptx, 0, -1));
      child.addOutput(ring.getAddress(), ptx.outputs[0].value - 10000);
      child.locktime = locktime;
      child.sign(ring);
      const tx = child.toTX();
      if (tx.txid() < ptx.txid())
        ctx = tx;
    }

    await node.mempool.addTX(ptx);
    await node.mempool.addTX(ctx);

    const tpl = await rpc('getblocktemplate', {rules: []});
    const at = txid => tpl.transactions.findIndex(t => t.txid === txid);
    const p = at(ptx.txid());
    const c = at(ctx.txid());

    assert(c !== -1 && p !== -1);
    assert(c < p, 'the child comes first');
    assert.deepStrictEqual(tpl.transactions[c].depends, [p + 1]);
    assert.deepStrictEqual(tpl.transactions[p].depends, []);
  });
});
