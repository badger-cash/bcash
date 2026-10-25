/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * The web wallet's engine (browser/wallet), in Node: keys sealed with a
 * password, phrases as Cashtab derives them, the wallet file; and, over
 * WebTransport from a regtest node, coins mined to a key, a payment seen
 * as peers relay it, a send between keys, a token coin kept apart, and an
 * imported key's coins found from its birth height. The last part needs
 * the optional @fails-components/webtransport.
 */

const assert = require('bsert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {Vault, phraseRing} = require('../browser/wallet/vault');
const {Coins} = require('../browser/wallet/coins');
const {buildPayment, sendPayment, parseAddress, parsePaymentURI}
  = require('../browser/wallet/send');
const KeyRing = require('../lib/primitives/keyring');
const MTX = require('../lib/primitives/mtx');
const Script = require('../lib/script/script');

// localStorage, in memory.
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

// Few PBKDF2 rounds: the tests are about what is sealed, not its cost.
const vault = (storage = new Storage()) =>
  new Vault({storage, iterations: 1000});

describe('Web wallet', function() {
  describe('vault', function() {
    const regtest = {network: 'regtest', height: 100};

    it('should seal keys with a password', async () => {
      const storage = new Storage();
      const v = vault(storage);

      await v.create('correct horse');
      const {address} = await v.newKey('spending', regtest);
      assert.strictEqual(v.active('regtest').name, 'spending');

      // Nothing readable without the password.
      const raw = storage.getItem('bcash-wallet');
      assert(!raw.includes(v.ring().getPrivateKey('hex')));
      assert(!raw.includes(address));

      const again = vault(storage);
      await assert.rejects(again.unlock('wrong horse'), /Wrong password/);
      await again.unlock('correct horse');
      const [key] = again.list('regtest');
      assert.strictEqual(key.name, 'spending');
      assert.strictEqual(key.address, address);
      assert.strictEqual(key.born, 100);
      assert(key.created > 0 && key.active);
    });

    it('should be one key on every network', async () => {
      const v = vault();
      await v.create('correct horse');
      await v.newKey('both', {network: 'testnet', height: 1737000});

      const [main] = v.list('main');
      const [test] = v.list('testnet');
      assert(main.address.startsWith('ecash:q'));
      assert(test.address.startsWith('ectest:q'));
      assert.strictEqual(parseAddress(main.address, 'main').getHash('hex'),
        parseAddress(test.address, 'testnet').getHash('hex'));

      // Born where it was made; elsewhere not yet known.
      assert.strictEqual(test.born, 1737000);
      assert.strictEqual(main.born, null);
      await v.setBorn('both', 'main', 949500);
      assert.strictEqual(v.list('main')[0].born, 949500);

      // Its WIF is the network's.
      const mainWif = (await v.reveal('both', 'correct horse', 'main')).wif;
      const testWif = (await v.reveal('both', 'correct horse',
        'testnet')).wif;
      assert.notStrictEqual(mainWif, testWif);
      assert.strictEqual(KeyRing.fromSecret(mainWif, 'main')
        .getPrivateKey('hex'), v.ring().getPrivateKey('hex'));
    });

    it('should derive a phrase\'s address as Cashtab does', async () => {
      const phrase = 'beauty shoe decline spend still weird slot snack'
        + ' coach flee between paper';
      assert.strictEqual(phraseRing(phrase).getAddress().toString('main'),
        'ecash:qqa9lv3kjd8vq7952p7rq0f6lkpqvlu0cydvxtd70g');

      const v = vault();
      await v.create('correct horse');
      const key = await v.importText(`  ${phrase.toUpperCase()}\n`,
        'cashtab', {network: 'main'});
      assert.strictEqual(key.address,
        'ecash:qqa9lv3kjd8vq7952p7rq0f6lkpqvlu0cydvxtd70g');

      await assert.rejects(v.importText('beauty shoe decline spend still'
        + ' weird slot snack coach flee between beauty', null,
      {network: 'main'}), /recovery phrase/);
    });

    it('should make phrases and keys, and take WIFs', async () => {
      const v = vault();
      await v.create('correct horse');

      const made = await v.newPhrase(null, {network: 'regtest', height: 7});
      assert.strictEqual(made.name, 'key1');
      assert.strictEqual(made.phrase.split(' ').length, 12);
      assert.strictEqual(phraseRing(made.phrase).getAddress()
        .toString('regtest'), made.address);

      // A WIF from any network.
      const ring = KeyRing.generate();
      const wif = ring.toSecret('testnet');
      const imported = await v.importText(wif, 'old', {network: 'regtest'});
      assert.strictEqual(imported.address,
        ring.getAddress().toString('regtest'));
      await assert.rejects(v.importText(ring.toSecret('main'), 'again',
        {network: 'regtest'}), /already in/);
      await assert.rejects(v.importText('not a key', null,
        {network: 'regtest'}), /Not a recovery/);

      // Secrets only with the password again.
      await assert.rejects(v.reveal('old', 'wrong horse', 'testnet'),
        /Wrong/);
      assert.strictEqual((await v.reveal('old', 'correct horse',
        'testnet')).wif, wif);
      assert.strictEqual((await v.reveal('key1', 'correct horse',
        'regtest')).phrase, made.phrase);
    });

    it('should move keys and birth heights in the wallet file', async () => {
      const a = vault();
      await a.create('file password');
      await a.newPhrase('first', {network: 'testnet', height: 1234});
      await a.newKey('second', {network: 'main', height: 2000});
      const file = a.exportFile();

      const b = vault();
      await b.create('other password');
      await b.newKey('first', {network: 'testnet', height: 3000});

      await assert.rejects(b.importFile(file, 'bad'), /Wrong password/);
      await assert.rejects(b.importFile('{}', 'x'), /Not a bcash wallet/);

      const added = await b.importFile(file, 'file password');
      assert.deepStrictEqual(added.map(k => k.name), ['first 2', 'second']);

      const born = network => Object.fromEntries(b.list(network)
        .map(k => [k.name, k.born]));
      assert.deepStrictEqual(born('testnet'),
        {'first': 3000, 'first 2': 1234, 'second': null});
      assert.deepStrictEqual(born('main'),
        {'first': null, 'first 2': null, 'second': 2000});

      // Again: nothing new.
      assert.deepStrictEqual(await b.importFile(file, 'file password'), []);
    });

    it('should take a wallet kept per network before', async () => {
      // As the first web wallet kept a testnet wallet: version 1, its
      // keys as WIFs, its state beside it.
      const storage = new Storage();
      const old = vault(storage);
      await old.create('correct horse');
      await old.newKey('kept', {network: 'testnet', height: 1737100});
      await old.saveState('testnet', {coins: {}, txs: {}, synced: 5});

      const ring = old.ring('kept');
      const {sealer} = old;
      const header = JSON.parse(storage.getItem('bcash-wallet'));
      storage.setItem('bcash-wallet-testnet', JSON.stringify({
        format: 'bcash-wallet',
        version: 1,
        network: 'testnet',
        salt: header.salt,
        iterations: header.iterations,
        keys: await sealer.seal({active: 'kept', keys: [{
          name: 'kept',
          type: 'wif',
          wif: ring.toSecret('testnet'),
          phrase: null,
          path: null,
          address: ring.getAddress().toString('testnet'),
          born: 1737100
        }]})
      }));
      storage.setItem('bcash-wallet-testnet-state',
        storage.getItem('bcash-wallet-state-testnet'));
      storage.removeItem('bcash-wallet');
      storage.removeItem('bcash-wallet-state-testnet');

      const v = vault(storage);
      assert(v.exists());
      await v.unlock('correct horse');
      const [key] = v.list('testnet');
      assert.strictEqual(key.address, ring.getAddress().toString('testnet'));
      assert.strictEqual(key.born, 1737100);
      assert.strictEqual((await v.loadState('testnet')).synced, 5);
      assert.strictEqual(storage.getItem('bcash-wallet-testnet'), null);
    });

    it('should read a payment code', () => {
      const address = KeyRing.generate().getAddress();
      const full = address.toString('main');
      assert.deepStrictEqual(parsePaymentURI(full, 'main'),
        {address: full, value: null});
      assert.deepStrictEqual(parsePaymentURI(full.split(':')[1], 'main'),
        {address: full, value: null});
      assert.deepStrictEqual(parsePaymentURI(`${full}?amount=12.3`, 'main'),
        {address: full, value: 1230});
      assert.throws(() => parsePaymentURI(`${full}?amount=1.234`, 'main'),
        /amount/);
      assert.throws(() => parsePaymentURI(address.toString('testnet'),
        'main'), /Not an address/);
    });
  });

  describe('coins', function() {
    this.timeout(90000);

    let addon = null;
    before(async function() {
      try {
        addon = await import('@fails-components/webtransport');
      } catch (e) {
        this.skip();
      }
    });

    it('should track, receive and send over WebTransport', async () => {
      const FullNode = require('../lib/node/fullnode');
      const SPVNode = require('../lib/node/spvnode');

      const base = 20000 + crypto.randomInt(0, 10000);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bcash-webwallet-'));
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
        for (let i = 0; i < 300 && !check(); i++)
          await new Promise(r => setTimeout(r, 100));
        assert(check(), `Timed out: ${what}`);
      };

      const rpc = async (method, ...params) => {
        const json = await full.rpc.call({method, params}, {});
        if (json.error)
          throw new Error(json.error.message);
        return json.result;
      };

      const others = KeyRing.generate();
      const otherAddress = others.getAddress().toString('regtest');
      const v = vault();
      let spv = null;

      try {
        await full.open();
        await full.connect();

        await v.create('correct horse');
        const a = await v.newKey('a', {network: 'regtest', height: 0});
        const b = await v.newKey('b', {network: 'regtest', height: 0});

        // A's coinbase, the other key's, then 100 to mature them.
        await rpc('generatetoaddress', 1, a.address);
        await rpc('generatetoaddress', 1, otherAddress);
        await rpc('generatetoaddress', 100,
          KeyRing.generate().getAddress().toString('regtest'));

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

        // Keys watched before the node syncs: nothing slips by.
        const coins = new Coins({vault: v, node: spv});
        await spv.open();
        await coins.open();
        await spv.connect();
        spv.startSync();

        await until(() => spv.chain.height === 102, 'sync');
        const subsidy = coins.balance(a.address).confirmed;
        assert(subsidy > 0);
        assert.strictEqual(coins.history(a.address).length, 1);

        // Paid by someone else: seen as peers relay it, no block.
        const prev = (await full.chain.getBlock(
          await full.chain.getHash(2))).txs[0];
        const pay = new MTX();
        pay.addCoin(await full.getCoin(prev.hash(), 0));
        pay.addOutput(parseAddress(a.address, 'regtest'), 2e8);
        pay.addOutput(others.getAddress(), prev.outputs[0].value - 2e8 - 1000);
        pay.sign(others);
        await full.sendTX(pay.toTX());

        await until(() => coins.balance(a.address).unconfirmed === 2e8,
          'relayed payment');
        assert.strictEqual(spv.chain.height, 102);

        // A pays B: both see it at once, unconfirmed.
        const {tx, fee} = await buildPayment({
          coins,
          ring: v.ring('a'),
          address: a.address,
          to: b.address.split(':')[1],
          value: 1e8
        });
        await sendPayment({coins, node: spv, tx});

        assert.strictEqual(coins.balance(b.address).unconfirmed, 1e8);
        assert.strictEqual(coins.balance(a.address).total,
          subsidy + 2e8 - 1e8 - fee);
        assert(fee > 0 && fee < 1000);

        // Mined: confirmed, for both.
        await until(() => full.mempool.has(tx.hash()), 'mempool');
        await rpc('generatetoaddress', 1, otherAddress);
        await until(() => coins.balance(b.address).confirmed === 1e8,
          'confirmed');
        assert.strictEqual(coins.balance(a.address).unconfirmed, 0);
        const history = coins.history(a.address);
        assert.deepStrictEqual(history.map(h => h.net),
          [-(1e8 + fee), 2e8, subsidy]);
        assert(history.every(h => h.height !== -1));

        // A token coin: kept apart, never spent as XEC.
        const token = new MTX();
        token.addInput({prevout: {hash: Buffer.alloc(32, 1), index: 0}});
        // OP_RETURN "SLP\0" 0x01 "SEND" <token id> <100>, every field
        // a data push.
        token.addOutput(Script.fromRaw(Buffer.from('6a04534c500001010453454e44'
          + '20' + '11'.repeat(32) + '080000000000000064', 'hex')), 0);
        token.addOutput(parseAddress(b.address, 'regtest'), 546);
        coins.addTX(token.toTX(), -1, null);
        assert.strictEqual(coins.balance(b.address).locked, 546);
        assert(coins.spendable(b.address).every(c => !c.token));
        const max = await buildPayment({coins, ring: v.ring('b'),
          address: b.address, to: otherAddress, max: true});
        assert(max.tx.inputs.every(i => i.prevout.txid()
          !== token.txid()));

        // A key imported with its birth height: what it was paid since
        // is found by a scan.
        const old = KeyRing.generate();
        const born = spv.chain.height;
        const back = new MTX();
        back.addCoin(await full.getCoin(pay.hash(), 1));
        back.addOutput(old.getAddress(), 5e7);
        back.addOutput(others.getAddress(),
          pay.outputs[1].value - 5e7 - 1000);
        back.sign(others);
        await full.sendTX(back.toTX());
        await until(() => full.mempool.has(back.hash()), 'mempool');
        await rpc('generatetoaddress', 1, otherAddress);
        await until(() => spv.chain.height === born + 1, 'block');

        const imported = await v.importText(old.toSecret('regtest'), 'old',
          {network: 'regtest', height: born});
        coins.watch(v.list('regtest').find(k => k.name === 'old'));
        assert.strictEqual(coins.balance(imported.address).total, 0);
        await coins.scan(born, [coins.keys.get(
          old.getKeyHash().toString('hex'))]);
        assert.strictEqual(coins.balance(imported.address).confirmed, 5e7);

        // Sealed: back from the vault after a reload.
        await coins.flush();
        const reloaded = new Coins({vault: v, node: spv});
        reloaded.state = await v.loadState('regtest');
        assert.strictEqual(reloaded.balance(b.address).confirmed, 1e8);
      } finally {
        if (spv)
          await spv.close();
        await full.close();
        fs.rmSync(dir, {recursive: true, force: true});
      }
    });
  });
});
