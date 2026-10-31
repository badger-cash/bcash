/*!
 * stakecontendercache.js - avalanche stake contenders for bcash
 * Copyright (c) 2026, Marianas Rai Corp (MIT License).
 * Ported from Bitcoin ABC's src/avalanche/stakecontendercache.cpp.
 */

'use strict';

const {
  contenderId,
  rewardRank,
  compareRanks
} = require('./stakingrewards');

/*
 * Constants
 */

// A contender's status: avalanche accepted it, and it is to be one of the
// block's staking reward winners.
const status = {
  UNKNOWN: 0,
  ACCEPTED: 1 << 0,
  IN_WINNER_SET: 1 << 1
};

/**
 * Stake Contender Cache
 * The proofs that may win the staking reward of the block after each
 * recent block, as Bitcoin ABC keeps them for staking pre-consensus.
 * Each is a stake contender: its id is hash256(prevblockhash, proofid).
 */

class StakeContenderCache {
  constructor() {
    // Contender id (hex) to entry.
    this.contenders = new Map();
    // Previous block hash (hex) to {height, payouts}: winners set by hand.
    this.manualWinners = new Map();
    this.lastPromotedHeight = 0;
  }

  /**
   * Forget the contenders and winners of blocks below a height, but not
   * past the last height promoted to, not to lose what is cached of
   * proofs no longer known.
   * @param {Number} requestedMinHeight
   */

  cleanup(requestedMinHeight) {
    const minHeight = Math.min(this.lastPromotedHeight, requestedMinHeight);
    const hashes = new Set();

    for (const [key, winners] of this.manualWinners) {
      if (winners.height < minHeight)
        hashes.add(key);
    }

    for (const entry of this.contenders.values()) {
      if (entry.height < minHeight)
        hashes.add(entry.prevHash.toString('hex'));
    }

    for (const key of hashes)
      this.manualWinners.delete(key);

    for (const [key, entry] of this.contenders) {
      if (hashes.has(entry.prevHash.toString('hex')))
        this.contenders.delete(key);
    }
  }

  /**
   * Add a proof as a contender for the block after `prev`.
   * @param {ChainEntry} prev - Its hash, height and time.
   * @param {Proof} proof
   * @param {Number} [state=UNKNOWN]
   * @returns {Boolean} False if it was already one.
   */

  add(prev, proof, state = status.UNKNOWN) {
    return this.insert(createEntry(prev, proof.id(), state,
      proof.payout, proof.getScore()));
  }

  /**
   * Carry the contenders that are still valid proofs over to the block
   * after `tip`, with their payouts and scores: a proof the peer manager
   * no longer keeps (a remote one) still has them here.
   * @param {ChainEntry} tip
   * @param {Function} shouldPromote - (proofId) => Boolean.
   */

  promoteToBlock(tip, shouldPromote) {
    this.lastPromotedHeight = tip.height;

    const promoted = [];

    for (const entry of this.contenders.values()) {
      if (shouldPromote(entry.proofId)) {
        promoted.push(createEntry(tip, entry.proofId, status.UNKNOWN,
          entry.payout, entry.score));
      }
    }

    for (const entry of promoted)
      this.insert(entry);
  }

  /**
   * Set the winners of the block after `prev` by hand.
   * @param {ChainEntry} prev
   * @param {Script[]} payouts
   * @returns {Boolean}
   */

  setWinners(prev, payouts) {
    this.manualWinners.set(prev.hash.toString('hex'),
      {height: prev.height, payouts: payouts.slice()});
    return true;
  }

  accept(id) {
    return this.modify(id, s => s | status.ACCEPTED);
  }

  finalize(id) {
    return this.modify(id, s => s | status.ACCEPTED | status.IN_WINNER_SET);
  }

  reject(id) {
    return this.modify(id, s => s & ~status.ACCEPTED);
  }

  /**
   * How to vote on a contender: -1 if unknown, 0 if accepted or a manual
   * winner's payout, 1 otherwise.
   * @param {Hash} id
   * @returns {Object|null} {prevHash, prevTime, proofId, voteStatus}
   */

