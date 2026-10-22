/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * A port of Bitcoin ABC's staking pre-consensus processor tests, in
 * src/avalanche/test/processor_tests.cpp: compute_staking_rewards,
 * stake_contenders and stake_contender_local_winners, against a fake
 * chain. Blocks are mined on it with a time, and the processor is told
 * of each tip, as Bitcoin ABC's AvalancheTest::updatedBlockTip.
 *
 * Not in Bitcoin ABC's processor tests, and added here: what avalanche
 * votes on a contender do (net_processing.cpp's handling of stake
 * contender updates, and Processor::finalizeStakeContender and
 * rejectStakeContender), and polling a contender to finalization.
 *
 * Not ported: answering polls for contenders (bcash does not vote yet),
 * and the local proof (bcash has none).
 */

const assert = require('bsert');
const NetAddress = require('../lib/net/netaddress');
const consensus = require('../lib/protocol/consensus');
const Proof = require('../lib/avalanche/proof');
const PeerManager = require('../lib/avalanche/peermanager');
const Processor = require('../lib/avalanche/processor');
const VoteRecord = require('../lib/avalanche/voterecord');
const ChainStakeVerifier = require('../lib/avalanche/stakeverifier');
const {Vote, Response} = require('../lib/avalanche/protocol');
const {
  contenderId,
  rewardRank,
  compareRanks
} = require('../lib/avalanche/stakingrewards');
const {
  FakeChain,
  MIN_VALID_PROOF_SCORE,
  buildRandomProof
} = require('./util/avalanche');

const {voteStatus, itemTypes} = Processor;
const {FINALIZATION_SCORE} = VoteRecord;
const {DANGLING_TIMEOUT} = PeerManager;

const MAX_ELEMENT_POLL = 1024;

// Bitcoin ABC's AVALANCHE_CONTENDER_MAX_POLLABLE.
const CONTENDER_MAX_POLLABLE = 12;

const HOUR = 60 * 60;

let nextNodeId = 0;

class FakePeer {
  constructor() {
    this.id = nextNodeId++;
    this.outbound = true;
    this.address = NetAddress.fromHostname(
      `10.${this.id >> 16 & 255}.${this.id >> 8 & 255}.${this.id & 255}:8333`,
      'main');
    this.sent = [];
    this.ban = 0;
  }

  hostname() {
    return this.address.hostname;
  }

  send(packet) {
    this.sent.push(packet);
  }

  increaseBan(score) {
    this.ban += score;
  }
}

/**
 * A chain whose blocks have times, a peer manager and a processor with
 * staking rewards and staking pre-consensus, and no stake needed for a
 * quorum: as Bitcoin ABC's AvalancheTestChain100Setup.
 */

class Setup {
  constructor() {
    this.now = 1700000000;
    this.time = 0;
    this.ms = () => (this.time += 0.001);

    this.chain = new FakeChain(100);
    this.chain.initBlocks();
    // Staking rewards from the start.
    this.chain.network = {block: {cowperthwaiteHeight: 0}};
    this.chain.tip.time = this.now;

    this.pm = new PeerManager({
      verifier: new ChainStakeVerifier({chain: this.chain, confirmations: 1}),
      now: () => this.now,
      ms: this.ms,
      stakingPreConsensus: true,
      getTip: () => this.chain.tip
    });

    this.processor = new Processor({
      peerManager: this.pm,
      chain: this.chain,
      isIBD: () => false,
      now: () => this.now,
      ms: this.ms,
      minQuorumStake: 0,
      minQuorumConnectedStakeRatio: 0,
      minAvaproofsNodeCount: 0,
      stakingRewards: true,
      stakingPreConsensus: true
    });
  }

  getProof(score = MIN_VALID_PROOF_SCORE) {
    return buildRandomProof(this.chain, score);
  }

  // Bitcoin ABC's CreateAndProcessBlock: a block at the current time.
  mine() {
    const entry = this.chain.mine();
    entry.time = this.now;
    return entry;
  }

  // Bitcoin ABC's AvalancheTest::updatedBlockTip.
  updatedBlockTip() {
    return this.processor.updatedBlockTip(this.chain.tip);
  }

  status(prev, proof) {
    return this.processor.getStakeContenderStatus(
      contenderId(prev.hash, proof.id()));
  }

