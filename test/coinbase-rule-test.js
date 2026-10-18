/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * From Axion until Wellington, eCash mainnet blocks had to pay a share of
 * the coinbase to the miner fund. Bitcoin ABC enforces that only where
 * enableMinerFund is set, which is mainnet. bcash enforced it on every
 * network, so once testnet had an Axion height it rejected testnet block
 * 1421482, the first Axion block, which pays no fund output.
 */

const assert = require('bsert');
const Chain = require('../lib/blockchain/chain');
const BlockStore = require('../lib/blockstore/level');
const Miner = require('../lib/mining/miner');
const KeyRing = require('../lib/primitives/keyring');
const Network = require('../lib/protocol/network');

const regtest = Network.get('regtest');

describe('Coinbase rule', function() {
  this.timeout(30000);

  it('is enforced on mainnet only, as in Bitcoin ABC', () => {
    assert.strictEqual(Network.get('main').block.coinbaseRule, true);
    assert.strictEqual(Network.get('testnet').block.coinbaseRule, false);
    assert.strictEqual(regtest.block.coinbaseRule, false);
    assert.strictEqual(Network.get('simnet').block.coinbaseRule, false);
  });

  describe('between Axion and Wellington', function() {
    const keys = ['axionHeight', 'wellingtonActivationTime', 'coinbaseRule'];
    let saved;

    before(() => {
      saved = keys.map(key => [key, key in regtest.block, regtest.block[key]]);
      regtest.block.axionHeight = 0;
      regtest.block.wellingtonActivationTime = Infinity;
    });

    // Regtest has no Axion or Wellington of its own: put back exactly
    // what was there so later tests in the same run are unaffected.
    after(() => {
      for (const [key, had, value] of saved) {
        if (had)
          regtest.block[key] = value;
        else
          delete regtest.block[key];
      }
    });

    // Mine one block whose coinbase pays only the miner.
    async function mineOne() {
      const blocks = new BlockStore({network: regtest, memory: true});
      const chain = new Chain({network: regtest, memory: true, blocks});
      const miner = new Miner({chain});
      await blocks.open();
      await chain.open();
      try {
        const address = KeyRing.generate().getAddress();
        const job = await miner.cpu.createJob(null, address);
        return await chain.add(await job.mineAsync());
      } finally {
        await chain.close();
        await blocks.close();
      }
    }

    it('accepts a block without a fund output where it is off', async () => {
      regtest.block.coinbaseRule = false;
      assert(await mineOne());
    });

    it('rejects a block without a fund output where it is on', async () => {
      regtest.block.coinbaseRule = true;
      await assert.rejects(mineOne(), {reason: 'missing-coinbase-rule-amount'});
    });
  });
});
