/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * The web wallet's sends that never reached the network: a send with no
 * node connected fails and leaves the wallet as it was; a send no node has
 * is marked, and can be cancelled, its coins coming back (and anything
 * spent from it undone).
 */

const assert = require('bsert');
const {Vault} = require('../browser/wallet/vault');
const {Coins} = require('../browser/wallet/coins');
const {sendPayment, resendPayment} = require('../browser/wallet/send');
const KeyRing = require('../lib/primitives/keyring');
const MTX = require('../lib/primitives/mtx');
const Coin = require('../lib/primitives/coin');

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

// A node with no peers: enough for the coins, nothing to send to.
function offline() {
  return {
    network: {type: 'regtest'},
    chain: {height: 10, options: {}},
    pool: {
      peers: {head: () => null},
      watch() {},
      watchOutpoint() {}
    },
    on() {},
    removeAllListeners() {}
  };
}

describe('Web wallet sends', function() {
  let coins, ring, address;

  beforeEach(async () => {
    const vault = new Vault({storage: new Storage(), iterations: 1000});
    await vault.create('correct horse');
    ({address} = await vault.newKey('a', {network: 'regtest', height: 0}));
    ring = vault.ring('a');
    coins = new Coins({vault, node: offline()});
    await coins.open();
  });

  afterEach(async () => {
    await coins.flush();
  });

  // A confirmed coin of 1e8 for the key, and a payment spending it.
  function fund() {
    const funding = new MTX();
    funding.addInput({prevout: {hash: Buffer.alloc(32, 1), index: 0}});
    funding.addOutput(ring.getAddress(), 1e8);
    const tx = funding.toTX();
    coins.addTX(tx, 5, 1700000000);
    return tx;
  }

  function spend(parent, vout, value) {
    const mtx = new MTX();
    mtx.addCoin(Coin.fromTX(parent, vout, -1));
    mtx.addOutput(KeyRing.generate().getAddress(), value);
    mtx.addOutput(ring.getAddress(),
      parent.outputs[vout].value - value - 500);
    mtx.sign(ring);
    return mtx.toTX();
  }

  it('should send nothing, and keep nothing, with no node', async () => {
    const funding = fund();
    const tx = spend(funding, 0, 1e7);

    await assert.rejects(sendPayment({coins, node: coins.node, tx}),
      /Not connected to a node: nothing was sent/);

    assert.strictEqual(coins.state.txs[tx.txid()], undefined);
    assert.strictEqual(coins.balance(address).confirmed, 1e8);
    assert.strictEqual(coins.pending().length, 0);

    await assert.rejects(resendPayment({coins, node: coins.node,
      raw: tx.toRaw().toString('hex')}), /Not connected/);
  });

  it('should mark a send no node has, and cancel it', async () => {
    const funding = fund();

    // Sent while the wallet thought it was: kept, with its raw form.
    const first = spend(funding, 0, 1e7);
    coins.addSent(first);
    // And a second, spending the first's change.
    const second = spend(first, 1, 1e6);
    coins.addSent(second);

    assert.deepStrictEqual(coins.pending().map(tx => tx.txid).sort(),
      [first.txid(), second.txid()].sort());
    assert.strictEqual(coins.history(address)
      .find(tx => tx.txid === first.txid()).raw,
    first.toRaw().toString('hex'));
    assert.strictEqual(coins.balance(address).confirmed, 0);

    // No node had it; then a peer relayed it: sent after all.
    coins.setUnsent(first.txid(), true);
    assert(coins.history(address)
      .find(tx => tx.txid === first.txid()).unsent);
    coins.addTX(first, -1, null);
    assert(!coins.history(address)
      .find(tx => tx.txid === first.txid()).unsent);

    // Cancelled: both gone, the funding coin spendable again.
    coins.setUnsent(first.txid(), true);
    assert(coins.removeTX(first.txid()));

    assert.strictEqual(coins.state.txs[first.txid()], undefined);
    assert.strictEqual(coins.state.txs[second.txid()], undefined);
    assert.strictEqual(coins.pending().length, 0);
    // Only the funding's own spend is still remembered.
    assert.deepStrictEqual(Object.values(coins.state.spends),
      [funding.txid()]);
    assert.deepStrictEqual(coins.unspent(address).map(c => c.txid),
      [funding.txid()]);
    assert.strictEqual(coins.balance(address).confirmed, 1e8);
    assert.deepStrictEqual(coins.history(address).map(tx => tx.txid),
      [funding.txid()]);
  });

  it('should not cancel a transaction in a block', () => {
    const funding = fund();
    assert.throws(() => coins.removeTX(funding.txid()),
      /in a block cannot be cancelled/);
    assert.strictEqual(coins.removeTX('00'.repeat(32)), false);
  });
});
