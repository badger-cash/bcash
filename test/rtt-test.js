/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * A port of Bitcoin ABC's check_rtt_next_work_required, in
 * src/test/rtt_tests.cpp.
 */

const assert = require('bsert');
const os = require('os');
const path = require('path');
const fs = require('bfile');
const consensus = require('../lib/protocol/consensus');
const Network = require('../lib/protocol/network');
const {getNextRTTWorkRequired} = require('../lib/mining/rtt');
const FullNode = require('../lib/node/fullnode');
const KeyRing = require('../lib/primitives/keyring');
const secp256k1 = require('bcrypto/lib/secp256k1');

const network = Network.get('main');
const powLimit = network.pow.limit;

// lhs's target is lower (harder) than rhs's.
function targetLt(lhs, rhs) {
  return consensus.fromCompact(lhs).lt(consensus.fromCompact(rhs));
}

describe('RTT', function() {
  const now = 1700000000;
  const prevBits = consensus.toCompact(powLimit.ushrn(10));

  // The 17 blocks up to the previous one, received long enough ago not to
  // count: prev's time first.
  let received;

  beforeEach(() => {
    received = new Array(17).fill(now - 18000);
  });

  const next = (t, bits = prevBits) =>
    getNextRTTWorkRequired(received, t, bits, powLimit);

  it('should not apply to a block read from disk', () => {
    for (let i = 0; i < 17; i++) {
      const prev = received[i];
      received[i] = 0;
      assert.strictEqual(next(now), null);
      received[i] = prev;
    }
    assert.strictEqual(next(0), null);
  });

  it('should clamp a time difference to a second', () => {
    received[0] = now;
    const zero = next(now);
    assert.strictEqual(next(now - 100), zero);
    assert.strictEqual(next(now + 1), zero);

    // Harder than the DAA's.
    assert(targetLt(zero, prevBits));
  });

  it('should ease each second, wherever the clock is', () => {
    received[0] = now;
    let prev = next(now);

    for (let t = 2; t < 3600; t++) {
      const work = next(now + t);

      // The same at any offset.
      for (const offset of [183 * 86400, 366 * 86400, 10 * 366 * 86400]) {
        const shifted = received.map(r => r + offset);
        assert.strictEqual(getNextRTTWorkRequired(shifted, now + offset + t,
          prevBits, powLimit), work);
      }

      assert(targetLt(prev, work));
      prev = work;
    }
  });

  it('should never be easier than the pow limit', () => {
    received[0] = now;
    const limitBits = consensus.toCompact(powLimit);

    // The 114s/115s values are specific to RTT_K = 6.
    for (const t of [-1, 0, 1, 10, 100, 114]) {
      const work = next(now + t, limitBits);
      assert(work != null);
      assert(targetLt(work, limitBits));
    }

    for (const t of [115, 600, 1000, 3600, 86400, 365 * 86400])
      assert.strictEqual(next(now + t, limitBits), null);
  });

  // Received times from block spacings, most recent first.
  function spaced(difftimes) {
    let cumulated = 0;
    for (let i = 0; i < difftimes.length; i++) {
      cumulated += difftimes[i];
      received[i] = now - cumulated;
    }
    return next(now);
  }

  const evenly = s => new Array(17).fill(s);

  // [spacings, whether RTT is harder than the DAA]
  const cases = [
    // Evenly spaced, 10 minutes apart.
    [evenly(600), false],
    // The 1 block window: the DAA crossing point is at 115s.
    [[114, ...evenly(600).slice(1)], true],
    [[115, ...evenly(600).slice(1)], false],
    // The 2 block window: 459s.
    [[458, 0, ...evenly(600).slice(2)], true],
    [[459, 0, ...evenly(600).slice(2)], false],
    // The 5 block window: 1836s.
    [[600, 600, 600, 35, 0, ...evenly(600).slice(5)], true],
    [[600, 600, 600, 36, 0, ...evenly(600).slice(5)], false],
    // The 11 block window: 4588s.
    [[600, 600, 600, 600, 600, 600, 600, 387, 0, 0, 0,
      ...evenly(600).slice(11)], true],
    [[600, 600, 600, 600, 600, 600, 600, 388, 0, 0, 0,
      ...evenly(600).slice(11)], false],
    // The 17 block window: 7341s.
    [[...evenly(600).slice(5), 140, 0, 0, 0, 0], true],
    [[...evenly(600).slice(5), 141, 0, 0, 0, 0], false],
    // Faster than the 10 minutes expected, but not enough to matter...
    [evenly(540), false],
    [evenly(480), false],
    // ...until 7 minutes.
    [evenly(420), true]
  ];

  it('should match Bitcoin ABC at the crossing points', () => {
    for (const [difftimes, harder] of cases) {
      const work = spaced(difftimes);
      assert(work != null);
      assert.strictEqual(targetLt(work, prevBits), harder,
        `spacings ${difftimes.join(',')}`);
    }
  });

  it('should ease from 7 minute blocks, past the DAA at 201s', () => {
    let work = spaced(evenly(420));

    for (let t = 1; t < 300; t++) {
      const last = work;
      work = next(now + t);
      assert(work != null);
      assert.strictEqual(targetLt(work, prevBits), t < 201, `t=${t}`);
      assert(targetLt(last, work));
    }
  });
});

