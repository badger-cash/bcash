/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * CPUMiner#findNonceAsync searches the nonce space in ranges on the worker
 * pool. It awaited each range before sending the next, so only one worker
 * ever hashed, however large the pool. It must keep one range in flight
 * per worker, cover the nonce space without gaps, and return the nonce a
 * worker finds.
 */

const assert = require('bsert');
const Chain = require('../lib/blockchain/chain');
const BlockStore = require('../lib/blockstore/level');
const Miner = require('../lib/mining/miner');
const CPUMiner = require('../lib/mining/cpuminer');
const KeyRing = require('../lib/primitives/keyring');
const Network = require('../lib/protocol/network');

const network = Network.get('regtest');
const interval = CPUMiner.INTERVAL;

// A worker pool that finds `answer` and records how ranges were searched.
function fakePool(size, enabled, answer) {
  return {
    size,
    enabled,
    inFlight: 0,
    peak: 0,
    ranges: [],
    async mine(data, target, min, max) {
      this.inFlight += 1;
      this.peak = Math.max(this.peak, this.inFlight);
      this.ranges.push([min, max]);
      await new Promise(resolve => setImmediate(resolve));
      this.inFlight -= 1;
      return answer >= min && answer <= max ? answer : -1;
    }
  };
}

describe('CPUMiner workers', function() {
  this.timeout(30000);

  const blocks = new BlockStore({network, memory: true});
  const chain = new Chain({network, memory: true, blocks});
  const miner = new Miner({chain});
  let job;

  before(async () => {
    await blocks.open();
    await chain.open();
    miner.addresses.push(KeyRing.generate().getAddress());
    job = await miner.cpu.createJob();
  });

  after(async () => {
    await chain.close();
    await blocks.close();
  });

  async function search(pool) {
    miner.cpu.workers = pool;
    return miner.cpu.findNonceAsync(job);
  }

  it('keeps one range in flight per worker', async () => {
    const answer = interval * 6 + 12345;
    const pool = fakePool(4, true, answer);

    assert.strictEqual(await search(pool), answer);
    assert.strictEqual(pool.peak, 4);
  });

  it('searches the ranges in order without gaps', async () => {
    const answer = interval * 6 + 12345;
    const pool = fakePool(4, true, answer);

    await search(pool);

    // Two rounds of four ranges; the answer is in the seventh.
    assert.strictEqual(pool.ranges.length, 8);
    pool.ranges.forEach(([min, max], i) => {
      assert.strictEqual(min, i * interval);
      assert.strictEqual(max, (i + 1) * interval);
    });
  });

  it('returns -1 when the whole nonce space is exhausted', async () => {
    const pool = fakePool(8, true, -2);

    assert.strictEqual(await search(pool), -1);
    const [, last] = pool.ranges[pool.ranges.length - 1];
    assert(last <= 0xffffffff);
    assert(last + interval > 0xffffffff);
  });

  it('sends one range at a time to a disabled pool', async () => {
    const answer = interval * 2 + 1;
    const pool = fakePool(8, false, answer);

    assert.strictEqual(await search(pool), answer);
    assert.strictEqual(pool.peak, 1);
  });
});