  getContenderInfo(id) {
    const entry = this.contenders.get(id.toString('hex'));

    if (!entry)
      return null;

    const info = {
      prevHash: entry.prevHash,
      prevTime: entry.prevTime,
      proofId: entry.proofId,
      voteStatus: 1
    };

    if (isAccepted(entry)) {
      info.voteStatus = 0;
      return info;
    }

    const manual = this.manualWinners.get(entry.prevHash.toString('hex'));

    if (manual) {
      const raw = entry.payout.toRaw();
      if (manual.payouts.some(p => p.toRaw().equals(raw)))
        info.voteStatus = 0;
    }

    return info;
  }

  /**
   * @param {Hash} id
   * @returns {Object} {voteStatus, prevHash}; -1 and null if unknown.
   */

  getVoteStatus(id) {
    const info = this.getContenderInfo(id);

    if (!info)
      return {voteStatus: -1, prevHash: null};

    return {voteStatus: info.voteStatus, prevHash: info.prevHash};
  }

  /**
   * The contenders to poll for the block after `prevHash`: accepted ones
   * first, then the best ranked, up to `maxPollable`, best ranked first.
   * @param {Hash} prevHash
   * @param {Number} maxPollable
   * @returns {Hash[]} Contender ids.
   */

  getPollableContenders(prevHash, maxPollable) {
    const ranked = this.forBlock(prevHash).sort(compareAcceptedThenRank);
    const pollable = ranked.slice(0, Math.min(ranked.length, maxPollable));
    pollable.sort(compareRank);
    return pollable.map(entry => entry.id);
  }

  /**
   * The winners of the block after `prevHash`: manual ones first, in
   * order, then those avalanche put in the winner set, accepted first,
   * then by rank.
   * @param {Hash} prevHash
   * @returns {Object[]} [{proofId, payout}]; proofId null for manual.
   */

  getWinners(prevHash) {
    const ranked = this.forBlock(prevHash)
      .filter(isInWinnerSet)
      .sort(compareAcceptedThenRank);

    const winners = [];
    const manual = this.manualWinners.get(prevHash.toString('hex'));

    if (manual) {
      for (const payout of manual.payouts)
        winners.push({proofId: null, payout});
    }

    for (const entry of ranked)
      winners.push({proofId: entry.proofId, payout: entry.payout});

    return winners;
  }

  hasAcceptedWinner(prevHash) {
    return this.forBlock(prevHash)
      .some(entry => isInWinnerSet(entry) && isAccepted(entry));
  }

  /*
   * Helpers
   */

  insert(entry) {
    const key = entry.id.toString('hex');

    if (this.contenders.has(key))
      return false;

    this.contenders.set(key, entry);
    return true;
  }

  modify(id, fn) {
    const entry = this.contenders.get(id.toString('hex'));

    if (!entry)
      return false;

    entry.status = fn(entry.status);
    return true;
  }

  forBlock(prevHash) {
    const entries = [];
    for (const entry of this.contenders.values()) {
      if (entry.prevHash.equals(prevHash))
        entries.push(entry);
    }
    return entries;
  }
}

/*
 * Helpers
 */

function createEntry(prev, proofId, state, payout, score) {
  const id = contenderId(prev.hash, proofId);
  return {
    id,
    prevHash: prev.hash,
    height: prev.height,
    prevTime: prev.time,
    proofId,
    status: state,
    payout,
    score,
    rank: rewardRank(id, score)
  };
}

function isAccepted(entry) {
  return (entry.status & status.ACCEPTED) !== 0;
}

function isInWinnerSet(entry) {
  return (entry.status & status.IN_WINNER_SET) !== 0;
}

// Bitcoin ABC's RewardRankComparator, on cache entries.
function compareRank(a, b) {
  return compareRanks({rank: a.rank, contender: a.id, proofId: a.proofId},
    {rank: b.rank, contender: b.id, proofId: b.proofId});
}

function compareAcceptedThenRank(a, b) {
  if (isAccepted(a) !== isAccepted(b))
    return isAccepted(a) ? -1 : 1;
  return compareRank(a, b);
}

/*
 * Expose
 */

StakeContenderCache.status = status;

module.exports = StakeContenderCache;
