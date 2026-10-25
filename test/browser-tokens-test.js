/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * The web wallet's tokens (browser/wallet/tokens.js), over WebTransport
 * from a regtest node, checked as bcash's SLP indexer checks them: Type 1
 * coins valid once their token is added, an overspending SEND invalid
 * (nodes relay and mine it all the same), an unconfirmed chain valid with
 * its parents from the node's mempool and spent on at zero conf; Type 2
 * MINTs valid only drawing on their vault.
 * Needs the optional @fails-components/webtransport.
 */

const assert = require('bsert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {Vault} = require('../browser/wallet/vault');
const {Coins} = require('../browser/wallet/coins');
const {Tokens} = require('../browser/wallet/tokens');
const {buildTokenPayment, sendPayment} = require('../browser/wallet/send');
const KeyRing = require('../lib/primitives/keyring');
const MTX = require('../lib/primitives/mtx');
const Coin = require('../lib/primitives/coin');
const Script = require('../lib/script/script');
const hash160 = require('bcrypto/lib/hash160');

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

// An SLP script, every field a data push (an empty one OP_PUSHDATA1 0).
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
const byte = n => Buffer.from([n]);
const text = s => Buffer.from(s);
const id = hex => Buffer.from(hex, 'hex');

// A vault anyone may spend: redeem script OP_1.
const VAULT = Buffer.from([0x51]);
const VAULT_HASH = hash160.digest(VAULT);

describe('Web wallet tokens', function() {
  this.timeout(120000);

  let addon = null;
  before(async function() {
    try {
      addon = await import('@fails-components/webtransport');
    } catch (e) {
      this.skip();
    }
  });

  it('should check tokens as the SLP indexer does', async () => {
    const FullNode = require('../lib/node/fullnode');
    const SPVNode = require('../lib/node/spvnode');

    const base = 20000 + crypto.randomInt(0, 10000);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bcash-webtokens-'));
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
      for (let i = 0; i < 300 && !(await check()); i++)
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
    const issuerAddress = issuer.getAddress();
    const vault = new Vault({storage: new Storage(), iterations: 1000});
    let spv = null;

    // A transaction from the issuer: these coins, these outputs, the rest
    // of the XEC back (1,000 sats fee).
    const spend = async (coins, outputs, {extra = null} = {}) => {
      const mtx = new MTX();
      for (const [script, value] of outputs)
        mtx.addOutput(script, value);
      for (const coin of coins)
        mtx.addCoin(coin);
      const out = mtx.outputs.reduce((s, o) => s + o.value, 0);
      mtx.addOutput(issuerAddress, mtx.getInputValue() - out - 1000);
      mtx.sign(issuer);
      if (extra)
        extra(mtx);
      assert(mtx.verify(), 'test transaction did not verify');
      const tx = mtx.toTX();
      await full.sendTX(tx);
      await until(() => full.mempool.has(tx.hash()), 'mempool');
      return tx;
    };

    const mine = async () => {
      await rpc('generatetoaddress', 1,
        KeyRing.generate().getAddress().toString('regtest'));
    };

    try {
      await full.open();
      await full.connect();

      await vault.create('correct horse');
      const a = await vault.newKey('a', {network: 'regtest', height: 0});
      const b = await vault.newKey('b', {network: 'regtest', height: 0});

      await rpc('generatetoaddress', 5, issuerAddress.toString('regtest'));
      // XEC for A's token payment's dust and fee.
      await rpc('generatetoaddress', 1, a.address);
      await rpc('generatetoaddress', 100,
        KeyRing.generate().getAddress().toString('regtest'));
      const coinbase = async h => Coin.fromTX((await full.chain.getBlock(
        await full.chain.getHash(h))).txs[0], 0, h);

      const [current, next] = full.pool.wt.getHashes();
      spv = new SPVNode({
        network: 'regtest',
        prefix: dir,
        memory: false,
        workers: false,
        httpPort: base + 2,
        webTransport: addon.WebTransport,
        wtSeeds: [{host: '127.0.0.1', port: base,
          hashes: [current.hash, next.hash]}]
      });

      const coins = new Coins({vault, node: spv});
      await spv.open();
      await coins.open();
      const tokens = new Tokens({coins, node: spv});
      await spv.connect();
      spv.startSync();
      await until(() => spv.chain.height === 106, 'sync');

      const toA = vault.ring('a').getAddress();
      const coinsOf = address => coins.unspent(address).filter(c => c.token);

      // Type 1: a genesis (1000.00 TCENT), and 0.05 of it to A.
      const g1 = await spend([await coinbase(1)], [
        [slp(byte(1), text('GENESIS'), text('TCENT'), text('Test Cents'),
          text(''), text(''), byte(2), text(''), u64(100000)), 0],
        [issuerAddress, 546]]);
      const s1 = await spend([Coin.fromTX(g1, 1, -1), Coin.fromTX(g1, 2, -1)],
        [[slp(byte(1), text('SEND'), id(g1.txid()), u64(5), u64(99995)), 0],
          [toA, 546], [issuerAddress, 546]]);
      await mine();
      const g1Height = full.chain.height;
      await until(() => coinsOf(a.address).length === 1, 'token coin');

      const [coin] = coinsOf(a.address);
      assert.strictEqual(coin.slp.amount, '5');
      assert.strictEqual(tokens.status(coin), 'unknown');

      // As the wallet kept it before it read tokens: a token coin, no more.
      delete coin.slp;
      delete coins.state.txs[s1.txid()].raw;
      assert.strictEqual(tokens.balances(a.address).length, 0);

      // Added by its genesis: the coin is read again, and is good.
      const token = await tokens.add(g1.txid(), g1Height);
      assert.strictEqual(token.ticker, 'TCENT');
      assert.strictEqual(token.decimals, 2);
      assert.strictEqual(token.version, 1);
      await tokens.checkAll();
      assert.strictEqual(coin.slp.amount, '5');
      assert.strictEqual(tokens.status(coin), 'valid');
      await assert.rejects(tokens.add(s1.txid(), g1Height), /genesis/);

      // A SEND with no token input, claiming 1000.00: invalid.
      const bogus = await spend([await coinbase(2)],
        [[slp(byte(1), text('SEND'), id(g1.txid()), u64(100000)), 0],
          [toA, 546]]);
      // Invalid at once, unconfirmed: its parent is in no block since the
      // genesis, nor a mempool. Nodes do not judge SLP: mined all the same.
      await until(() => coinsOf(a.address).length === 2, 'bogus coin');
      const bogusCoin = coinsOf(a.address).find(c => c.txid === bogus.txid());
      assert.strictEqual(bogusCoin.height, -1);
      await tokens.checkAll();
      assert.strictEqual(tokens.status(bogusCoin), 'invalid');
      await mine();
      await until(() => bogusCoin.height !== -1, 'bogus mined');
      assert.strictEqual(tokens.status(bogusCoin), 'invalid');

      // An unconfirmed chain: valid, its parent from the node's mempool.
      const s3 = await spend([Coin.fromTX(s1, 2, g1Height),
        Coin.fromTX(s1, 3, g1Height)],
      [[slp(byte(1), text('SEND'), id(g1.txid()), u64(10), u64(99985)), 0],
        [issuerAddress, 546], [issuerAddress, 546]]);
      const s4 = await spend([Coin.fromTX(s3, 1, -1), Coin.fromTX(s3, 3, -1)],
        [[slp(byte(1), text('SEND'), id(g1.txid()), u64(10)), 0],
          [toA, 546]]);
      await until(() => coinsOf(a.address).length === 3, 'chained coin');
      const chained = coinsOf(a.address).find(c => c.txid === s4.txid());
      assert.strictEqual(chained.height, -1);
      await tokens.checkAll();
      assert.strictEqual(tokens.status(chained), 'valid');

      const balance = address => tokens.balances(address)
        .find(e => e.tokenId === g1.txid()) || {valid: 0n, invalid: 0n};
      assert.strictEqual(balance(a.address).valid, 15n);
      assert.strictEqual(balance(a.address).invalid, 100000n);

      // A pays B 0.07 at zero conf, on that unconfirmed chain: only valid
      // coins of the token, change back.
      const pay = await buildTokenPayment({coins, tokens, ring:
        vault.ring('a'), address: a.address, to: b.address, tokenId:
        g1.txid(), amount: 7n});
      assert(pay.tx.inputs.every(i => i.prevout.txid() !== bogus.txid()));
      assert(pay.tx.inputs.some(i => i.prevout.txid() === s4.txid()));
      await sendPayment({coins, node: spv, tx: pay.tx});
      await until(() => full.mempool.has(pay.tx.hash()), 'token payment');
      await tokens.checkAll();
      assert.strictEqual(balance(b.address).valid, 7n);
      assert.strictEqual(balance(a.address).valid, 8n);

      // Its XEC change is plain XEC, spendable at once; its token change
      // is kept apart.
      const outs = coins.unspent(a.address).filter(c => c.txid
        === pay.tx.txid());
      const xecChange = outs.find(c => c.vout === pay.tx.outputs.length - 1);
      assert(xecChange && !xecChange.token);
      assert(coins.spendable(a.address).includes(xecChange));
      assert(outs.find(c => c.vout === 2).token);

      // In each key's history: what the payment moved of the token.
      const moved = (address, txid) => tokens.movements(address).get(txid)
        .map(m => [m.tokenId, m.net]);
      assert.deepStrictEqual(moved(a.address, pay.tx.txid()),
        [[g1.txid(), -7n]]);
      assert.deepStrictEqual(moved(b.address, pay.tx.txid()),
        [[g1.txid(), 7n]]);

      // Mined: all still so.
      await mine();
      await until(() => coinsOf(b.address)[0].height !== -1, 'B confirmed');
      await tokens.checkAll();
      assert.strictEqual(balance(b.address).valid, 7n);
      assert.strictEqual(balance(a.address).valid, 8n);

      // Type 2: a genesis naming its vault, minting nothing; a MINT that
      // draws on the vault is valid, one that does not is not.
      const g2 = await spend([await coinbase(3)], [
        [slp(byte(2), text('GENESIS'), text('VLT'), text('Vault'), text(''),
          text(''), byte(0), VAULT_HASH, u64(0)), 0],
        [Script.fromScripthash(VAULT_HASH), 10000]]);
      await mine();
      const g2Height = full.chain.height;
      await until(() => spv.chain.height === g2Height, 'genesis 2');

      const mint = await spend([Coin.fromTX(g2, 1, g2Height),
        await coinbase(4)],
      [[slp(byte(2), text('MINT'), id(g2.txid()), u64(50)), 0], [toA, 546]],
      {extra: (mtx) => {
        // The vault input: its redeem script, OP_1.
        mtx.inputs[0].script = Script.fromRaw(Buffer.from([0x01, 0x51]));
      }});
      const noVault = await spend([await coinbase(5)],
        [[slp(byte(2), text('MINT'), id(g2.txid()), u64(50)), 0],
          [toA, 546]]);
      await mine();
      await until(() => coinsOf(a.address).some(c => c.txid === mint.txid())
        && coinsOf(a.address).some(c => c.txid === noVault.txid()),
      'mints');

      // Not added by hand: seen in its coins, found where a hint says.
      assert(!tokens.get(g2.txid()));
      tokens.heightOf = async txid => (txid === g2.txid() ? g2Height : null);
      await tokens.checkAll();
      const vlt = tokens.get(g2.txid());
      assert(vlt, 'not discovered');
      assert.strictEqual(vlt.version, 2);
      assert.strictEqual(vlt.vault, VAULT_HASH.toString('hex'));
      await tokens.checkAll();
      const status = txid => tokens.status(coinsOf(a.address)
        .find(c => c.txid === txid));
      assert.strictEqual(status(mint.txid()), 'valid');
      assert.strictEqual(status(noVault.txid()), 'invalid');
    } finally {
      if (spv)
        await spv.close();
      await full.close();
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });
});
