/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * A port of Bitcoin ABC's stake contender cache tests, in
 * src/avalanche/test/stakecontendercache_tests.cpp. Blocks are plain
 * {hash, height, time}, as the cache reads nothing else of them. ABC's
 * promote_tests runs on a PeerManagerFixture, but its shouldPromote
 * callbacks never call the peer manager, so neither do these.
 */

const assert = require('bsert');
const random = require('bcrypto/lib/random');
const Script = require('../lib/script/script');
const StakeContenderCache = require('../lib/avalanche/stakecontendercache');
const {contenderId, rewardRank} = require('../lib/avalanche/stakingrewards');
const {
  FakeChain,
  buildRandomProof,
  MIN_VALID_PROOF_SCORE
} = require('./util/avalanche');

const {UNKNOWN, ACCEPTED, IN_WINNER_SET} = StakeContenderCache.status;

/*
 * Helpers
 */

// A chain of 101 blocks, heights 0 to 100: blocks[100] is the tip.
function makeBlocks() {
  const blocks = [];
  for (let height = 0; height <= 100; height++) {
    blocks.push({
      hash: random.randomBytes(32),
      height,
      time: 1700000000 + height * 600
    });
  }
  return blocks;
}

// ABC's m_rng.randbits(2).
const randomStatus = () => random.randomRange(0, 4);

const id = (prevHash, proof) => contenderId(prevHash, proof.id());

const rankOf = (prevHash, proofId) =>
  rewardRank(contenderId(prevHash, proofId), MIN_VALID_PROOF_SCORE);

const isEmpty = cache =>
  cache.contenders.size === 0 && cache.manualWinners.size === 0;

function checkWinners(cache, prevHash, manual, accepted, rejected) {
  const expectedSize = manual.length + accepted.length + rejected.length;

  // Manual winners alone are not avalanche-accepted stake winners.
  assert.strictEqual(cache.hasAcceptedWinner(prevHash), accepted.length > 0);

  const winners = cache.getWinners(prevHash);

  if (expectedSize === 0) {
    assert.strictEqual(winners.length, 0);
    return;
  }

  assert.strictEqual(winners.length, expectedSize);

  // Manual winners are always first, and in order.
  for (let i = 0; i < manual.length; i++)
    assert.bufferEqual(winners[i].payout.toRaw(), manual[i].toRaw());

  const acceptedPart = winners.slice(manual.length,
    manual.length + accepted.length);
  const rejectedPart = winners.slice(manual.length + accepted.length);

  // The rest are those determined by avalanche.
  for (const proof of accepted)
    assert(acceptedPart.some(w => w.proofId.equals(proof.id())));

  for (const proof of rejected)
    assert(rejectedPart.some(w => w.proofId.equals(proof.id())));

  // Best (lowest) reward rank first, in each part.
  for (const part of [acceptedPart, rejectedPart]) {
    let previous = 0;
    for (const w of part) {
      const rank = rankOf(prevHash, w.proofId);
      assert(previous < rank);
      previous = rank;
    }
  }
}

function checkVoteStatus(cache, prevHash, proof, expected) {
  const {voteStatus, prevHash: check} =
    cache.getVoteStatus(id(prevHash, proof));
  assert.strictEqual(voteStatus, expected);
  if (expected !== -1)
    assert.bufferEqual(check, prevHash);
}

