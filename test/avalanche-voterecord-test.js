/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * A port of Bitcoin ABC's src/avalanche/test/voterecord_tests.cpp.
 */

const assert = require('bsert');
const random = require('bcrypto/lib/random');
const VoteRecord = require('../lib/avalanche/voterecord');

const {
  FINALIZATION_SCORE,
  VOTE_STALE_THRESHOLD,
  VOTE_STALE_FACTOR,
  MAX_INFLIGHT_POLL
} = VoteRecord;

const NEUTRAL = 0xffffffff;

describe('Avalanche VoteRecord', function() {
  // Voters cycle through 8 node ids, as in ABC's fixture.
  let currentNodeId = -1;

  function nextNodeId() {
    currentNodeId += 1;
    if (currentNodeId >= 8)
      currentNodeId = 0;
    return currentNodeId;
  }

  beforeEach(() => {
    currentNodeId = -1;
  });

  function check(vr, vote, state, finalized, stale, confidence) {
    vr.registerVote(nextNodeId(), vote);
    assert.strictEqual(vr.isAccepted(), state);
    assert.strictEqual(vr.hasFinalized(), finalized);
    assert.strictEqual(vr.isStale(), stale);
    assert.strictEqual(vr.getConfidence(), confidence);
  }

  it('should build and flip confidence', () => {
    const vraccepted = new VoteRecord(true, 0);
    assert.strictEqual(vraccepted.isAccepted(), true);
    assert.strictEqual(vraccepted.hasFinalized(), false);
    assert.strictEqual(vraccepted.isStale(), false);
    assert.strictEqual(vraccepted.getConfidence(), 0);

    const vr = new VoteRecord(false, 0);
    assert.strictEqual(vr.isAccepted(), false);
    assert.strictEqual(vr.getConfidence(), 0);

    // 6 yes votes before they count.
    for (let i = 0; i < 6; i++)
      check(vr, 0, false, false, false, 0);

    // The next flips the state; yes votes then build confidence.
    check(vr, 0, true, false, false, 0);

    // One neutral vote changes nothing.
    check(vr, NEUTRAL, true, false, false, 1);
    for (let i = 2; i < 8; i++)
      check(vr, 0, true, false, false, i);

    // Two stall it.
    check(vr, NEUTRAL, true, false, false, 7);
    check(vr, NEUTRAL, true, false, false, 7);
    for (let i = 2; i < 8; i++)
      check(vr, 0, true, false, false, 7);

    for (let i = 8; i < FINALIZATION_SCORE; i++)
      check(vr, 0, true, false, false, i);

    // The next vote finalizes.
    check(vr, 1, true, true, false, FINALIZATION_SCORE);

    // With two no votes, confidence stops growing.
    for (let i = 0; i < 5; i++)
      check(vr, 1, true, true, false, FINALIZATION_SCORE);

    // The next flips the state; no votes then build confidence.
    check(vr, 1, false, false, false, 0);

    check(vr, NEUTRAL, false, false, false, 1);
    for (let i = 2; i < 8; i++)
      check(vr, 1, false, false, false, i);

    check(vr, NEUTRAL, false, false, false, 7);
    check(vr, NEUTRAL, false, false, false, 7);
    for (let i = 2; i < 8; i++)
      check(vr, 1, false, false, false, 7);

    for (let i = 8; i < FINALIZATION_SCORE; i++)
      check(vr, 1, false, false, false, i);

    check(vr, 0, false, true, false, FINALIZATION_SCORE);
  });

  it('should account for polls in flight', () => {
    const vr = new VoteRecord(false, 0);

    for (let i = 0; i < 2 * MAX_INFLIGHT_POLL; i++) {
      const shouldPoll = vr.shouldPoll();
      assert.strictEqual(shouldPoll, i < MAX_INFLIGHT_POLL);
      assert.strictEqual(vr.registerPoll(), shouldPoll);
    }

    for (let i = 1; i < MAX_INFLIGHT_POLL; i++) {
      vr.clearInflightRequest(i);
      assert(vr.shouldPoll());

      for (let j = 1; j < i; j++) {
        assert(vr.registerPoll());
        assert(vr.shouldPoll());
      }

      assert(vr.registerPoll());
      assert(!vr.shouldPoll());
    }

    // No underflow.
    const vrunderflow = new VoteRecord(false, 0);
    vrunderflow.clearInflightRequest(MAX_INFLIGHT_POLL + 1);
    assert(vrunderflow.shouldPoll());
  });

  it('should go stale when always inconclusive', () => {
    const vr = new VoteRecord(false, 0);

    for (let i = 0; i < VOTE_STALE_THRESHOLD / 8; i++) {
      // Random votes, with enough neutral ones to never gain confidence.
      for (let j = 0; j < 6; j++)
        check(vr, random.randomInt(), false, false, false, 0);
      check(vr, NEUTRAL, false, false, false, 0);
      check(vr, NEUTRAL, false, false, false, 0);
    }

    check(vr, NEUTRAL, false, false, true, 0);
  });

  it('should go stale at every confidence level', () => {
    for (let vote = 0; vote <= 1; vote++) {
      for (let confidence = 0; confidence < FINALIZATION_SCORE; confidence++) {
        const vr = new VoteRecord(!vote, 0);
        const state = !vote;

        for (let i = 0; i < 5; i++)
          check(vr, vote, state, false, false, 0);

        for (let i = 0; i < confidence; i++)
          check(vr, vote, state, false, false, i);

        let remainingVotes = VOTE_STALE_THRESHOLD - confidence - 5;

        // Staying at confidence 1 needs another vote between agreeing ones.
        if (confidence === 1) {
          check(vr, NEUTRAL, state, false, false, 0);
          check(vr, vote, state, false, false, 1);
          remainingVotes -= 2;
        }

        if (confidence > VOTE_STALE_THRESHOLD / VOTE_STALE_FACTOR)
          remainingVotes = confidence * VOTE_STALE_FACTOR - confidence - 5;

        for (let i = 0; i < remainingVotes; i++)
          check(vr, NEUTRAL, state, false, false, confidence);

        check(vr, NEUTRAL, state, false, true, confidence);
      }
    }
  });

  it('should go stale after random then neutral votes', () => {
    const vr = new VoteRecord(false, 0);

    for (let i = 0; i < FINALIZATION_SCORE - 14; i++) {
      vr.registerVote(nextNodeId(), random.randomInt());
      assert.strictEqual(vr.hasFinalized(), false);
      assert.strictEqual(vr.isStale(), false);
    }

    // Reset confidence, whatever it is.
    for (let i = 0; i < 7; i++)
      vr.registerVote(nextNodeId(), 0);
    for (let i = 0; i < 7; i++)
      vr.registerVote(nextNodeId(), 1);

    assert.strictEqual(vr.hasFinalized(), false);
    assert.strictEqual(vr.isStale(), false);

    for (let i = 0; i < VOTE_STALE_THRESHOLD - FINALIZATION_SCORE; i++)
      check(vr, NEUTRAL, false, false, false, 1);

    check(vr, NEUTRAL, false, false, true, 1);
  });

  it('should go stale after confidence flips', () => {
    const staleAt = VOTE_STALE_THRESHOLD / VOTE_STALE_FACTOR;

    for (let voteInit = 0; voteInit <= 1; voteInit++) {
      for (let offset = 0; offset < FINALIZATION_SCORE; offset++) {
        let vote = voteInit;
        const vr = new VoteRecord(!vote, 0);
        let count = 0;

        for (let i = 0; i < offset; i++) {
          check(vr, NEUTRAL, !vote, false, false, 0);
          count++;
        }

        for (let i = 0; i < 5; i++) {
          check(vr, vote, !vote, false, false, 0);
          count++;
        }

        flips: for (;;) {
          // Build confidence as fast as possible.
          for (let i = 0; i < FINALIZATION_SCORE - 1; i++) {
            if (i <= staleAt && count >= VOTE_STALE_THRESHOLD) {
              check(vr, vote, !vote, false, true, i);
              break flips;
            }

            if (i > staleAt && count >= i * VOTE_STALE_FACTOR) {
              check(vr, vote, !vote, false, true, i);
              break flips;
            }

            check(vr, vote, !vote, false, false, i);
            count++;
          }

          // Flip the vote.
          vote = vote >= 1 ? 0 : 1;

          // Reset confidence.
          for (let i = 0; i < 6; i++) {
            if (count >= (FINALIZATION_SCORE - 1) * VOTE_STALE_FACTOR) {
              check(vr, vote, Boolean(vote), false, true, FINALIZATION_SCORE);
              break flips;
            }

            check(vr, vote, Boolean(vote), false, false,
              FINALIZATION_SCORE - 1);
            count++;
          }

          assert(count <= FINALIZATION_SCORE * VOTE_STALE_FACTOR);
        }

        assert(vr.isStale());
      }
    }
  });

  it('should not count duplicate votes', () => {
    const vr = new VoteRecord(true, 0);

    for (let i = 0; i < 7; i++) {
      assert.strictEqual(vr.getConfidence(), 0);
      assert(!vr.registerVote(nextNodeId(), 0));
    }
    assert.strictEqual(vr.getConfidence(), 1);

    // Duplicates do not build confidence.
    for (let i = 0; i < 8; i++) {
      assert(!vr.registerVote(currentNodeId, 0));
      assert.strictEqual(vr.getConfidence(), 1);
    }

    // Only the new voters, mixed in, do.
    let expected = 1;
    for (let i = 0; i < 8; i++) {
      assert(!vr.registerVote(currentNodeId, 0));
      assert.strictEqual(vr.getConfidence(), expected);
      for (let j = i; j < 8; j++) {
        assert(!vr.registerVote(nextNodeId(), 0));
        assert.strictEqual(vr.getConfidence(), ++expected);
      }
    }

    for (let i = 0; i < 90; i++) {
      assert(!vr.registerVote(nextNodeId(), 0));
      assert.strictEqual(vr.getConfidence(), ++expected);
    }

    // Finalizes on the expected vote.
    assert(vr.registerVote(nextNodeId(), 0));
    assert(vr.hasFinalized());
  });

  it('should say whether a vote would count', () => {
    const vr = new VoteRecord(true, random.randomInt());

    // Seven voters: none of them again, until an eighth votes.
    for (let id = 0; id < 7; id++)
      vr.registerVote(id, 0);
    for (let id = 0; id < 7; id++)
      assert(!vr.wouldCount(id));
    assert(vr.wouldCount(7));

    vr.registerVote(7, 0);
    assert(vr.wouldCount(0));
    assert(!vr.wouldCount(1));

    // As registerVote counts, for voters at random.
    for (let i = 0; i < 1000; i++) {
      const id = random.randomRange(0, 12);
      const counts = vr.wouldCount(id);
      const before = vr.successfulVotes;
      vr.registerVote(id, 0);
      assert.strictEqual(vr.successfulVotes > before, counts);
    }
  });
});
