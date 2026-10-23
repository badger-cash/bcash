/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * Peer discovery on a fresh start follows Bitcoin ABC: query the DNS seeds
 * first, and fall back to the fixed seeds only if DNS yields nothing. bcash
 * used to fill an empty address table from the fixed seeds, which made the
 * pool skip DNS entirely and dial a years-old list of addresses.
 */

const assert = require('bsert');
const Chain = require('../lib/blockchain/chain');
const Pool = require('../lib/net/pool');
const Network = require('../lib/protocol/network');
const networks = require('../lib/protocol/networks');
const seeds = require('../lib/net/seeds');
const NetAddress = require('../lib/net/netaddress');

async function freshPool(type, resolve) {
  const network = Network.get(type);
  const chain = new Chain({network, memory: true, spv: true});
  await chain.open();
  const pool = new Pool({network, chain, spv: true, memory: true, listen: false});
  pool.hosts.resolve = resolve;
  // Record refills instead of dialling anyone.
  pool.refills = 0;
  pool.refill = () => {
 pool.refills++;
};
  await pool.hosts.open();
  return {chain, pool};
}

describe('Pool seeds', function() {
  it('uses the Bitcoin ABC DNS seeders on mainnet', () => {
    assert.deepStrictEqual(networks.main.seeds, [
      'seed.bitcoinabc.org',
      'seeder.fabien.cash',
      'seeder.status.cash'
    ]);
  });

  it('ships Bitcoin ABC fixed seeds for mainnet and testnet', () => {
    assert(seeds.get('main').length > 50);
    assert(seeds.get('main').includes('3.136.102.242:8333'));
    assert(seeds.get('testnet').length > 0);
  });

  for (const type of ['main', 'testnet']) {
    describe(type, function() {
      it('does not fill an empty table from the fixed seeds', async () => {
        const {chain, pool} = await freshPool(type, async () => []);
        assert.strictEqual(pool.hosts.size(), 0);
        await chain.close();
      });

      it('fills it from the DNS seeds when the pool connects', async () => {
        const answers = ['203.0.113.10', '203.0.113.11', '203.0.113.12'];
        const asked = [];
        const {chain, pool} = await freshPool(type, async (host) => {
          asked.push(host);
          return answers;
        });

        await pool.discoverSeeds();

        assert.deepStrictEqual(asked.sort(), [...networks[type].seeds].sort());
        assert.strictEqual(pool.hosts.size(), answers.length);
        for (const ip of answers)
          assert(pool.hosts.map.has(`${ip}:${networks[type].port}`), ip);
        assert.strictEqual(pool.refills, 1);
        await chain.close();
      });

      it('dials the DNS seed results before gossiped addresses, each once', async () => {
        const network = Network.get(type);
        const answers = ['203.0.113.20', '203.0.113.21', '203.0.113.22'];
        const {chain, pool} = await freshPool(type, async () => answers);
        await pool.discoverSeeds();

        // A first peer floods the table with gossip.
        for (let i = 0; i < 300; i++) {
          const ip = `198.51.${100 + (i >> 8)}.${i & 0xff}`;
          pool.hosts.add(NetAddress.fromHost(ip, network.port, network));
        }

        // Each seeder is asked; every one answers with the same three hosts,
        // which the table holds once but the queue offers once per answer.
        const offered = [];
        while (pool.hosts.seedQueue.length > 0) {
          const addr = pool.getHost();
          offered.push(addr.host);
        }

        assert.deepStrictEqual([...new Set(offered)].sort(), [...answers].sort());
        for (const host of offered)
          assert(answers.includes(host), `gossip ${host} dialled before a seed result`);

        // After the queue, the pool picks from the table as before.
        assert(pool.getHost());
        await chain.close();
      });

      it('skips a banned DNS seed result', async () => {
        const {chain, pool} = await freshPool(type, async () => ['203.0.113.30', '203.0.113.31']);
        await pool.discoverSeeds();
        pool.hosts.ban('203.0.113.30');

        const first = pool.getHost();
        assert.strictEqual(first.host, '203.0.113.31');
        await chain.close();
      });

      it('falls back to the fixed seeds if DNS returns nothing', async () => {
        const {chain, pool} = await freshPool(type, async () => {
          throw new Error('no network');
        });

        await pool.discoverSeeds();

        assert(pool.hosts.size() > 0);
        assert(pool.hosts.size() <= seeds.get(type).length);
        await chain.close();
      });
    });
  }
});
