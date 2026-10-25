/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * The web wallet below its chain's anchor (browser/wallet/history.js): a
 * page's chain starts at a checkpoint, but an imported key may hold coins
 * from before, and a token's genesis and history may be older. Over
 * WebTransport from a regtest node, a page anchored at block 140 finds an
 * imported key's payment and token coin from block 102, adds the token
 * from its genesis there, and checks the coin valid back to it: blocks
 * below the anchor scanned by hashes proven from the genesis to the
 * anchor. Needs the optional @fails-components/webtransport.
 */

const assert = require('bsert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {Vault} = require('../browser/wallet/vault');
const {Coins} = require('../browser/wallet/coins');
const {Tokens} = require('../browser/wallet/tokens');
const {History} = require('../browser/wallet/history');
const KeyRing = require('../lib/primitives/keyring');
const MTX = require('../lib/primitives/mtx');
const Coin = require('../lib/primitives/coin');
const Script = require('../lib/script/script');

class Storage {
  constructor() {
    this.map = new Map();
  }

  getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }

  setItem(key, value) {
    this.map.set(key, String(value));
  }

  removeItem(key) {
    this.map.delete(key);
  }
}

function slp(...fields) {
  const push = (data) => {
    if (data.length === 0)
      return Buffer.from([0x4c, 0x00]);
    return Buffer.concat([Buffer.from([data.length]), data]);
  };
  return Script.fromRaw(Buffer.concat([Buffer.from([0x6a]),
    push(Buffer.from('534c5000', 'hex')), ...fields.map(push)]));
}

const u64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
};
const text = s => Buffer.from(s);

