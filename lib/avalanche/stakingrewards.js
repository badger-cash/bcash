/*!
 * stakingrewards.js - avalanche staking reward winners for bcash
 * Copyright (c) 2026, Marianas Rai Corp (MIT License).
 * Ported from Bitcoin ABC's PeerManager::selectStakingRewardWinner, in
 * src/avalanche/peermanager.cpp, and src/avalanche/stakecontender.h.
 */

'use strict';

const assert = require('bsert');
const hash256 = require('bcrypto/lib/hash256');
const {compareIds} = require('./proof');

/*
 * Constants
 */

// Share of the block reward, in percent, the winner is paid.
const STAKING_REWARD_RATIO = 10;

const ZERO_HASH = Buffer.alloc(32, 0x00);

/**
 * The contender id of a proof for the block after `prevHash`.
 * @param {Hash} prevHash
 * @param {Hash} proofId
 * @returns {Hash}
 */

function contenderId(prevHash, proofId) {
  return hash256.digest(Buffer.concat([prevHash, proofId]));
}

/**
 * Bitcoin ABC's ComputeProofRewardRank: the contender id as a fraction of
 * 2^256, its log, over the proof's score, so the lowest rank wins with
 * odds by stake.
 * @param {Hash} id
 * @param {Number} score
 * @returns {Number}
 */

function rewardRank(id, score) {
  return (256 - Math.log2(uint256ToDouble(id))) / score;
}

// arith_uint256::getdouble: the 32 bit words, least first, as doubles.
function uint256ToDouble(hash) {
  let ret = 0;
  let fact = 1;
  for (let i = 0; i < 32; i += 4) {
    ret += fact * hash.readUInt32LE(i);
    fact *= 4294967296;
  }
  return ret;
}

// Bitcoin ABC's RewardRankComparator: lower rank, then contender id, then
// proof id. Negative if a is better.
function compareRanks(a, b) {
  if (a.rank !== b.rank)
    return a.rank < b.rank ? -1 : 1;

  const ids = compareIds(a.contender, b.contender);
  if (ids !== 0)
    return ids;

  return compareIds(a.proofId, b.proofId);
}

/**
 * Select the staking reward winners for the block after `prev`: the
 * winner first, then the alternatives a validator also accepts.
 * @param {PeerManager} pm
 * @param {ChainEntry} prev
 * @param {Number} now - Seconds.
 * @param {Object} [options]
 * @param {Function} [options.isFlaky] - (proofId) => Boolean; the peer
 * manager's by default.
 * @param {Set} [options.rejected] - Proof ids (hex) rejected as contenders.
 * @returns {Array|null} [{proofId, payout}], or null if none qualifies.
 */

function selectWinners(pm, prev, now, options = {}) {
  assert(prev);

  const isFlaky = options.isFlaky || (id => pm.isFlaky(id));
  const rejected = options.rejected || new Set();

  // Proofs known long enough before the previous block (whose time is
  // capped to now): twice the dangling timeout at least, four to be the
  // winner, six to rule out the rest.
  // Required here: the peer manager requires this module.
  const dangling = require('./peermanager').DANGLING_TIMEOUT;
  const refTime = Math.min(prev.time, now);

  const targetTime = refTime - 4 * dangling;
  const maxTime = refTime - 2 * dangling;
  const minTime = refTime - 6 * dangling;

  const peers = [...pm.peers.values()];
  const selected = [];
  let firstCompliant = null;

  while (selected.length < peers.length) {
    let best = null;

    for (const peer of peers) {
      if (!peer.hasFinalized || peer.registrationTime >= maxTime)
        continue;

      const proofId = peer.proof.id();

      if (selected.some(s => s.proof.id().equals(proofId)))
        continue;

      const contender = contenderId(prev.hash, proofId);

      // A zero hash is either very lucky or abuse: skip it.
      if (contender.equals(ZERO_HASH))
        continue;

      const candidate = {
        peer,
        proof: peer.proof,
        proofId,
        contender,
        rank: rewardRank(contender, peer.proof.getScore())
      };

      if (!best || compareRanks(candidate, best) < 0)
        best = candidate;
    }

    if (!best)
      break;

    if (!firstCompliant && best.peer.registrationTime < targetTime)
      firstCompliant = best;

    selected.push(best);

    // Known long enough, and neither flaky nor rejected: the others need
    // not be considered.
    const key = best.proofId.toString('hex');
    if (best.peer.registrationTime < minTime
        && !isFlaky(best.proofId)
        && !rejected.has(key)) {
      break;
    }
  }

  if (!firstCompliant)
    return null;

  const winners = [];
  const entry = s => ({proofId: s.proofId, payout: s.proof.payout});

  winners.push(entry(firstCompliant));

  for (const s of selected) {
    if (!s.proofId.equals(firstCompliant.proofId))
      winners.push(entry(s));
  }

  return winners;
}

/**
 * The least a coinbase must pay the staking reward winner.
 * @param {Number} reward - Subsidy and fees.
 * @returns {Number}
 */

function getStakingRewardAmount(reward) {
  return Math.floor(STAKING_REWARD_RATIO * reward / 100);
}

/*
 * Expose
 */

exports.STAKING_REWARD_RATIO = STAKING_REWARD_RATIO;
exports.contenderId = contenderId;
exports.rewardRank = rewardRank;
exports.uint256ToDouble = uint256ToDouble;
exports.compareRanks = compareRanks;
exports.selectWinners = selectWinners;
exports.getStakingRewardAmount = getStakingRewardAmount;
