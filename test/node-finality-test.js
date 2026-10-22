/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * Avalanche finality over RPC (Bitcoin ABC's isfinalblock,
 * isfinaltransaction and getblockchaininfo's finalized_blockhash) and
 * over HTTP (isFinal on blocks, transactions and coins). Final means
 * confirmed on the main chain at or below the finalized tip.
 */

const assert = require('bsert');
const secp256k1 = require('bcrypto/lib/secp256k1');
const {NodeClient} = require('../lib/client');
const FullNode = require('../lib/node/fullnode');
const KeyRing = require('../lib/primitives/keyring');
const util = require('../lib/utils/util');

if (process.browser)
  return;

function createNode(avalanche, port) {
  const node = new FullNode({
    network: 'regtest',
    apiKey: 'foo',
    memory: true,
    workers: false,
    listen: false,
    indexTX: true,
    indexAddress: true,
    avalanche,
    port,
    httpPort: port + 1
  });
  const client = new NodeClient({port: port + 1, apiKey: 'foo'});
  return {node, client};
}

async function mine(node, address, count) {
  const entries = [];
  for (let i = 0; i < count; i++) {
    const block = await node.miner.mineBlock(node.chain.tip, address);
    entries.push(await node.chain.add(block));
  }
  return entries;
}

async function rpcError(client, method, params) {
  try {
    await client.execute(method, params);
  } catch (e) {
    return e.message;
  }
  throw new Error(`${method} did not fail.`);
}

describe('Node finality', function() {
  this.timeout(30000);

  const {node, client} = createNode(true, 49431);
  const ring = KeyRing.fromPrivate(secp256k1.privateKeyGenerate());
  const address = ring.getAddress();

  let entries;
  let coinbase;

  before(async () => {
    await node.open();
    await client.open();
    entries = await mine(node, address, 3);
    const block = await node.chain.getBlock(entries[0].hash);
    coinbase = block.txs[0];
  });

  after(async () => {
    await client.close();
    await node.close();
  });

  it('should wait for a quorum to answer', async () => {
    const msg = await rpcError(client, 'isfinalblock',
      [entries[0].rhash()]);
    assert.strictEqual(msg, 'Avalanche is not ready to poll yet.');
  });

  it('should report the finalized tip', async () => {
    // Genesis until something is finalized, as in ABC.
    let info = await client.execute('getblockchaininfo', []);
    assert.strictEqual(info.finalized_blockhash,
      util.revHex(node.network.genesis.hash));

    // Polls would do this; the processor is not connected to anyone.
    node.pool.avalanche.isQuorumEstablished = () => true;
    assert(await node.chain.finalize(entries[1]));

    info = await client.execute('getblockchaininfo', []);
    assert.strictEqual(info.finalized_blockhash, entries[1].rhash());
  });

  it('should answer isfinalblock', async () => {
    assert.strictEqual(
      await client.execute('isfinalblock', [entries[0].rhash()]), true);
    assert.strictEqual(
      await client.execute('isfinalblock', [entries[1].rhash()]), true);
    assert.strictEqual(
      await client.execute('isfinalblock', [entries[2].rhash()]), false);

    const msg = await rpcError(client, 'isfinalblock',
      ['00'.repeat(32)]);
    assert.strictEqual(msg, 'Block not found');
  });

  it('should answer isfinaltransaction', async () => {
    const txid = coinbase.txid();
    assert.strictEqual(
      await client.execute('isfinaltransaction', [txid]), true);
    assert.strictEqual(await client.execute('isfinaltransaction',
      [txid, entries[0].rhash()]), true);

    const last = await node.chain.getBlock(entries[2].hash);
    assert.strictEqual(await client.execute('isfinaltransaction',
      [last.txs[0].txid()]), false);

    let msg = await rpcError(client, 'isfinaltransaction',
      [txid, entries[1].rhash()]);
    assert.strictEqual(msg,
      'No such transaction found in the provided block.');

    msg = await rpcError(client, 'isfinaltransaction', ['00'.repeat(32)]);
    assert.strictEqual(msg, 'No such mempool or blockchain transaction.');
  });

  it('should mark blocks, transactions and coins final over HTTP', async () => {
    assert.strictEqual((await client.getBlock(entries[0].rhash())).isFinal,
      true);
    assert.strictEqual((await client.getBlock(entries[2].rhash())).isFinal,
      false);

    assert.strictEqual((await client.getTX(coinbase.txid())).isFinal, true);

    const coin = await client.getCoin(coinbase.txid(), 0);
    assert.strictEqual(coin.isFinal, true);

    const coins = await client.getCoinsByAddress(address.toString('regtest'));
    assert.strictEqual(coins.length, 3);
    const final = coins.filter(c => c.isFinal).map(c => c.height).sort();
    assert.deepStrictEqual(final, [1, 2]);

    const txs = await client.getTXByAddress(address.toString('regtest'));
    assert.strictEqual(txs.filter(tx => tx.isFinal).length, 2);
  });
});

describe('Node finality without avalanche', function() {
  this.timeout(30000);

  const {node, client} = createNode(false, 49441);
  const ring = KeyRing.fromPrivate(secp256k1.privateKeyGenerate());
  const address = ring.getAddress();

  let entries;

  before(async () => {
    await node.open();
    await client.open();
    entries = await mine(node, address, 2);
  });

  after(async () => {
    await client.close();
    await node.close();
  });

  it('should say avalanche is off, and nothing is final', async () => {
    const msg = await rpcError(client, 'isfinalblock',
      [entries[0].rhash()]);
    assert.strictEqual(msg, 'Avalanche is not enabled.');

    const info = await client.execute('getblockchaininfo', []);
    assert.strictEqual(info.finalized_blockhash,
      util.revHex(node.network.genesis.hash));

    assert.strictEqual((await client.getBlock(entries[0].rhash())).isFinal,
      false);
  });
});
