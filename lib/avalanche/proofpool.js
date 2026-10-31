/*!
 * proofpool.js - avalanche proof pool for bcash
 * Copyright (c) 2026, Marianas Rai Corp (MIT License).
 * Ported from Bitcoin ABC's src/avalanche/proofpool.{h,cpp} and
 * proofcomparator.h.
 */

'use strict';

const Proof = require('./proof');

const {compareIds} = Proof;

/*
 * Constants
 */

const status = {
  REJECTED: 0,
  SUCCEED: 1,
  DUPLICATED: 2
};

/**
 * Proof Pool
 * Proofs by the coins they stake. No two proofs in a pool share a coin.
 * @alias module:avalanche.ProofPool
 */

class ProofPool {
  constructor() {
    // Outpoint key to proof.
    this.byOutpoint = new Map();
    // Proof id (hex) to proof.
    this.byId = new Map();
  }

  get size() {
    return this.byId.size;
  }

  has(id) {
    return this.byId.has(id.toString('hex'));
  }

  get(id) {
    return this.byId.get(id.toString('hex')) || null;
  }

  getByOutpoint(outpoint) {
    return this.byOutpoint.get(outpointKey(outpoint)) || null;
  }

  /**
   * Proofs in the pool that share a coin with a proof, best first.
   * @param {Proof} proof
   * @returns {Proof[]}
   */

  getConflicts(proof) {
    const conflicts = new Map();

    for (const {stake} of proof.stakes) {
      const other = this.getByOutpoint(stake.outpoint);
      if (other && !other.id().equals(proof.id()))
        conflicts.set(other.id().toString('hex'), other);
    }

    return [...conflicts.values()].sort(compareConflicting);
  }

  /**
   * Add a proof unless it shares a coin with one in the pool.
   * @param {Proof} proof
   * @returns {Array} [status, conflicts]
   */

  addIfNoConflict(proof) {
    if (this.has(proof.id()))
      return [status.DUPLICATED, []];

    const conflicts = this.getConflicts(proof);

    if (conflicts.length > 0)
      return [status.REJECTED, conflicts];

    for (const {stake} of proof.stakes)
      this.byOutpoint.set(outpointKey(stake.outpoint), proof);

    this.byId.set(proof.id().toString('hex'), proof);

    return [status.SUCCEED, []];
  }

  /**
   * Add a proof, replacing the ones it conflicts with if it is better
   * than all of them.
   * @param {Proof} proof
   * @returns {Array} [status, conflicts] - conflicts are those it
   * conflicted with, replaced or not.
   */

  addIfPreferred(proof) {
    const [result, conflicts] = this.addIfNoConflict(proof);

    if (result !== status.REJECTED)
      return [result, conflicts];

    // The best of the conflicting proofs beats it.
    if (compareConflicting(conflicts[0], proof) < 0)
      return [result, conflicts];

    for (const other of conflicts)
      this.remove(other.id());

    this.addIfNoConflict(proof);

    return [status.SUCCEED, conflicts];
  }

  remove(id) {
    const key = id.toString('hex');
    const proof = this.byId.get(key);

    if (!proof)
      return false;

    for (const {stake} of proof.stakes)
      this.byOutpoint.delete(outpointKey(stake.outpoint));

    this.byId.delete(key);

    return true;
  }

  /**
   * Empty the pool and return what was in it, for re-registering.
   * @returns {Proof[]}
   */

  clear() {
    const proofs = [...this.byId.values()];
    this.byOutpoint.clear();
    this.byId.clear();
    return proofs;
  }

  getLowestScoreProof() {
    let lowest = null;
    for (const proof of this.byId.values()) {
      if (!lowest || compareByScore(proof, lowest) > 0)
        lowest = proof;
    }
    return lowest;
  }

  ids() {
    return [...this.byId.values()].map(proof => proof.id());
  }

  values() {
    return this.byId.values();
  }
}

/*
 * Helpers
 */

function outpointKey(outpoint) {
  return outpoint.toKey().toString('hex');
}

/**
 * Bitcoin ABC's ProofComparatorByScore: higher score first, then the
 * lower id.
 * @param {Proof} a
 * @param {Proof} b
 * @returns {Number} Negative if a comes first.
 */

function compareByScore(a, b) {
  const sa = a.getScore();
  const sb = b.getScore();
  if (sa !== sb)
    return sa > sb ? -1 : 1;
  return compareIds(a.id(), b.id());
}

/**
 * Bitcoin ABC's ConflictingProofComparator: the preferred proof first.
 * The same master prefers the higher sequence; otherwise the higher
 * score, then fewer stakes, then the lower id.
 * @param {Proof} a
 * @param {Proof} b
 * @returns {Number} Negative if a is preferred.
 */

function compareConflicting(a, b) {
  if (a.master.equals(b.master) && a.sequence !== b.sequence)
    return a.sequence > b.sequence ? -1 : 1;

  const sa = a.getScore();
  const sb = b.getScore();
  if (sa !== sb)
    return sa > sb ? -1 : 1;

  if (a.stakes.length !== b.stakes.length)
    return a.stakes.length < b.stakes.length ? -1 : 1;

  return compareIds(a.id(), b.id());
}

/*
 * Expose
 */

ProofPool.status = status;
ProofPool.compareByScore = compareByScore;
ProofPool.compareConflicting = compareConflicting;

module.exports = ProofPool;
