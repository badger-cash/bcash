/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * The transaction index's spenders: for a spent output, the input that
 * spent it. Unconfirmed from the mempool, then from the index once mined,
 * gone again when the block leaves the chain; over HTTP as `spentBy` on a
 * transaction's outputs and at /spent/:hash/:index. An index made before
 * it kept spenders fills them in on opening.
 */

const assert = require('bsert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const FullNode = require('../lib/node/fullnode');
const KeyRing = require('../lib/primitives/keyring');
const MTX = require('../lib/primitives/mtx');
const Coin = require('../lib/primitives/coin');
const layout = require('../lib/indexer/layout');

const API_KEY = 'spent';

describe('Indexer spenders', function() {
  this.timeout(60000);

  const key = KeyRing.generate();
  const other = KeyRing.generate();
  let dir, port, node;

  const open = async () => {
    node = new FullNode({
      network: 'regtest',
      prefix: dir,
      memory: false,
      workers: false,
      indexTX: true,
      listen: false,
      apiKey: API_KEY,
      httpPort: port
    });
    await node.ensure();
    await node.open();
  };

  const http = async (route) => {
    const res = await fetch(`http://127.0.0.1:${port}${route}`, {
      headers: {Authorization: 'Basic '
        + Buffer.from(`x:${API_KEY}`).toString('base64')}
    });
    return {status: res.status, body: res.status === 200 ? await res.json()
      : null};
  };

  // Pay `other` from the coinbase at `height`, into the mempool.
  const spend = async (height) => {
    const block = await node.chain.getBlock(await node.chain.getHash(height));
    const mtx = new MTX();
    mtx.addCoin(Coin.fromTX(block.txs[0], 0, height));
    mtx.addOutput(other.getAddress(), 1e8);
    mtx.addOutput(key.getAddress(), block.txs[0].outputs[0].value - 1e8 - 1000);
    mtx.sign(key);
    const tx = mtx.toTX();
    await node.sendTX(tx);
    assert(node.mempool.has(tx.hash()));
    return {tx, parent: block.txs[0]};
  };

  const mine = async (n, to = KeyRing.generate()) => {
    await node.rpc.call({method: 'generatetoaddress',
      params: [n, to.getAddress().toString('regtest')]}, {});
  };

  const synced = async () => {
    for (let i = 0; i < 100 && node.txindex.height !== node.chain.height; i++)
      await new Promise(r => setTimeout(r, 50));
    assert.strictEqual(node.txindex.height, node.chain.height);
  };

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bcash-spent-'));
    fs.mkdirSync(path.join(dir, 'regtest'));
    port = 10000 + crypto.randomInt(0, 9000);
    await open();
    await mine(2, key);
    await mine(100);
    await synced();
  });

  afterEach(async () => {
    if (node)
      await node.close();
    node = null;
    fs.rmSync(dir, {recursive: true, force: true});
  });

  it('should give a spend\'s spender: unconfirmed, mined, undone',
    async () => {
    const {tx, parent} = await spend(1);
    const txid = tx.txid();

    // In the mempool: height -1.
    let spender = await node.getSpender(parent.hash(), 0);
    assert.deepStrictEqual(
      {txid: spender.hash.toString('hex'), input: spender.index,
        height: spender.height},
      {txid: tx.hash().toString('hex'), input: 0, height: -1});

    // Mined: from the index, with its block's height.
    await mine(1);
    await synced();
    const height = node.chain.height;
    spender = await node.txindex.getSpender(parent.hash(), 0);
    assert(spender.hash.equals(tx.hash()));
    assert.strictEqual(spender.index, 0);
    assert.strictEqual(spender.height, height);

    // Over HTTP: on the spent transaction's outputs, and by outpoint.
    const {body: json} = await http(`/tx/${parent.txid()}`);
    assert.deepStrictEqual(json.outputs[0].spentBy,
      {txid, input: 0, height});
    const {body: own} = await http(`/tx/${txid}`);
    assert.strictEqual(own.outputs[0].spentBy, null);
    assert.deepStrictEqual((await http(`/spent/${parent.txid()}/0`)).body,
      {txid, input: 0, height});
    assert.strictEqual((await http(`/spent/${txid}/0`)).status, 404);

    // A coinbase spends nothing: no record for its null outpoint.
    const coinbase = (await node.chain.getBlock(
      await node.chain.getHash(height))).txs[0];
    assert.strictEqual(await node.txindex.getSpender(
      coinbase.inputs[0].prevout.hash, coinbase.inputs[0].prevout.index),
    null);

    // The block leaves the chain, as in a reorg: the spend leaves the
    // index, and its transaction goes back to the mempool, still spending
    // the output. (The mempool takes a disconnected block's transactions
    // back only when it holds others, as on a live network.)
    await spend(2);
    await node.chain.disconnect(node.chain.tip);
    await synced();
    assert.strictEqual(await node.txindex.getSpender(parent.hash(), 0),
      null);
    for (let i = 0; i < 100 && !node.mempool.has(tx.hash()); i++)
      await new Promise(r => setTimeout(r, 50));
    assert(node.mempool.has(tx.hash()));
    assert.deepStrictEqual((await http(`/spent/${parent.txid()}/0`)).body,
      {txid, input: 0, height: -1});

    // Mined again; then a reset below it: out of the index again.
    await mine(1);
    await synced();
    const again = node.chain.height;
    assert.strictEqual(
      (await node.txindex.getSpender(parent.hash(), 0)).height, again);
    await node.chain.reset(again - 1);
    await synced();
    assert.strictEqual(await node.txindex.getSpender(parent.hash(), 0),
      null);
  });

  it('should fill in spenders for an index made without them', async () => {
    const {tx, parent} = await spend(1);
    await mine(1);
    const {tx: second, parent: secondParent} = await spend(2);
    await mine(1);
    await synced();

    // As an index made before spenders were: none, and no fill-in record.
    const {db} = node.txindex;
    const batch = db.batch();
    const keys = await db.keys({
      gte: layout.p.min(), lte: layout.p.max()
    });
    assert(keys.length >= 2);
    for (const k of keys)
      batch.del(k);
    batch.del(layout.P.encode());
    await batch.write();
    assert.strictEqual(await node.txindex.getSpender(parent.hash(), 0),
      null);

    await node.close();
    await open();
    assert(node.txindex.filling, 'no fill-in started');
    await node.txindex.filling;
    assert(node.txindex.spendersComplete);

    const a = await node.txindex.getSpender(parent.hash(), 0);
    const b = await node.txindex.getSpender(secondParent.hash(), 0);
    assert(a.hash.equals(tx.hash()));
    assert(b.hash.equals(second.hash()));

    // Done: a reopen fills nothing in again.
    await node.close();
    await open();
    assert.strictEqual(node.txindex.filling, null);
  });
});
