/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * Testnet consensus parameters, checked against Bitcoin ABC (the eCash
 * reference implementation) and against real testnet headers.
 *
 * bcash tests the height of the block being validated (`height >= X`), where
 * ABC tests the height of its parent (`pindexPrev->nHeight >= X`), so a bcash
 * activation height is ABC's plus one wherever bcash uses `>=`.
 */

const assert = require('bsert');
const Chain = require('../lib/blockchain/chain');
const Block = require('../lib/primitives/block');
const Network = require('../lib/protocol/network');
const common = require('../lib/blockchain/common');
const networks = require('../lib/protocol/networks');
const fixtures = require('./data/testnet-asert-headers');

const testnet = Network.get('testnet');

const toBlock = hex => Block.fromRaw(Buffer.concat([Buffer.from(hex, 'hex'),
  Buffer.from([0])]));
const rhash = buf => Buffer.from(buf).reverse().toString('hex');

/**
 * Anchor an SPV testnet chain on a window's first 12 headers.
 * @param {Object} window - {start, headers}.
 * @returns {Promise} - Returns {@link Chain}.
 */
async function openAnchored(window) {
  const chain = new Chain({
    network: testnet, memory: true, spv: true,
    anchor: {
      height: window.start,
      headers: window.headers.slice(0, 12).map(([, h]) => Buffer.from(h, 'hex'))
    }
  });
  await chain.open();
  return chain;
}

/**
 * Add the rest of a window's headers.
 * @param {Chain} chain - From openAnchored.
 * @param {Object} window - {start, headers}.
 * @returns {Promise} - Returns the first failure, if any.
 */
async function addRest(chain, window) {
  for (let i = 12; i < window.headers.length; i++) {
    const [hash, header] = window.headers[i];
    const entry = await chain.add(toBlock(header), common.flags.VERIFY_POW);
    assert(entry, `header ${window.start + i} not connected`);
    assert.strictEqual(entry.rhash(), hash);
    assert.strictEqual(entry.height, window.start + i);
  }
}

describe('Testnet parameters', function() {
  this.timeout(60000);

  describe('as in Bitcoin ABC', function() {
    it('uses the Bitcoin ABC testnet seeders', () => {
      assert.deepStrictEqual(networks.testnet.seeds, [
        'testnet-seed.bitcoinabc.org',
        'testnet-seeder.fabien.cash',
        'testnet-seeder.status.cash'
      ]);
    });

    it('keeps the network identity', () => {
      assert.strictEqual(networks.testnet.port, 18333);
      // Serialized little endian: f4 e5 f3 f4, as netMagic in ABC.
      assert.strictEqual(networks.testnet.magic, 0xf4f3e5f4);
      assert.strictEqual(rhash(networks.testnet.genesis.hash),
        '000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943');
    });

    it('carries the ABC activation checkpoints', () => {
      const map = networks.testnet.checkpointMap;
      const expect = {
        1421481: '00000000062c7f32591d883c99fc89ebe74a83287c0f2b7ffeef72e6221' +
          '7d40b',
        1450540: '00000000001085419e7328a2bacaf6216dd913c400f0b7da4bde43a8ebf' +
          '6ed4e',
        1477500: '000000000004057554e6f83253e3080774c37ae8a940ffbc38d77525274' +
          '709ae',
        1503557: '00000000000dbd764814fb67b5ff5aab606faa1f5881dc86f57639a1396' +
          'e11ba'
      };
      for (const [height, hash] of Object.entries(expect))
        assert.strictEqual(rhash(map[height]), hash, `checkpoint ${height}`);
      assert(map[1713793], 'Obolensky activation checkpoint');
      // Activation checkpoints extend past lastCheckpoint, as on mainnet.
      assert.strictEqual(networks.testnet.lastCheckpoint, 1341712);
    });

    it('activates each upgrade at ABC height + 1', () => {
      const abc = {
        magneticAnomalyHeight: 1267996,
        gravitonHeight: 1341711,
        phononHeight: 1378460,
        axionHeight: 1421481
      };
      for (const [key, height] of Object.entries(abc))
        assert.strictEqual(networks.testnet.block[key], height + 1, key);
    });

    it('uses ABC activation times for the MTP-activated upgrades', () => {
      const block = networks.testnet.block;
      assert.strictEqual(block.asertActivationTime, 1605441600);
      assert.strictEqual(block.wellingtonActivationTime, 1684152000);
      assert.strictEqual(block.cowperthwaiteActivationTime, 1700049600);
      assert.strictEqual(block.shibusawaActivationTime, 1763208000);
    });

    it('anchors ASERT where ABC does on each network', () => {
      assert.deepStrictEqual(networks.testnet.pow.asertAnchor,
        {height: 1421481, bits: 0x1d00ffff, prevTime: 1605445400});
      // The values calculateASERT has always hardcoded.
      assert.deepStrictEqual(networks.main.pow.asertAnchor,
        {height: 661647, bits: 0x1804dafe, prevTime: 1605447844});
    });
  });

  describe('real testnet headers', function() {
    it('validates the first ASERT blocks, which clamp to the pow limit',
      async () => {
      const chain = await openAnchored(fixtures.asert);
      const anchor = chain.tip;
      assert.strictEqual(anchor.height, 1421481);
      const first = toBlock(fixtures.asert.headers[12][1]);
      assert.strictEqual(await chain.getTarget(first.time, anchor),
        testnet.pow.bits);
      await addRest(chain, fixtures.asert);
      await chain.close();
    });

    it('validates blocks mined under the 20 minute rule', async () => {
      const chain = await openAnchored(fixtures.twentyMinute);
      await addRest(chain, fixtures.twentyMinute);
      await chain.close();
    });

    it('rejects the first ASERT block if the mainnet anchor is used',
      async () => {
      const saved = testnet.pow.asertAnchor;
      delete testnet.pow.asertAnchor;
      try {
        const chain = await openAnchored(fixtures.asert);
        const block = toBlock(fixtures.asert.headers[12][1]);
        await assert.rejects(chain.add(block, common.flags.VERIFY_POW),
          /bad-diffbits/);
        await chain.close();
      } finally {
        testnet.pow.asertAnchor = saved;
      }
    });
  });
});
