/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * A port of Bitcoin ABC's select_staking_reward_winner test, from
 * src/avalanche/test/peermanager_tests.cpp.
 */

const assert = require('bsert');
const random = require('bcrypto/lib/random');
const PeerManager = require('../lib/avalanche/peermanager');
const ChainStakeVerifier = require('../lib/avalanche/stakeverifier');
const {
  selectWinners,
  rewardRank,
  uint256ToDouble,
  getStakingRewardAmount
} = require('../lib/avalanche/stakingrewards');
const {
  FakeChain,
  buildRandomProof,
  MIN_VALID_PROOF_SCORE
} = require('./util/avalanche');

const DANGLING = PeerManager.DANGLING_TIMEOUT;
const MIN = 60;

describe('Avalanche staking reward winners', function() {
  this.timeout(30000);

  let chain, pm, now;

  beforeEach(() => {
    chain = new FakeChain(1000);
    now = 1700000000;
    pm = new PeerManager({
      verifier: new ChainStakeVerifier({chain, confirmations: 1}),
      now: () => now
    });
  });

  async function register() {
    const proof = buildRandomProof(chain, MIN_VALID_PROOF_SCORE, 100);
    const [ok] = await pm.registerProof(proof);
    assert(ok);
    return [proof, pm.getPeerByProof(proof.id()).peerId];
  }

  const payoutOf = winner => winner.payout.toRaw().toString('hex');

  it('should compute ranks as Bitcoin ABC', () => {
    // arith_uint256::getdouble, least significant word first.
    const one = Buffer.alloc(32, 0);
    one[0] = 1;
    assert.strictEqual(uint256ToDouble(one), 1);
    const high = Buffer.alloc(32, 0);
    high[28] = 1;
    assert.strictEqual(uint256ToDouble(high), 2 ** 224);

    // Lower for a bigger hash, and for a bigger stake.
    assert(rewardRank(high, 100) < rewardRank(one, 100));
    assert(rewardRank(one, 200) < rewardRank(one, 100));

    assert.strictEqual(getStakingRewardAmount(625000001), 62500000);
  });

  it('should select winners as Bitcoin ABC', async () => {
    const prev = {hash: Buffer.alloc(32, 0), time: now};
    prev.hash[0] = 1;

    // No peer.
    assert.strictEqual(selectWinners(pm, prev, now), null);

    const proofs = [];
    for (let i = 0; i < 8; i++) {
      const [proof, peerId] = await register();
      assert(pm.setFinalized(peerId));
      proofs.push(proof);
    }

    // Registered more than 6 dangling timeouts before the block.
    now += 6 * DANGLING + 1;
    prev.time = now;

    // No node anywhere: every proof is flaky.
    let winners = selectWinners(pm, prev, now);
    assert(winners && winners.length <= 8);

    for (let i = 0; i < 8; i++) {
      assert(pm.isFlaky(proofs[i].id()));
      pm.addNode(i, proofs[i].id(), 16);
      assert(!pm.isFlaky(proofs[i].id()));
      winners = selectWinners(pm, prev, now);
      assert(winners.length <= 8 - i);
    }

    // A single winner now.
    winners = selectWinners(pm, prev, now);
    assert.strictEqual(winners.length, 1);

    // Equal stakes: each wins, over enough blocks.
    const iters = Math.floor(-Math.log(100000) / Math.log(7 / 8)) + 1;
    const counts = new Map();
    for (let i = 0; i < iters; i++) {
      const block = {hash: random.randomBytes(32), time: now};
      const [winner] = selectWinners(pm, block, now);
      counts.set(payoutOf(winner), (counts.get(payoutOf(winner)) || 0) + 1);
    }
    assert.strictEqual(counts.size, 8);

    // Every node has every proof.
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 8; j++)
        pm.saveRemoteProof(proofs[j].id(), i, true);
    }

    // Each node misses 3: every proof is flaky.
    for (let i = 0; i < 8; i++) {
      pm.saveRemoteProof(proofs[(i + 7) % 8].id(), i, false);
      pm.saveRemoteProof(proofs[i].id(), i, false);
      pm.saveRemoteProof(proofs[(i + 1) % 8].id(), i, false);
    }

    winners = selectWinners(pm, prev, now);
    for (const proof of proofs)
      assert(pm.isFlaky(proof.id()));
    assert.strictEqual(winners.length, 8);

    for (const proof of proofs) {
      for (let i = 0; i < 8; i++)
        pm.saveRemoteProof(proof.id(), i, true);
    }

    winners = selectWinners(pm, prev, now);
    assert.strictEqual(winners.length, 1);

    // Each flaky winner adds the next.
    for (let n = 1; n < 4; n++) {
      const last = payoutOf(winners[n - 1]);
      const proof = proofs.find(p => p.payout.toRaw().toString('hex') === last);
      for (let i = 0; i < 8; i++)
        pm.saveRemoteProof(proof.id(), i, false);
      assert(pm.isFlaky(proof.id()));

      winners = selectWinners(pm, prev, now);
      assert.strictEqual(winners.length, n + 1);
    }

    // Once more and the nodes miss too many to be believed.
    {
      const last = payoutOf(winners[3]);
      const proof = proofs.find(p => p.payout.toRaw().toString('hex') === last);
      for (let i = 0; i < 8; i++)
        pm.saveRemoteProof(proof.id(), i, false);
      winners = selectWinners(pm, prev, now);
      assert.strictEqual(winners.length, 1);
    }

    for (const proof of proofs)
      await pm.rejectProof(proof.id(), PeerManager.rejectionMode.INVALIDATE);

    assert.strictEqual(selectWinners(pm, prev, now), null);
  });

  it('should need a proof finalized and known long enough', async () => {
    const prev = {hash: random.randomBytes(32), time: now};
    const [proof, peerId] = await register();

    // Not finalized, and registered after the block.
    assert.strictEqual(selectWinners(pm, prev, now), null);

    // Registered after the block.
    pm.setFinalized(peerId);
    assert.strictEqual(selectWinners(pm, prev, now), null);

    // Registered 60 minutes ago, but the block is in the future.
    now += 50 * MIN + 1;
    prev.time = now + 10 * MIN;
    assert.strictEqual(selectWinners(pm, prev, now), null);

    // Registered 60 minutes ago, only 50 before the block.
    now += 10 * MIN;
    prev.time = now - 10 * MIN;
    assert.strictEqual(selectWinners(pm, prev, now), null);

    prev.time = now;
    const winners = selectWinners(pm, prev, now);
    assert.strictEqual(winners.length, 1);
    assert.strictEqual(payoutOf(winners[0]),
      proof.payout.toRaw().toString('hex'));
  });

  it('should offer substitutes by registration time', async () => {
    const start = now;
    const proofs = [];

    // Four proofs, registered 30 minutes apart.
    for (let i = 0; i < 4; i++) {
      now = start + i * 30 * MIN;
      const [proof, peerId] = await register();
      pm.addNode(i, proof.id(), 16);
      pm.setFinalized(peerId);
      proofs.push(proof);
    }

    now = start;
    const prev = {hash: random.randomBytes(32), time: now};
    const check = (winners) => {
      const peer = [...pm.peers.values()].find(p =>
        p.proof.payout.toRaw().equals(winners[0].payout.toRaw()));
      assert(peer.registrationTime < now - 60 * MIN);
    };

    assert.strictEqual(selectWinners(pm, prev, now), null);

    now += 30 * MIN + 1;
    prev.time = now;
    assert.strictEqual(selectWinners(pm, prev, now), null);

    now += 30 * MIN;
    prev.time = now;
    let winners = selectWinners(pm, prev, now);
    assert.strictEqual(winners.length, 2);
    check(winners);

    for (const max of [3, 3, 2]) {
      now += 30 * MIN;
      prev.time = now;
      winners = selectWinners(pm, prev, now);
      assert(winners.length <= max);
      check(winners);
    }

    now += 30 * MIN;
    prev.time = now;
    winners = selectWinners(pm, prev, now);
    assert.strictEqual(winners.length, 1);
    check(winners);
  });
});
