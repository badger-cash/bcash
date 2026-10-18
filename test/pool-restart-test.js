/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * A restart dials the peers that last answered before anything else in the
 * saved address table, which is mostly gossip. It used to pick from the
 * table at random, so a warm start could take longer than a cold one.
 */

const assert = require('bsert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Chain = require('../lib/blockchain/chain');
const Pool = require('../lib/net/pool');
const Network = require('../lib/protocol/network');
const NetAddress = require('../lib/net/netaddress');

const network = Network.get('testnet');

describe('Pool restart', function() {
  let prefix, chain, offset;

  beforeEach(async () => {
    offset = network.time.offset;
    prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'bcash-restart-'));
    chain = new Chain({network, memory: true, spv: true});
    await chain.open();
  });

  afterEach(async () => {
    network.time.offset = offset;
    await chain.close();
    fs.rmSync(prefix, {recursive: true, force: true});
  });

  const poolAt = async (resolve = async () => []) => {
    const pool = new Pool({
      network, chain, spv: true, memory: false, prefix, listen: false
    });
    pool.hosts.resolve = resolve;
    pool.refill = () => {};
    await pool.hosts.open();
    pool.restoreKnownGood();
    return pool;
  };

  // A first run: gossip fills the table; two hosts answered, b after a.
  const firstRun = async () => {
    const pool = await poolAt();
    for (let i = 0; i < 200; i++) {
      const ip = `198.51.${100 + (i >> 8)}.${i & 0xff}`;
      pool.hosts.add(NetAddress.fromHost(ip, network.port, network));
    }
    for (const ip of ['203.0.113.1', '203.0.113.2']) {
      pool.hosts.add(NetAddress.fromHost(ip, network.port, network));
      pool.hosts.markAck(`${ip}:${network.port}`, 0);
      network.time.offset += 10;
    }
    await pool.hosts.close();
  };

  it('dials the hosts that last answered first, newest first', async () => {
    await firstRun();
    const pool = await poolAt();

    assert.strictEqual(pool.getHost().host, '203.0.113.2');
    assert.strictEqual(pool.getHost().host, '203.0.113.1');
    // Then the table as before.
    assert(pool.getHost());
    await pool.hosts.close();
  });

  it('does not wait out a recent attempt on a host that answered', async () => {
    await firstRun();
    const pool = await poolAt();
    pool.hosts.markAttempt(`203.0.113.2:${network.port}`);
    assert.strictEqual(pool.getHost().host, '203.0.113.2');
    await pool.hosts.close();
  });

  it('asks the DNS seeds when no saved host ever answered', async () => {
    const pool = await poolAt();
    for (let i = 0; i < 50; i++)
      pool.hosts.add(
        NetAddress.fromHost(`198.51.100.${i}`, network.port, network));
    await pool.hosts.close();

    const asked = [];
    const restarted = await poolAt(async (host) => {
      asked.push(host);
      return ['203.0.113.50'];
    });
    await restarted.discoverSeeds();

    assert.strictEqual(asked.length, network.seeds.length);
    assert.strictEqual(restarted.getHost().host, '203.0.113.50');
    await restarted.hosts.close();
  });

  it('skips the DNS seeds when a saved host answered before', async () => {
    await firstRun();
    let asked = 0;
    const pool = await poolAt(async () => {
      asked += 1;
      return [];
    });
    await pool.discoverSeeds();
    assert.strictEqual(asked, 0);
    await pool.hosts.close();
  });
});