describe('Avalanche StakeContenderCache', function() {
  let chain, blocks, tip;

  beforeEach(() => {
    chain = new FakeChain(100);
    blocks = makeBlocks();
    tip = blocks[100];
  });

  const prev = block => blocks[block.height - 1];
  const proof = () => buildRandomProof(chain, MIN_VALID_PROOF_SCORE);

  it('should vote on contenders by status (vote_status_tests)', () => {
    const cache = new StakeContenderCache();
    const blockhash = tip.hash;

    const initialStatuses = [UNKNOWN, ACCEPTED, IN_WINNER_SET,
      ACCEPTED | IN_WINNER_SET];

    for (const initialStatus of initialStatuses) {
      const p = proof();

      // Unknown contender.
      checkVoteStatus(cache, blockhash, p, -1);

      // Add the contender and check its vote after avalanche updates.
      assert(cache.add(tip, p, initialStatus));
      checkVoteStatus(cache, blockhash, p, (initialStatus & ACCEPTED) ? 0 : 1);

      cache.accept(id(blockhash, p));
      checkVoteStatus(cache, blockhash, p, 0);

      cache.reject(id(blockhash, p));
      checkVoteStatus(cache, blockhash, p, 1);

      cache.finalize(id(blockhash, p));
      checkVoteStatus(cache, blockhash, p, 0);

      // As a manual winner, it is always accepted.
      assert(cache.setWinners(tip, [p.payout]));
      checkVoteStatus(cache, blockhash, p, 0);
    }
  });

  it('should find an accepted winner (has_accepted_winner_tests)', () => {
    const cache = new StakeContenderCache();
    const blockhash = tip.hash;

    assert(!cache.hasAcceptedWinner(blockhash));

    // Manual winners alone are not avalanche-accepted stake winners.
    assert(cache.setWinners(tip, [Script.fromRaw(Buffer.from([0x51]))]));
    assert(!cache.hasAcceptedWinner(blockhash));

    const winnerOnly = proof();
    const acceptedOnly = proof();
    const acceptedWinner = proof();

    // IN_WINNER_SET without ACCEPTED.
    assert(cache.add(tip, winnerOnly, IN_WINNER_SET));
    assert(!cache.hasAcceptedWinner(blockhash));

    // ACCEPTED without IN_WINNER_SET.
    assert(cache.add(tip, acceptedOnly, ACCEPTED));
    assert(!cache.hasAcceptedWinner(blockhash));

    // Both.
    assert(cache.add(tip, acceptedWinner, ACCEPTED | IN_WINNER_SET));
    assert(cache.hasAcceptedWinner(blockhash));

    // Reject clears ACCEPTED.
    cache.reject(id(blockhash, acceptedWinner));
    assert(!cache.hasAcceptedWinner(blockhash));

    // Finalize restores ACCEPTED | IN_WINNER_SET.
    cache.finalize(id(blockhash, acceptedWinner));
    assert(cache.hasAcceptedWinner(blockhash));

    // Another block has none.
    assert(!cache.hasAcceptedWinner(prev(tip).hash));
  });

  it('should rank winners, manual ones first (winners_tests)', () => {
    const cache = new StakeContenderCache();

    const manualWinners = [
      Script.fromRaw(Buffer.from([0x51])),
      Script.fromRaw(Buffer.from([0x00]))
    ];

    const proofs = [proof(), proof(), proof(), proof()];

    // Over several blocks, so none changes another's entries.
    let block = tip;
    let moreManualWinners;
    for (let i = 0; i < 5; i++) {
      const blockhash = block.hash;
      checkWinners(cache, blockhash, [], [], []);

      // A manual winner.
      assert(cache.setWinners(block, [manualWinners[0]]));
      checkWinners(cache, blockhash, [manualWinners[0]], [], []);

      for (const p of proofs)
        checkVoteStatus(cache, blockhash, p, -1);

      // Local winner.
      assert(cache.add(block, proofs[0], ACCEPTED | IN_WINNER_SET));
      checkVoteStatus(cache, blockhash, proofs[0], 0);

      // A potential winner other than the local winner.
      assert(cache.add(block, proofs[1], ACCEPTED));
      checkVoteStatus(cache, blockhash, proofs[1], 0);

      // A local winner avalanche has rejected so far.
      assert(cache.add(block, proofs[2], IN_WINNER_SET));
      checkVoteStatus(cache, blockhash, proofs[2], 1);

      // Some other contender.
      assert(cache.add(block, proofs[3]));
      checkVoteStatus(cache, blockhash, proofs[3], 1);

      // No duplicates, whatever their status.
      for (const p of proofs) {
        assert(!cache.add(block, p));
        assert(!cache.add(block, p, ACCEPTED));
        assert(!cache.add(block, p, ACCEPTED | IN_WINNER_SET));
        assert(!cache.add(block, p, IN_WINNER_SET));
      }

      checkWinners(cache, blockhash, [manualWinners[0]], [proofs[0]],
        [proofs[2]]);

      // Another manual winner: always before contenders.
      assert(cache.setWinners(block, manualWinners));
      checkWinners(cache, blockhash, manualWinners, [proofs[0]], [proofs[2]]);

      // Manual winners paying as contenders do never conflict.
      moreManualWinners = manualWinners.slice();
      for (const p of proofs) {
        moreManualWinners.push(p.payout);
        assert(cache.setWinners(block, moreManualWinners));
        checkVoteStatus(cache, blockhash, p, 0);
        checkWinners(cache, blockhash, moreManualWinners, [proofs[0]],
          [proofs[2]]);
      }
      checkWinners(cache, blockhash, moreManualWinners, [proofs[0]],
        [proofs[2]]);

      // Accepting them all does not change the winners yet.
      for (const p of proofs)
        cache.accept(id(blockhash, p));
      checkWinners(cache, blockhash, moreManualWinners,
        [proofs[0], proofs[2]], []);

      // Nor does rejecting them all.
      for (const p of proofs)
        cache.reject(id(blockhash, p));
      checkWinners(cache, blockhash, moreManualWinners, [],
        [proofs[0], proofs[2]]);

      // Finalizing one already in the winner set makes no difference.
      cache.finalize(id(blockhash, proofs[0]));
      checkWinners(cache, blockhash, moreManualWinners, [proofs[0]],
        [proofs[2]]);

      // Finalizing one that was not makes a new winner.
      cache.finalize(id(blockhash, proofs[1]));
      checkWinners(cache, blockhash, moreManualWinners,
        [proofs[0], proofs[1]], [proofs[2]]);

      // Rejecting a finalized one changes only the order.
      cache.reject(id(blockhash, proofs[1]));
      checkWinners(cache, blockhash, moreManualWinners, [proofs[0]],
        [proofs[1], proofs[2]]);

      block = prev(block);
    }

    // Every contender was a manual winner at some point.
    const allManual = manualWinners.concat(proofs.map(p => p.payout));

    // Past state was not poisoned.
    block = tip;
    for (let i = 0; i < 5; i++) {
      checkWinners(cache, block.hash, allManual, [proofs[0]],
        [proofs[1], proofs[2]]);
      for (const p of proofs)
        checkVoteStatus(cache, block.hash, p, 0);
      block = prev(block);
    }
  });

  it('should clean up only up to the last promotion (cleanup_tests)', () => {
    const cache = new StakeContenderCache();
    const proofs = [];
    for (let i = 0; i < 10; i++)
      proofs.push(proof());

    const blockhashes = [tip.hash];
    let block = prev(tip);
    for (let i = 0; i < 3; i++) {
      blockhashes.push(block.hash);
      for (const p of proofs)
        cache.add(block, p, IN_WINNER_SET);
      checkWinners(cache, block.hash, [], [], proofs);
      block = prev(block);
    }

    const never = () => false;
    const check = (expected) => {
      for (let i = 0; i < 4; i++) {
        const [manual, rejected] = expected[i];
        checkWinners(cache, blockhashes[i], manual, [], rejected);
      }
    };

    // Promote up to the height cleanup may reach. Nothing is promoted, so
    // the test controls which blocks have entries.
    block = blocks[97];
    assert.strictEqual(block.height, 97);
    cache.promoteToBlock(block, never);

    // Cleaning up entries that are not there changes nothing.
    for (const height of [0, 10, 50, 90, 97]) {
      cache.cleanup(height);
      check([[[], []], [[], proofs], [[], proofs], [[], proofs]]);
    }

    // The oldest block's entries stay: nothing was promoted at its height.
    cache.cleanup(98);
    check([[[], []], [[], proofs], [[], proofs], [[], proofs]]);

    // Promote up to it, and they go.
    cache.promoteToBlock(blocks[98], never);
    cache.cleanup(98);
    check([[[], []], [[], proofs], [[], proofs], [[], []]]);

    // A local winner only at the cleared block.
    const empty = new Script();
    cache.setWinners(blocks[97], [empty]);
    check([[[], []], [[], proofs], [[], proofs], [[empty], []]]);

    cache.cleanup(98);
    check([[[], []], [[], proofs], [[], proofs], [[], []]]);

    // A local winner at a block with winners, then cleared.
    cache.setWinners(blocks[98], [empty]);
    check([[[], []], [[], proofs], [[empty], proofs], [[], []]]);

    cache.promoteToBlock(blocks[99], never);
    cache.cleanup(99);
    check([[[], []], [[], proofs], [[], []], [[], []]]);

    // The last one, and the cache is empty.
    cache.promoteToBlock(tip, never);
    cache.cleanup(100);
    assert(isEmpty(cache));
    check([[[], []], [[], []], [[], []], [[], []]]);

    // Again, no change.
    cache.cleanup(100);
    assert(isEmpty(cache));
    check([[[], []], [[], []], [[], []], [[], []]]);

    // Higher heights clear entries in any state.
    for (const height of [102, 200, 1000, 1000000]) {
      block = blocks[99];
      for (let i = 1; i < 3; i++) {
        for (const p of proofs) {
          cache.add(block, p, randomStatus());
          cache.setWinners(block, [empty]);
        }

        assert(cache.getWinners(blockhashes[i]).length >= 1);
        block = prev(block);
      }

      cache.cleanup(height);
      assert(isEmpty(cache));
      check([[[], []], [[], []], [[], []], [[], []]]);
    }

    // But never past the last block promoted to.
    cache.add(tip, proofs[0], IN_WINNER_SET);
    for (const height of [102, 200, 1000, 1000000]) {
      cache.cleanup(height);
      check([[[], [proofs[0]]], [[], []], [[], []], [[], []]]);
    }
  });

  it('should carry contenders to a new block (promote_tests)', () => {
    const cache = new StakeContenderCache();
    const proofs = [proof(), proof(), proof()];

    // Blocks 100, 99, 98, then 97, 96, 95 with one contender each.
    const blockhashes = [];
    let block = tip;
    for (let i = 0; i < 3; i++) {
      blockhashes.push(block.hash);
      block = prev(block);
    }

    for (let i = 0; i < 3; i++) {
      blockhashes.push(block.hash);
      cache.add(block, proofs[i], IN_WINNER_SET);
      checkWinners(cache, block.hash, [], [], [proofs[i]]);
      block = prev(block);
    }

    // Cleanup before any promotion changes nothing.
    for (let height = 95; height <= 100; height++) {
      cache.cleanup(height);
      checkWinners(cache, blockhashes[0], [], [], []);
      checkWinners(cache, blockhashes[1], [], [], []);
      checkWinners(cache, blockhashes[2], [], [], []);
      checkWinners(cache, blockhashes[3], [], [], [proofs[0]]);
      checkWinners(cache, blockhashes[4], [], [], [proofs[1]]);
      checkWinners(cache, blockhashes[5], [], [], [proofs[2]]);
    }

    // Promoted, but not winners at that block yet.
    cache.promoteToBlock(blocks[98], () => true);
    checkWinners(cache, blockhashes[0], [], [], []);
    checkWinners(cache, blockhashes[1], [], [], []);
    checkWinners(cache, blockhashes[2], [], [], []);
    for (const p of proofs) {
      checkVoteStatus(cache, blockhashes[0], p, -1);
      checkVoteStatus(cache, blockhashes[1], p, -1);
      checkVoteStatus(cache, blockhashes[2], p, 1);
    }

    // Still winners for their own blocks.
    checkWinners(cache, blockhashes[3], [], [], [proofs[0]]);
    checkWinners(cache, blockhashes[4], [], [], [proofs[1]]);
    checkWinners(cache, blockhashes[5], [], [], [proofs[2]]);

    // Cleanup leaves the promoted entries alone.
    cache.cleanup(98);
    checkWinners(cache, blockhashes[0], [], [], []);
    checkWinners(cache, blockhashes[1], [], [], []);
    checkWinners(cache, blockhashes[2], [], [], []);
    for (const p of proofs) {
      checkVoteStatus(cache, blockhashes[0], p, -1);
      checkVoteStatus(cache, blockhashes[1], p, -1);
      checkVoteStatus(cache, blockhashes[2], p, 1);
    }
    checkWinners(cache, blockhashes[3], [], [], []);
    checkWinners(cache, blockhashes[4], [], [], []);
    checkWinners(cache, blockhashes[5], [], [], []);

    // Finalize them.
    for (const p of proofs) {
      cache.finalize(id(blockhashes[2], p));
      checkVoteStatus(cache, blockhashes[0], p, -1);
      checkVoteStatus(cache, blockhashes[1], p, -1);
      checkVoteStatus(cache, blockhashes[2], p, 0);
    }
    checkWinners(cache, blockhashes[0], [], [], []);
    checkWinners(cache, blockhashes[1], [], [], []);
    checkWinners(cache, blockhashes[2], [], proofs, []);

    // Promoting to the same block again changes nothing.
    cache.promoteToBlock(blocks[98], () => true);
    for (const p of proofs) {
      checkVoteStatus(cache, blockhashes[0], p, -1);
      checkVoteStatus(cache, blockhashes[1], p, -1);
      checkVoteStatus(cache, blockhashes[2], p, 0);
    }
    checkWinners(cache, blockhashes[0], [], [], []);
    checkWinners(cache, blockhashes[1], [], [], []);
    checkWinners(cache, blockhashes[2], [], proofs, []);

    // Advance the tip, without a proof that is no longer valid.
    cache.promoteToBlock(blocks[99],
      proofId => !proofId.equals(proofs[2].id()));
    for (const p of proofs)
      checkVoteStatus(cache, blockhashes[0], p, -1);
    checkVoteStatus(cache, blockhashes[1], proofs[0], 1);
    checkVoteStatus(cache, blockhashes[1], proofs[1], 1);
    checkVoteStatus(cache, blockhashes[1], proofs[2], -1);
  });

  it('should poll accepted contenders first, by rank '
     + '(pollable_contenders_tests)', () => {
    const cache = new StakeContenderCache();
    const blockhash = tip.hash;
    const maxPollable = 12;

    assert.strictEqual(
      cache.getPollableContenders(blockhash, maxPollable).length, 0);

    let numAccepted = 0;
    for (let c = 0; c < maxPollable * 2; c++) {
      // A new contender, in a random state.
      const p = proof();
      assert(cache.add(tip, p, randomStatus()));

      const cid = id(blockhash, p);
      if (cache.getVoteStatus(cid).voteStatus === 0)
        numAccepted += 1;

      // Never more than fit in one poll.
      const contenders = cache.getPollableContenders(blockhash, maxPollable);
      assert(contenders.length <= maxPollable);

      let lastRank = 0;
      let countAccepted = 0;
      for (const contender of contenders) {
        // Sorted by rank.
        const rank = rewardRank(contender, MIN_VALID_PROOF_SCORE);
        assert(lastRank <= rank);
        lastRank = rank;

        if (cache.getVoteStatus(contender).voteStatus === 0)
          countAccepted += 1;
      }

      // Every accepted contender, up to the max.
      assert.strictEqual(countAccepted, Math.min(numAccepted, maxPollable));
    }
  });
});
