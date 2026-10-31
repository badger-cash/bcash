/*!
 * txconflicting.js - transactions conflicting with the mempool
 * Copyright (c) 2026, Marianas Rai Corp (MIT License).
 * Ported from Bitcoin ABC's src/txconflicting.h and src/txpool.cpp.
 */

'use strict';

const assert = require('bsert');
const {BufferMap} = require('buffer-map');
const random = require('bcrypto/lib/random');
const policy = require('../protocol/policy');

/*
 * Constants
 */

// Bitcoin ABC's CONFLICTING_TX_EXPIRE_TIME and _INTERVAL, in seconds.
const EXPIRE_TIME = 20 * 60;
const EXPIRE_INTERVAL = 5 * 60;

// Bitcoin ABC's DEFAULT_MAX_CONFLICTING_TRANSACTIONS.
const MAX_TXS = 100;

/**
 * Conflicting Transactions
 * Transactions that spend what a mempool transaction spends: Bitcoin ABC
 * keeps them, for avalanche may yet accept one over the mempool's.
 */

class TxConflicting {
  /**
   * @param {Object} [options]
   * @param {Function} [options.now] - Seconds.
   * @param {Number} [options.maxTxs]
   */

  constructor(options = {}) {
    this.now = options.now || (() => Math.floor(Date.now() / 1000));
    this.maxTxs = options.maxTxs != null ? options.maxTxs : MAX_TXS;
    // Txid to {tx, expires}.
    this.txs = new BufferMap();
    // Outpoint key to Set of txids spending it.
    this.spenders = new Map();
    this.nextSweep = 0;
  }

  get size() {
    return this.txs.size;
  }

  has(hash) {
    return this.txs.has(hash);
  }

  getTX(hash) {
    const item = this.txs.get(hash);
    return item ? item.tx : null;
  }

  /**
   * Keep a transaction, unless it is too large to be standard.
   * @param {TX} tx
   * @returns {Boolean}
   */

  add(tx) {
    const hash = tx.hash();

    if (this.txs.has(hash))
      return false;

    if (tx.getSize() > policy.MAX_TX_SIZE)
      return false;

    this.txs.set(hash, {tx, expires: this.now() + EXPIRE_TIME});

    for (const {prevout} of tx.inputs) {
      const key = prevout.toKey().toString('hex');
      let set = this.spenders.get(key);
      if (!set) {
        set = new Set();
        this.spenders.set(key, set);
      }
      set.add(hash.toString('hex'));
    }

    return true;
  }

  remove(hash) {
    const item = this.txs.get(hash);

    if (!item)
      return false;

    this.txs.delete(hash);

    for (const {prevout} of item.tx.inputs) {
      const key = prevout.toKey().toString('hex');
      const set = this.spenders.get(key);
      if (!set)
        continue;
      set.delete(hash.toString('hex'));
      if (set.size === 0)
        this.spenders.delete(key);
    }

    return true;
  }

  /**
   * The kept transactions that spend what `tx` spends.
   * @param {TX} tx
   * @returns {TX[]}
   */

  getConflicts(tx) {
    const result = [];
    const seen = new Set();

    for (const {prevout} of tx.inputs) {
      const set = this.spenders.get(prevout.toKey().toString('hex'));
      if (!set)
        continue;
      for (const key of set) {
        if (seen.has(key))
          continue;
        seen.add(key);
        result.push(this.txs.get(Buffer.from(key, 'hex')).tx);
      }
    }

    return result;
  }

  /**
   * Forget expired transactions, at most every few minutes, then evict
   * at random down to the limit, as Bitcoin ABC's LimitTxs.
   * @returns {Number} How many were removed.
   */

  limit() {
    const now = this.now();
    let removed = 0;

    if (this.nextSweep <= now) {
      let next = now + EXPIRE_TIME - EXPIRE_INTERVAL;

      for (const [hash, item] of [...this.txs]) {
        if (item.expires <= now) {
          this.remove(hash);
          removed += 1;
        } else {
          next = Math.min(next, item.expires);
        }
      }

      this.nextSweep = next + EXPIRE_INTERVAL;
    }

    while (this.txs.size > this.maxTxs) {
      const hashes = [...this.txs.keys()];
      const pick = hashes[random.randomRange(0, hashes.length)];
      assert(this.remove(pick));
      removed += 1;
    }

    return removed;
  }
}

/*
 * Expose
 */

TxConflicting.EXPIRE_TIME = EXPIRE_TIME;
TxConflicting.EXPIRE_INTERVAL = EXPIRE_INTERVAL;
TxConflicting.MAX_TXS = MAX_TXS;

module.exports = TxConflicting;
