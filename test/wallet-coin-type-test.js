/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * The BIP44 coin type a wallet derives at. New mainnet wallets use 1899,
 * as Cashtab does. A wallet or account saved before bcash recorded its
 * coin type keeps mainnet's old 0, for its addresses and for the private
 * keys that sign for them.
 */

const assert = require('bsert');
const Network = require('../lib/protocol/network');
const WalletDB = require('../lib/wallet/walletdb');
const layout = require('../lib/wallet/layout').wdb;
const HD = require('../lib/hd/hd');

const network = Network.get('main');

const phrase = 'abandon abandon abandon abandon abandon abandon '
  + 'abandon abandon abandon abandon abandon about';

// The address and public key at m/44'/type'/account'/0/0.
function expected(type, account) {
  const mnemonic = new HD.Mnemonic(phrase);
  const key = HD.fromMnemonic(mnemonic)
    .deriveAccount(44, type, account)
    .derive(0)
    .derive(0);
  return key.publicKey;
}

async function firstKey(wallet, account) {
  const acct = await wallet.getAccount(account);
  const key = acct.deriveReceive(0);
  return key;
}

// Drop a record's last four bytes: its coin type, as an older bcash
// saved it.
async function stripCoinType(wdb, key) {
  const raw = await wdb.db.get(key);
  await wdb.db.put(key, raw.slice(0, raw.length - 4));
}

describe('Wallet coin type', function() {
  let wdb;

  beforeEach(async () => {
    wdb = new WalletDB({network, memory: true});
    await wdb.open();
  });

  afterEach(async () => {
    await wdb.close();
  });

  it('should derive new mainnet wallets at 1899', async () => {
    assert.strictEqual(network.keyPrefix.coinType, 1899);

    const wallet = await wdb.create({id: 'new', mnemonic: phrase});
    assert.strictEqual(wallet.coinType, 1899);

    const key = await firstKey(wallet, 0);
    assert.bufferEqual(key.publicKey, expected(1899, 0));

    const priv = await wallet.getPrivateKey(key.getAddress());
    assert.bufferEqual(priv.publicKey, expected(1899, 0));

    // Kept through a reload from the database.
    wdb.unregister(wallet);
    const loaded = await wdb.get('new');
    assert.strictEqual(loaded.coinType, 1899);
    const acct = await loaded.getAccount(0);
    assert.strictEqual(acct.coinType, 1899);
  });

  it('should keep 0 for a mainnet wallet saved without one', async () => {
    // Made as an older bcash made it: at coin type 0, with no coin type in
    // its records.
    network.keyPrefix.coinType = 0;
    let wallet;
    try {
      wallet = await wdb.create({id: 'old', mnemonic: phrase});
    } finally {
      network.keyPrefix.coinType = 1899;
    }

    await stripCoinType(wdb, layout.w.encode(wallet.wid));
    await stripCoinType(wdb, layout.a.encode(wallet.wid, 0));
    wdb.unregister(wallet);

    const loaded = await wdb.get('old');
    assert.strictEqual(loaded.coinType, 0);

    const acct = await loaded.getAccount(0);
    assert.strictEqual(acct.coinType, 0);

    const key = await firstKey(loaded, 0);
    assert.bufferEqual(key.publicKey, expected(0, 0));

    // The key that signs for it is the same one.
    const priv = await loaded.getPrivateKey(key.getAddress());
    assert(priv.privateKey);
    assert.bufferEqual(priv.publicKey, expected(0, 0));

    // A new account in it follows the wallet's coin type.
    await loaded.createAccount({name: 'second'});
    const second = await firstKey(loaded, 'second');
    assert.bufferEqual(second.publicKey, expected(0, 1));
  });

  it('should leave the other networks as they were', () => {
    assert.strictEqual(Network.get('testnet').keyPrefix.coinType, 1);
    assert.strictEqual(Network.get('regtest').keyPrefix.coinType, 1);
    for (const type of ['testnet', 'regtest', 'simnet']) {
      const net = Network.get(type);
      assert.strictEqual(
        require('../lib/wallet/common').legacyCoinType(net),
        net.keyPrefix.coinType);
    }
  });
});
