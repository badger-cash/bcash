/*!
 * voterecord.js - avalanche vote record for bcash
 * Copyright (c) 2026, Marianas Rai Corp (MIT License).
 * Ported from Bitcoin ABC's src/avalanche/voterecord.{h,cpp}.
 */

'use strict';

const assert = require('bsert');
const random = require('bcrypto/lib/random');

/*
 * Constants
 */

// Confidence at which a decision is final.
const FINALIZATION_SCORE = 128;

// Votes after which an item that is not finalizing is stale...
const VOTE_STALE_THRESHOLD = 4096;

// ...the least a node may configure that to be...
const VOTE_STALE_MIN_THRESHOLD = 140;

// ...and, past that, votes per point of confidence.
const VOTE_STALE_FACTOR = 64;

// Most polls one item may have in flight.
const MAX_INFLIGHT_POLL = 10;

const U64 = (1n << 64n) - 1n;

/**
 * Vote Record
 * Votes on one item, and the confidence they give its state.
 * @alias module:avalanche.VoteRecord
 */

class VoteRecord {
  /**
   * @param {Boolean} accepted - Initial state.
   * @param {Number} [seed] - For the voter filter; random if omitted.
   */

  constructor(accepted, seed) {
    if (seed == null)
      seed = random.randomInt();

    assert((seed >>> 0) === seed);

    // Low bit is the state; the rest is confidence.
    this.confidence = accepted ? 1 : 0;
    // Last 8 votes: yes bits, and whether each was conclusive.
    this.votes = 0;
    this.consider = 0;
    this.inflight = 0;
    this.seed = seed;
    this.successfulVotes = 0;
    // Hashes of the last 8 voters.
    this.nodeFilter = new Uint16Array(8);
  }

  isAccepted() {
    return (this.confidence & 1) === 1;
  }

  getConfidence() {
    return this.confidence >>> 1;
  }

  hasFinalized() {
    return this.getConfidence() >= FINALIZATION_SCORE;
  }

  isStale(threshold = VOTE_STALE_THRESHOLD, factor = VOTE_STALE_FACTOR) {
    return this.successfulVotes > threshold
      && this.successfulVotes > this.getConfidence() * factor;
  }

  /**
   * Count a node's vote.
   * @param {Number} nodeId
   * @param {Number} error - 0 is yes; other values with the high bit
   * clear are no; those with it set are neutral.
   * @returns {Boolean} Whether the state changed or just finalized.
   */

  registerVote(nodeId, error) {
    assert((error >>> 0) === error);

    // One less poll in flight.
    this.clearInflightRequest();

    // A node gets one vote in any 8.
    if (!this.addNodeToQuorum(nodeId))
      return false;

    this.votes = ((this.votes << 1) | (error === 0)) & 0xff;
    this.consider = ((this.consider << 1) | ((error & 0x80000000) === 0))
      & 0xff;

    const yes = countBits(this.votes & this.consider) > 6;

    if (!yes) {
      const no = countBits(~this.votes & this.consider & 0xff) > 6;
      // Inconclusive.
      if (!no)
        return false;
    }

    // Agreement with the state builds confidence.
    if (this.isAccepted() === yes) {
      this.confidence = (this.confidence + 2) & 0xffff;
      return this.getConfidence() === FINALIZATION_SCORE;
    }

    // Disagreement flips it and starts over.
    this.confidence = yes ? 1 : 0;
    return true;
  }

  /**
   * Add a voter to the filter.
   * @private
   * @param {Number} nodeId
   * @returns {Boolean} False if it voted in the last 8.
   */

  addNodeToQuorum(nodeId) {
    const h = this.nodeHash(nodeId);
    const filter = this.nodeFilter;

    for (let i = 1; i < filter.length; i++) {
      if (filter[(this.successfulVotes + i) % filter.length] === h)
        return false;
    }

    filter[this.successfulVotes % filter.length] = h;
    this.successfulVotes += 1;

    return true;
  }

  /**
   * Count a poll for this item, if another may be in flight.
   * @returns {Boolean}
   */

  /**
   * Whether a vote from the node would count now: it is not one of the
   * last 7 that did.
   * @param {Number} nodeId
   * @returns {Boolean}
   */

  wouldCount(nodeId) {
    const h = this.nodeHash(nodeId);
    const filter = this.nodeFilter;

    for (let i = 1; i < filter.length; i++) {
      if (filter[(this.successfulVotes + i) % filter.length] === h)
        return false;
    }

    return true;
  }

  /**
   * @private
   */

  nodeHash(nodeId) {
    const id = BigInt.asUintN(64, BigInt(nodeId));

    // MMIX linear congruential generator, and Fibonacci hashing.
    const r1 = (6364136223846793005n * id + 1442695040888963407n) & U64;
    const r2 = (11400714819323198485n * (id ^ BigInt(this.seed))) & U64;
    return Number(((r1 + r2) & U64) >> 48n);
  }

  registerPoll() {
    if (this.inflight >= MAX_INFLIGHT_POLL)
      return false;
    this.inflight += 1;
    return true;
  }

  shouldPoll() {
    return this.inflight < MAX_INFLIGHT_POLL;
  }

  clearInflightRequest(count = 1) {
    this.inflight -= Math.min(this.inflight, count);
  }
}

/*
 * Helpers
 */

function countBits(x) {
  let n = 0;
  for (; x; x &= x - 1)
    n += 1;
  return n;
}

/*
 * Expose
 */

VoteRecord.FINALIZATION_SCORE = FINALIZATION_SCORE;
VoteRecord.VOTE_STALE_THRESHOLD = VOTE_STALE_THRESHOLD;
VoteRecord.VOTE_STALE_MIN_THRESHOLD = VOTE_STALE_MIN_THRESHOLD;
VoteRecord.VOTE_STALE_FACTOR = VOTE_STALE_FACTOR;
VoteRecord.MAX_INFLIGHT_POLL = MAX_INFLIGHT_POLL;

module.exports = VoteRecord;