describe('Web wallet history', function() {
  this.timeout(120000);

  let addon = null;
  before(async function() {
    try {
      addon = await import('@fails-components/webtransport');
    } catch (e) {
      this.skip();
    }
  });

  it('should find what an imported key held before the anchor', async () => {
    const FullNode = require('../lib/node/fullnode');
    const SPVNode = require('../lib/node/spvnode');

    const base = 20000 + crypto.randomInt(0, 10000);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bcash-webhistory-'));
    fs.mkdirSync(path.join(dir, 'regtest'));

    const full = new FullNode({
      network: 'regtest',
      memory: true,
      workers: false,
      bip37: true,
      listen: false,
      httpPort: base + 1,
      wtPort: base,
      wtHost: '127.0.0.1'
    });

    const until = async (check, what) => {
      for (let i = 0; i < 400 && !(await check()); i++)
        await new Promise(r => setTimeout(r, 100));
      assert(await check(), `Timed out: ${what}`);
    };

    const rpc = async (method, ...params) => {
      const json = await full.rpc.call({method, params}, {});
      if (json.error)
        throw new Error(json.error.message);
      return json.result;
    };

    const issuer = KeyRing.generate();
    const old = KeyRing.generate();
    let spv = null;

    try {
      await full.open();
      await full.connect();

      // Before the anchor: the issuer's coins mature, then at 102 a
      // payment to the old key, a token's genesis, and 0.05 of it to the
      // old key too.
      await rpc('generatetoaddress', 2,
        issuer.getAddress().toString('regtest'));
      await rpc('generatetoaddress', 99,
        KeyRing.generate().getAddress().toString('regtest'));
      const cb = async h => Coin.fromTX((await full.chain.getBlock(
        await full.chain.getHash(h))).txs[0], 0, h);

      const send = async (coins, outputs) => {
        const mtx = new MTX();
        for (const [script, value] of outputs)
          mtx.addOutput(script, value);
        for (const coin of coins)
          mtx.addCoin(coin);
        const out = mtx.outputs.reduce((s, o) => s + o.value, 0);
        mtx.addOutput(issuer.getAddress(), mtx.getInputValue() - out - 1000);
        mtx.sign(issuer);
        assert(mtx.verify());
        const tx = mtx.toTX();
        await full.sendTX(tx);
        await until(() => full.mempool.has(tx.hash()), 'mempool');
        return tx;
      };

      const pay = await send([await cb(1)], [[old.getAddress(), 3e8]]);

      // The old key spends it on, to itself, in the same block: the child
      // listed first, its txid lower (blocks order by txid), as a scan
      // gets it.
      let onward = null;
      for (let fee = 1000; ; fee++) {
        const mtx = new MTX();
        mtx.addCoin(Coin.fromTX(pay, 0, -1));
        mtx.addOutput(old.getAddress(), 3e8 - fee);
        mtx.sign(old);
        if (mtx.txid() < pay.txid()) {
          onward = mtx.toTX();
          break;
        }
      }
      await full.sendTX(onward);
      await until(() => full.mempool.has(onward.hash()), 'mempool');
      const genesis = await send([await cb(2)], [
        [slp(Buffer.from([1]), text('GENESIS'), text('OLD'), text('Old'),
          text(''), text(''), Buffer.from([2]), text(''), u64(1000)), 0],
        [issuer.getAddress(), 546]]);
      const tokenSend = await send([Coin.fromTX(genesis, 1, -1),
        Coin.fromTX(genesis, 2, -1)],
      [[slp(Buffer.from([1]), text('SEND'), Buffer.from(genesis.txid(), 'hex'),
        u64(5), u64(995)), 0],
      [old.getAddress(), 546], [issuer.getAddress(), 546]]);
      await rpc('generatetoaddress', 1,
        KeyRing.generate().getAddress().toString('regtest'));
      assert.strictEqual(full.chain.height, 102);

      await rpc('generatetoaddress', 48,
        KeyRing.generate().getAddress().toString('regtest'));

      // The page: anchored at 140, nothing below it held.
      const anchorHash = await full.chain.getHash(140);
      const [current, next] = full.pool.wt.getHashes();
      spv = new SPVNode({
        network: 'regtest',
        prefix: dir,
        memory: false,
        workers: false,
        httpPort: base + 2,
        anchor: {height: 140,
          hash: Buffer.from(anchorHash).reverse().toString('hex')},
        webTransport: addon.WebTransport,
        wtSeeds: [{host: '127.0.0.1', port: base,
          hashes: [current.hash, next.hash]}]
      });

      const vault = new Vault({storage: new Storage(), iterations: 1000});
      await vault.create('correct horse');

      const coins = new Coins({vault, node: spv});
      await spv.open();
      assert.strictEqual(await spv.chain.getEntryByHeight(102), null);
      await coins.open();
      const tokens = new Tokens({coins, node: spv});
      await spv.connect();
      spv.startSync();
      await until(() => spv.chain.height === 150, 'sync');

      // The headers below the anchor, proven from the genesis to it.
      const history = new History({node: spv});
      const below = await history.below(100, 140);
      assert.strictEqual(below.length, 41);
      assert.deepStrictEqual(below[2].hash, await full.chain.getHash(102));

      // A key born at the anchor: all of it is in the chain, no header
      // fetched.
      let fetched = 0;
      const fetchHeaders = spv.pool.fetchHeaders.bind(spv.pool);
      spv.pool.fetchHeaders = (...args) => {
        fetched += 1;
        return fetchHeaders(...args);
      };
      const atAnchor = await vault.newKey('at anchor',
        {network: 'regtest', height: 140});
      coins.watch(vault.list('regtest').find(k => k.name === 'at anchor'));
      await coins.cover(vault.list('regtest')
        .find(k => k.name === 'at anchor'), 140);
      assert.strictEqual(fetched, 0);
      assert.strictEqual(coins.balance(atAnchor.address).total, 0);

      // The old key, imported, born at 100: its history found below.
      const imported = await vault.importText(old.toSecret('regtest'),
        'old', {network: 'regtest', height: 100});
      const key = vault.list('regtest').find(k => k.name === 'old');
      coins.watch(key);
      await coins.cover(key, 100);

      // The first payment spent, the onward one held: not both.
      const balance = coins.balance(imported.address);
      assert.strictEqual(balance.confirmed, onward.outputs[0].value);
      assert.strictEqual(balance.locked, 546);
      assert(coins.state.coins[`${pay.txid()}:0`].spent === onward.txid());
      const history102 = coins.history(imported.address);
      assert.deepStrictEqual(history102.map(h => h.height), [102, 102, 102]);
      // Each at its block's time, from that block's own header.
      const time102 = (await full.chain.getEntryByHeight(102)).time;
      assert(history102.every(h => h.time === time102));

      // The token, from its genesis below the anchor; the coin valid back
      // to it.
      const token = await tokens.add(genesis.txid(), 102);
      assert.strictEqual(token.ticker, 'OLD');
      await tokens.checkAll();
      const coin = coins.unspent(imported.address)
        .find(c => c.txid === tokenSend.txid());
      assert.strictEqual(tokens.status(coin), 'valid');
      assert(coins.unspent(imported.address).some(c => c.txid
        === onward.txid()));
    } finally {
      if (spv)
        await spv.close();
      await full.close();
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });
});