// Bitcoin ABC's rtt_policy, and the miner's and getblocktemplate's use of
// RTT, on a regtest node.
describe('RTT on a node', function() {
  this.timeout(30000);

  const node = new FullNode({
    network: 'regtest',
    memory: true,
    workers: false,
    listen: false,
    apiKey: 'foo',
    httpPort: 49455,
    port: 49454,
    avalanche: true
  });

  const address = KeyRing.fromPrivate(secp256k1.privateKeyGenerate())
    .getAddress();

  const {chain, miner} = node;
  const now = () => node.network.now();

  // A block received an hour ago: RTT needs no more than its bits after.
  const received = (entry, ago) => chain.receivedTimes.set(entry.hash,
    now() - ago);

  // A block meeting its bits, mined without regard to RTT.
  async function mineTooSoon() {
    const job = await miner.cpu.createJob(chain.tip, address);
    job.attempt.rttBits = null;
    return miner.cpu.mineAsync(job);
  }

  before(async () => {
    await node.open();

    // 18 blocks, each received an hour before the next.
    for (let i = 0; i < 18; i++) {
      const block = await miner.mineBlock(chain.tip, address);
      assert(await chain.add(block));
      received(chain.tip, 3600 * (18 - i));
    }
  });

  after(async () => {
    await node.close();
  });

  it('should save and load when the last blocks were received', async () => {
    // 20 blocks to save; with fewer, as Bitcoin ABC, none are.
    assert(!await chain.dumpRecentHeadersTime('/nonexistent/file'));
    for (let i = 0; i < 2; i++) {
      const block = await miner.mineBlock(chain.tip, address);
      assert(await chain.add(block));
      received(chain.tip, 3600 * (2 - i) - 1800);
    }

    const file = path.join(os.tmpdir(), `bcash-headerstime-${process.pid}`);
    const saved = new Map([...chain.receivedTimes]);

    try {
      assert(await chain.dumpRecentHeadersTime(file));
      chain.receivedTimes.clear();
      assert(await chain.loadRecentHeadersTime(file));

      let entry = chain.tip;
      for (let i = 0; i < 18; i++) {
        assert.strictEqual(chain.getReceivedTime(entry.hash),
          saved.get(entry.hash));
        entry = await chain.getPrevious(entry);
      }

      // A file for another chain: none of it applies.
      const data = await fs.readFile(file);
      data.fill(1, 8, 40);
      await fs.writeFile(file, data);
      chain.receivedTimes.clear();
      assert(!await chain.loadRecentHeadersTime(file));
      assert.strictEqual(chain.receivedTimes.size, 0);
    } finally {
      for (const [hash, time] of saved)
        chain.receivedTimes.set(hash, time);
      await fs.unlink(file).catch(() => {});
    }
  });

  it('should need no more than the bits an hour on', async () => {
    const tip = chain.tip;
    assert.strictEqual(await node.getRTTBits(tip, tip.time, now()), null);
  });

  it('should need more just after a block, and tell miners', async () => {
    const tip = chain.tip;
    received(tip, 0);

    const bits = await node.getRTTBits(tip, tip.time, now());
    assert(bits != null);
    assert(targetLt(bits, tip.bits));

    // The miner aims for it once polls finalized a block since starting,
    // its header keeps the bits, and getblocktemplate says so, as
    // Bitcoin ABC.
    assert.strictEqual((await miner.createBlock(tip, address)).rttBits,
      null);
    node.pool.avalanche.finalizedSinceStart = true;
    const attempt = await miner.createBlock(tip, address);
    assert.strictEqual(attempt.rttBits, bits);
    assert.strictEqual(attempt.bits, tip.bits);

    const json = await node.rpc.call({
      method: 'getblocktemplate',
      params: []
    }, {});
    assert.strictEqual(json.error, null);

    const {rtt} = json.result;
    assert.strictEqual(rtt.prevbits, tip.bits.toString(16).padStart(8, '0'));
    assert(targetLt(parseInt(rtt.nexttarget, 16), tip.bits));
    assert.strictEqual(rtt.prevheadertime.length, 5);
    assert.strictEqual(rtt.prevheadertime[0], chain.getReceivedTime(tip.hash));

    node.pool.avalanche.finalizedSinceStart = false;
  });

  it('should take a block mined too soon before any is final', async () => {
    received(chain.tip, 0);
    const block = await mineTooSoon();
    assert(await chain.add(block));
    assert(chain.tip.hash.equals(block.hash()));
  });

  // As Bitcoin ABC: the chain's finalized tip is kept across restarts,
  // but a node catching up after one receives blocks moments apart.
  it('should take one mined too soon after a restart', async () => {
    assert(await chain.finalize(chain.tip));
    assert(!node.pool.avalanche.hasFinalizedTip());

    received(chain.tip, 0);
    const block = await mineTooSoon();
    assert(await chain.add(block));
    assert(chain.tip.hash.equals(block.hash()));
  });

  it('should park a block mined too soon once one is final', async () => {
    const tip = chain.tip;
    assert(await chain.finalize(tip));
    // As polls finalizing a block would.
    node.pool.avalanche.finalizedSinceStart = true;
    received(tip, 0);

    const block = await mineTooSoon();
    const bits = await node.getRTTBits(tip, block.time,
      chain.getReceivedTime(block.hash()) || now());
    assert(!consensus.verifyPOW(block.hash(), bits));

    await chain.add(block);
    assert(chain.tip.hash.equals(tip.hash));
    assert(chain.isParked(block.hash()));
  });

  it('should take one mined to RTT\'s target', async () => {
    // Long enough after all 17 blocks before it, as most blocks are.
    let entry = chain.tip;
    for (let i = 0; i < 17; i++) {
      received(entry, 3600 * (i + 1));
      entry = await chain.getPrevious(entry);
    }

    const block = await miner.mineBlock(chain.tip, address);
    assert(await chain.add(block));
    assert(chain.tip.hash.equals(block.hash()));
  });
});