  winners(prev) {
    return this.processor.getStakingRewardWinners(prev.hash);
  }

  payouts(prev) {
    const winners = this.winners(prev);
    return winners ? winners.map(w => w.payout.toRaw().toString('hex')) : [];
  }

  addNodes(proof, count = 8, first = 0) {
    for (let i = first; i < first + count; i++)
      assert(this.pm.addNode(i, proof.id(), MAX_ELEMENT_POLL));
  }

  finalizePeer(proof) {
    const peer = this.pm.getPeerByProof(proof.id());
    assert(peer);
    assert(this.pm.setFinalized(peer.peerId));
  }

  connectNode() {
    const peer = new FakePeer();
    this.processor.addPeer(peer);
    return peer;
  }
}

const hex = proof => proof.payout.toRaw().toString('hex');

describe('Avalanche staking pre-consensus', function() {
  this.timeout(60000);

  let setup, processor, pm;

  beforeEach(() => {
    setup = new Setup();
    processor = setup.processor;
    pm = setup.pm;
  });

  // Bitcoin ABC's compute_staking_rewards.
  it('should compute staking rewards, and clean them up', async () => {
    const zero = Buffer.alloc(32, 0x00);

    assert.strictEqual(processor.getStakingRewardWinners(zero), null);

    // No block.
    assert(!processor.computeStakingReward(null));
    assert.strictEqual(processor.getStakingRewardWinners(zero), null);

    const prev = {hash: zero, height: 100, time: setup.now};

    // No quorum.
    assert(!processor.computeStakingReward(prev));
    assert.strictEqual(processor.getStakingRewardWinners(zero), null);

    const proofs = [];
    for (let i = 0; i < 10; i++) {
      const proof = setup.getProof();
      assert((await pm.registerProof(proof))[0]);
      assert(pm.addNode(i, proof.id(), MAX_ELEMENT_POLL));
      setup.finalizePeer(proof);
      proofs.push(proof);
    }

    assert(processor.isQuorumEstablished());

    // Proofs too recent: still no winner.
    assert(!processor.computeStakingReward(prev));
    assert.strictEqual(processor.getStakingRewardWinners(zero), null);

    const payouts = new Set(proofs.map(hex));
    const winnerExists = (hash) => {
      const winners = processor.getStakingRewardWinners(hash);
      return winners != null
        && payouts.has(winners[0].payout.toRaw().toString('hex'));
    };

    setup.now += HOUR + 1;
    prev.time = setup.now;

    assert(processor.computeStakingReward(prev));
    assert(winnerExists(zero));

    // Again: nothing changes.
    assert(processor.computeStakingReward(prev));
    assert(winnerExists(zero));

    // uint64 max, little-endian.
    const highHash = Buffer.alloc(32, 0x00);
    highHash.fill(0xff, 0, 8);
    const high = {hash: highHash, height: 101, time: prev.time};

    assert(processor.computeStakingReward(high));
    assert(winnerExists(highHash));
    assert(winnerExists(zero));

    // Below 101 is forgotten.
    processor.cleanupStakingRewards(101);
    assert.strictEqual(processor.getStakingRewardWinners(zero), null);
    assert(winnerExists(highHash));

    // And can be computed again.
    assert(processor.computeStakingReward(prev));
    assert(winnerExists(zero));

    processor.cleanupStakingRewards(200);
    assert.strictEqual(processor.getStakingRewardWinners(zero), null);
    assert.strictEqual(processor.getStakingRewardWinners(highHash), null);
  });

  // Bitcoin ABC's stake_contenders.
  it('should cache, promote and clean up stake contenders', async () => {
    let tip = setup.chain.tip;
    const block1 = tip;

    const proof1 = setup.getProof();
    const proof2 = setup.getProof();

    // Pending while no staking reward winner was computed.
    pm.addStakeContender(proof1);
    pm.addStakeContender(proof2);
    assert.strictEqual(setup.status(block1, proof1), -2);
    assert.strictEqual(setup.status(block1, proof2), -2);

    const unknown = {id: () => Buffer.alloc(32, 0x42)};
    assert.strictEqual(setup.status(block1, unknown), -1);

    // proof2 registered and remote, so it is promoted.
    assert((await pm.registerProof(proof2))[0]);
    setup.addNodes(proof2);
    pm.saveRemoteProof(proof2.id(), 0, true);
    setup.finalizePeer(proof2);

    // Old enough for staking rewards.
    setup.now += HOUR + 1;

    tip = setup.mine();
    const block2 = tip;
    await setup.updatedBlockTip();

    assert(processor.isQuorumEstablished());
    assert(processor.computeStakingReward(block2));
    assert.deepStrictEqual(setup.payouts(block2), [hex(proof2)]);

    assert.strictEqual(setup.status(block2, unknown), -1);

    // Old entries unaffected.
    assert.strictEqual(setup.status(block1, proof1), -2);
    assert.strictEqual(setup.status(block1, proof2), -2);

    // proof1 was not promoted; proof2 was.
    assert.strictEqual(setup.status(block2, proof1), -1);
    assert.strictEqual(setup.status(block2, proof2), 0);

    // Past block1: its entries go, but the promoted one stays.
    processor.cleanupStakingRewards(block2.height);
    assert.strictEqual(setup.status(block2, unknown), -1);
    assert.strictEqual(setup.status(block1, proof1), -1);
    assert.strictEqual(setup.status(block2, proof1), -1);
    assert.strictEqual(setup.status(block1, proof2), -1);
    assert.strictEqual(setup.status(block2, proof2), 0);

    // Winners set by hand.
    processor.setStakingRewardWinners(block2, [proof1.payout, proof2.payout]);
    // proof1's contender was forgotten: no one is to poll it any more.
    assert.strictEqual(setup.status(block2, proof1), -1);
    // proof2 wins, though avalanche did not finalize it.
    assert.strictEqual(setup.status(block2, proof2), 0);

    // Reject proof2, and get a quorum again with another proof.
    await pm.rejectProof(proof2.id());
    assert(!processor.isQuorumEstablished());

    const proof3 = setup.getProof();
    assert((await pm.registerProof(proof3))[0]);
    setup.addNodes(proof3);
    assert(processor.isQuorumEstablished());

    tip = setup.mine();
    const block3 = tip;
    await setup.updatedBlockTip();
    processor.cleanupStakingRewards(block3.height);

    assert.strictEqual(setup.status(block3, unknown), -1);

    // Old entries gone.
    assert.strictEqual(setup.status(block2, proof1), -1);
    assert.strictEqual(setup.status(block2, proof2), -1);

    // Neither promoted: proof2 was cleaned up though once a manual winner.
    assert.strictEqual(setup.status(block3, proof1), -1);
    assert.strictEqual(setup.status(block3, proof2), -1);

    await pm.rejectProof(proof3.id());

    // Flaky proofs: registered (contenders), remote, finalized.
    const proofs = [];
    for (let i = 0; i < 8; i++) {
      const proof = setup.getProof();
      assert((await pm.registerProof(proof))[0]);
      pm.saveRemoteProof(proof.id(), i, true);
      setup.finalizePeer(proof);
      proofs.push(proof);
    }

    // Nodes for the first only, for a quorum.
    setup.addNodes(proofs[0]);

    setup.now += HOUR + 1;

    // A few times, in case the one that is not flaky wins.
    let winners = [];
    for (let attempt = 0; attempt < 10; attempt++) {
      tip = setup.mine();
      await setup.updatedBlockTip();

      assert(processor.isQuorumEstablished());
      assert(processor.computeStakingReward(tip));
      winners = setup.payouts(tip);
      if (winners.length === 8)
        break;
    }

    assert.strictEqual(winners.length, 8);

    // Every winner accepted.
    let numAccepted = 0;
    for (const proof of proofs) {
      if (setup.status(tip, proof) === 0) {
        numAccepted += 1;
        assert(winners.includes(hex(proof)));
      }
    }
    assert.strictEqual(numAccepted, winners.length);

    // The best ranked contender, not a winner, is still accepted.
    tip = setup.mine();
    const best = setup.getProof(Proof.amountToScore(consensus.MAX_MONEY)
      - MIN_VALID_PROOF_SCORE * 8);
    pm.addStakeContender(best);
    await setup.updatedBlockTip();

    assert(processor.isQuorumEstablished());
    assert(processor.computeStakingReward(tip));
    assert(!setup.payouts(tip).includes(hex(best)));
    assert.strictEqual(setup.status(tip, best), 0);

    // Registered, to be dangling later, and remote so it is promoted.
    assert((await pm.registerProof(best))[0]);
    pm.saveRemoteProof(best.id(), 0, true);
    pm.saveRemoteProof(best.id(), 1, false);

    tip = setup.mine();
    await setup.updatedBlockTip();
    processor.finalizationTip = tip;
    processor.cleanupStakingRewards(tip.height);

    // Dangling: it has no node.
    setup.now += DANGLING_TIMEOUT + 1;
    await pm.cleanupDanglingProofs();
    assert(pm.isDangling(best.id()));

    assert(processor.isQuorumEstablished());
    assert(processor.computeStakingReward(tip));
    assert(!setup.payouts(tip).includes(hex(best)));

    // Still polled, but voted against while dangling.
    assert.strictEqual(setup.status(tip, best), 4);
  });

  // Bitcoin ABC's stake_contender_local_winners.
  it('should accept the local winner and the best contenders', async () => {
    const tip = setup.chain.tip;
    const winner = setup.getProof();
    const winnerId = contenderId(tip.hash, winner.id());

    // The cache keeps the tip's time from the first insert: ahead, so the
    // proof is registered early enough to be eligible.
    const delay = 4 * DANGLING_TIMEOUT + 1;
    tip.time = setup.now + delay;

    assert((await pm.registerProof(winner))[0]);
    setup.addNodes(winner);
    setup.finalizePeer(winner);

    setup.now += delay;

    assert(processor.isQuorumEstablished());
    assert(processor.computeStakingReward(tip));

    const rankOf = (proof) => {
      const id = contenderId(tip.hash, proof.id());
      return {
        rank: rewardRank(id, MIN_VALID_PROOF_SCORE),
        contender: id,
        proofId: proof.id()
      };
    };

    const accepted = [winner];
    let bestRank = rankOf(winner).rank;

    // Well past the max, from 2: the local winner is one.
    for (let n = 2; n < CONTENDER_MAX_POLLABLE * 10; n++) {
      const proof = setup.getProof();
      pm.addStakeContender(proof);

      const {rank} = rankOf(proof);

      if (rank <= bestRank) {
        bestRank = rank;
        accepted.push(proof);
        const numAccepted = Math.min(CONTENDER_MAX_POLLABLE, accepted.length);
        const head = accepted.slice(0, numAccepted)
          .sort((a, b) => compareRanks(rankOf(a), rankOf(b)));
        accepted.splice(0, numAccepted, ...head);
      }

      const pollable = pm.setContenderStatusForLocalWinners(tip,
        processor.getStakingRewardWinners(tip.hash), CONTENDER_MAX_POLLABLE);
      assert.strictEqual(pollable.length,
        Math.min(n, CONTENDER_MAX_POLLABLE));

      const pollableKeys = pollable.map(id => id.toString('hex'));

      // Accepted ones, up to the max, best first, are all polled.
      const acceptedKeys = new Set();
      for (const proof of accepted)
        acceptedKeys.add(contenderId(tip.hash, proof.id()).toString('hex'));

      for (const proof of accepted.slice(0, CONTENDER_MAX_POLLABLE)) {
        const id = contenderId(tip.hash, proof.id());
        assert(pollableKeys.includes(id.toString('hex')));
        assert.strictEqual(processor.getStakeContenderStatus(id), 0);
      }

      // The rest are as they were.
      for (const key of pollableKeys) {
        if (acceptedKeys.has(key))
          continue;
        assert.strictEqual(
          processor.getStakeContenderStatus(Buffer.from(key, 'hex')), 1);
      }

      // The local winner stays accepted.
      assert.strictEqual(processor.getStakeContenderStatus(winnerId), 0);
    }
  });

  /*
   * Votes on contenders (not in Bitcoin ABC's processor tests)
   */

  // A quorum, proofs old enough to win, and a block to win them on.
  async function contenders(count) {
    const proofs = [];
    for (let i = 0; i < count; i++) {
      const proof = setup.getProof();
      assert((await pm.registerProof(proof))[0]);
      setup.addNodes(proof, 8, i * 8);
      setup.finalizePeer(proof);
      proofs.push(proof);
    }

    setup.now += 2 * HOUR;
    const tip = setup.mine();
    await setup.updatedBlockTip();
    assert(setup.winners(tip));
    return [tip, proofs];
  }

  const update = (prev, proof, status) => ({
    type: itemTypes.CONTENDER,
    hash: contenderId(prev.hash, proof.id()),
    item: contenderId(prev.hash, proof.id()),
    status
  });

  it('should make a finalized contender a winner', async () => {
    const [tip, proofs] = await contenders(3);
    const [first] = setup.winners(tip);

    const other = proofs.find(p => !p.id().equals(first.proofId));

    await processor.applyUpdate(update(tip, other, voteStatus.FINALIZED));

    // The winners avalanche finalized, accepted first, then by rank: ours
    // was finalized locally, and is still among them.
    const payouts = setup.payouts(tip);
    assert(payouts.includes(hex(other)));
    assert(payouts.includes(first.payout.toRaw().toString('hex')));
    assert(processor.isRecentlyFinalized(contenderId(tip.hash, other.id())));
  });

  it('should choose again when the winner is rejected', async () => {
    const [tip] = await contenders(3);
    const [first] = setup.winners(tip);
    const loser = pm.getProof(first.proofId);

    // Rejecting another changes nothing.
    const others = [...pm.peers.values()]
      .map(p => p.proof)
      .filter(p => !p.id().equals(first.proofId));
    const before = setup.payouts(tip);
    await processor.applyUpdate(update(tip, others[0], voteStatus.REJECTED));
    assert.deepStrictEqual(setup.payouts(tip), before);

    // Old enough not to need alternatives: one winner.
    assert.strictEqual(before.length, 1);

    // Our winner rejected, with no accepted winner: chosen again with it
    // rejected. As Bitcoin ABC (PeerManager::selectStakingRewardWinner),
    // it stays first, but no longer ends the search: an alternative
    // follows it.
    for (const entry of pm.stakeContenderCache.contenders.values())
      entry.status = 0;
    await processor.applyUpdate(update(tip, loser, voteStatus.REJECTED));

    const winners = setup.winners(tip);
    assert.strictEqual(winners.length, 2);
    assert(winners[0].proofId.equals(first.proofId));
    assert(!winners[1].proofId.equals(first.proofId));
  });

  it('should take avalanche\'s winners when the winner is rejected',
    async () => {
      const [tip, proofs] = await contenders(3);
      const [first] = setup.winners(tip);
      const other = proofs.find(p => !p.id().equals(first.proofId));
      const loser = pm.getProof(first.proofId);

      // Avalanche accepted another into the winner set.
      pm.stakeContenderCache.finalize(contenderId(tip.hash, other.id()));
      await processor.applyUpdate(update(tip, loser, voteStatus.INVALID));

      assert.strictEqual(setup.payouts(tip)[0], hex(other));
    });

  it('should poll a contender to finalization', async () => {
    const [tip] = await contenders(1);
    const [first] = setup.winners(tip);
    const id = contenderId(tip.hash, first.proofId);

    assert(processor.isPolled(itemTypes.CONTENDER, id));

    const nodes = [];
    for (let i = 0; i < 8; i++) {
      const peer = setup.connectNode();
      assert(pm.addNode(peer.id, first.proofId, MAX_ELEMENT_POLL));
      nodes.push(peer);
    }

    let finalized = null;
    for (let i = 0; i < 10 * FINALIZATION_SCORE && !finalized; i++) {
      const round = processor.round;
      await processor.runEventLoop();
      if (processor.round === round)
        continue;
      const query = [...processor.queries.values()]
        .find(q => q.round === round);
      const votes = query.invs.map(inv => new Vote(0, inv.hash));
      const result = await processor.registerVotes(query.nodeId,
        new Response(round, 0, votes));
      assert(result.ok, result.error);
      for (const u of result.updates) {
        await processor.applyUpdate(u);
        if (u.type === itemTypes.CONTENDER
            && u.status === voteStatus.FINALIZED) {
          finalized = u;
        }
      }
    }

    assert(finalized);
    assert(finalized.hash.equals(id));
    assert(!processor.isPolled(itemTypes.CONTENDER, id));
    assert.strictEqual(setup.payouts(tip)[0], first.payout.toRaw()
      .toString('hex'));
  });
});
