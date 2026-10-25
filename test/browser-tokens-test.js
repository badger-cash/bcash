/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * The web wallet's tokens (browser/wallet/tokens.js), over WebTransport
 * from a regtest node, checked as bcash's SLP indexer checks them: Type 1
 * coins valid once their token is added; a SEND claiming tokens no parent
 * found holds unproven, one its found parents fall short of invalid (nodes
 * relay and mine both all the same); an unconfirmed chain valid with its
 * parents from the node's mempool and spent on at zero conf; Type 1 MINTs
 * valid down their baton's chain, and not without it; Type 2 MINTs valid
 * only drawing on their vault.
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

      await rpc('generatetoaddress', 8, issuerAddress.toString('regtest'));
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
      await until(() => spv.chain.height === 109, 'sync');

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

      // The genesis kept whole, and every field of its OP_RETURN in the
      // token's record, with its block.
      assert.strictEqual(tokens.state.slpTXs[g1.txid()].raw,
        g1.toRaw().toString('hex'));
      assert.strictEqual(token.name, 'Test Cents');
      assert.strictEqual(token.uri, '');
      assert.strictEqual(token.documentHash, '');
      assert.strictEqual(token.quantity, '100000');
      assert.strictEqual(token.batonVout, null);
      assert.strictEqual(token.block, Buffer.from(
        await full.chain.getHash(g1Height)).reverse().toString('hex'));

      // As recorded before every field was: described again from the
      // genesis kept.
      tokens.state.tokens[g1.txid()] = {tokenId: g1.txid(), height: g1Height,
        ticker: 'TCENT', decimals: 2, version: 1};
      await tokens.checkAll();
      assert.deepStrictEqual(tokens.get(g1.txid()), token);
      await tokens.checkAll();
      assert.strictEqual(coin.slp.amount, '5');
      assert.strictEqual(tokens.status(coin), 'valid');
      await assert.rejects(tokens.add(s1.txid(), g1Height), /genesis/);

      // A SEND with no token input, claiming 1000.00: invalid.
      const bogus = await spend([await coinbase(2)],
        [[slp(byte(1), text('SEND'), id(g1.txid()), u64(100000)), 0],
          [toA, 546]]);
      // Its only parent is in no block since the genesis, nor a mempool:
      // older than the token, or withheld. Unproven, locked, not kept as a
      // verdict. Nodes do not judge SLP: mined all the same.
      await until(() => coinsOf(a.address).length === 2, 'bogus coin');
      const bogusCoin = coinsOf(a.address).find(c => c.txid === bogus.txid());
      assert.strictEqual(bogusCoin.height, -1);
      await tokens.checkAll();
      assert.strictEqual(tokens.status(bogusCoin), 'unproven');
      await mine();
      await until(() => bogusCoin.height !== -1, 'bogus mined');
      assert.strictEqual(tokens.status(bogusCoin), 'unproven');
      assert.strictEqual(tokens.state.slpValid[bogus.txid()], undefined);

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

      // Short with every parent found: invalid. The issuer's 999.85 and
      // the chain's XEC change cannot make 2,000.00.
      const short = await spend([Coin.fromTX(s3, 2, -1),
        Coin.fromTX(s4, 2, -1)],
      [[slp(byte(1), text('SEND'), id(g1.txid()), u64(200000)), 0],
        [toA, 546]]);
      await until(() => coinsOf(a.address).some(c => c.txid === short.txid()),
        'short coin');
      await tokens.checkAll();
      const shortCoin = coinsOf(a.address).find(c => c.txid === short.txid());
      assert.strictEqual(tokens.status(shortCoin), 'invalid');

      const balance = address => tokens.balances(address)
        .find(e => e.tokenId === g1.txid())
        || {valid: 0n, invalid: 0n, unproven: 0n};
      assert.strictEqual(balance(a.address).valid, 15n);
      assert.strictEqual(balance(a.address).unproven, 100000n);
      assert.strictEqual(balance(a.address).invalid, 200000n);

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
      // draws on the vault is valid, one that does not is not. The vault
      // may be funded before the genesis: a MINT drawing on that is valid
      // too, decided by its redeem script, not by finding the coin.
      const early = await spend([await coinbase(7)],
        [[Script.fromScripthash(VAULT_HASH), 10000]]);
      await mine();
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
      const fromEarly = await spend([Coin.fromTX(early, 0, -1),
        Coin.fromTX(early, 1, -1)],
      [[slp(byte(2), text('MINT'), id(g2.txid()), u64(7)), 0], [toA, 546]],
      {extra: (mtx) => {
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
      assert.strictEqual(status(fromEarly.txid()), 'valid');

      // Type 2 with tokens at genesis: a coin descended from its initial
      // output is valid by the genesis alone, no vault MINT on the way.
      const g4 = await spend([await coinbase(8)], [
        [slp(byte(2), text('GENESIS'), text('GEN2'), text('Genesis made'),
          text(''), text(''), byte(0), VAULT_HASH, u64(100)), 0],
        [issuerAddress, 546]]);
      const fromGenesis = await spend([Coin.fromTX(g4, 1, -1),
        Coin.fromTX(g4, 2, -1)],
      [[slp(byte(2), text('SEND'), id(g4.txid()), u64(40), u64(60)), 0],
        [toA, 546], [issuerAddress, 546]]);
      await mine();
      const g4Height = full.chain.height;
      await until(() => coinsOf(a.address).some(c => c.txid
        === fromGenesis.txid() && c.height !== -1), 'from genesis');
      await tokens.add(g4.txid(), g4Height);
      await tokens.checkAll();
      assert.strictEqual(status(fromGenesis.txid()), 'valid');
      assert.strictEqual(tokens.balances(a.address)
        .find(e => e.tokenId === g4.txid()).valid, 40n);

      // Type 1 with a mint baton: MINT on MINT, the baton passed on, each
      // valid only down its baton's chain to the genesis.
      const g3 = await spend([await coinbase(6)], [
        [slp(byte(1), text('GENESIS'), text('BTN'), text('Baton'), text(''),
          text(''), byte(0), byte(2), u64(1)), 0],
        [issuerAddress, 546], [issuerAddress, 546]]);
      const mint1 = await spend([Coin.fromTX(g3, 2, -1),
        Coin.fromTX(g3, 3, -1)],
      [[slp(byte(1), text('MINT'), id(g3.txid()), byte(2), u64(10)), 0],
        [issuerAddress, 546], [issuerAddress, 546]]);
      const mint2 = await spend([Coin.fromTX(mint1, 2, -1),
        Coin.fromTX(mint1, 3, -1)],
      [[slp(byte(1), text('MINT'), id(g3.txid()), byte(2), u64(20)), 0],
        [toA, 546], [issuerAddress, 546]]);
      // Not the baton: the genesis's minted output.
      const fake = await spend([Coin.fromTX(g3, 1, -1),
        Coin.fromTX(mint2, 3, -1)],
      [[slp(byte(1), text('MINT'), id(g3.txid()), text(''), u64(30)), 0],
        [toA, 546]]);
      await mine();
      const g3Height = full.chain.height;
      await until(() => coinsOf(a.address).some(c => c.txid === fake.txid())
        && coinsOf(a.address).every(c => c.height !== -1), 'baton mints');

      const btn = await tokens.add(g3.txid(), g3Height);
      assert.strictEqual(btn.baton, true);
      assert.strictEqual(btn.batonVout, 2);
      await tokens.checkAll();
      assert.strictEqual(status(mint2.txid()), 'valid');
      assert.strictEqual(status(fake.txid()), 'invalid');
      assert.strictEqual(tokens.state.slpValid[mint1.txid()], true);
    } finally {
      if (spv)
        await spv.close();
      await full.close();
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });
});
