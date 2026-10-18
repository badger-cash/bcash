/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * From Axion, eCash blocks had to pay a share of the coinbase to the miner
 * fund. Bitcoin ABC made that a block parking policy at Wellington, then
 * removed the consensus rule altogether (D14032), "so that it look like
 * the consensus rules were never enforced". No height has a consensus
 * miner fund rule now, so a block whose coinbase pays only the miner is
 * valid between Axion and Wellington too, on every network.
 */

const assert = require('bsert');
const Chain = require('../lib/blockchain/chain');
const BlockStore = require('../lib/blockstore/level');
const Miner = require('../lib/mining/miner');
const KeyRing = require('../lib/primitives/keyring');
const Network = require('../lib/protocol/network');

const regtest = Network.get('regtest');

describe('Miner fund', function() {
  this.timeout(30000);

  // Regtest has no Axion or Wellington of its own. coinbaseRule was the
  // per-network switch for the old consensus rule; setting it shows the
  // rule is gone, not merely switched off.
  const keys = ['axionHeight', 'wellingtonActivationTime', 'coinbaseRule'];
  let saved;

  before(() => {
    saved = keys.map(key => [key, key in regtest.block, regtest.block[key]]);
    regtest.block.axionHeight = 0;
    regtest.block.wellingtonActivationTime = Infinity;
    regtest.block.coinbaseRule = true;
  });

  // Put back exactly what was there so later tests in the same run are
  // unaffected.
  after(() => {
    for (const [key, had, value] of saved) {
      if (had)
        regtest.block[key] = value;
      else
        delete regtest.block[key];
    }
  });

  it('is not a consensus rule between Axion and Wellington', async () => {
    const blocks = new BlockStore({network: regtest, memory: true});
    const chain = new Chain({network: regtest, memory: true, blocks});
    const miner = new Miner({chain});
    await blocks.open();
    await chain.open();
    try {
      const address = KeyRing.generate().getAddress();
      const job = await miner.cpu.createJob(null, address);
      const block = await job.mineAsync();

      // The coinbase pays the miner and nothing else.
      assert.strictEqual(block.txs[0].outputs.length, 1);
      assert(await chain.add(block));
    } finally {
      await chain.close();
      await blocks.close();
    }
  });
});
