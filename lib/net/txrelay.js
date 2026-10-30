/*!
 * txrelay.js - a page's unconfirmed transactions, to relay
 * Copyright (c) 2026, the bcash contributors (MIT License).
 * https://github.com/badger-cash/bcash
 */

'use strict';

/*
 * A page has no mempool: it cannot check a transaction's coins. A page
 * that serves other pages still passes unconfirmed transactions on, as
 * it hears them, to its page peers and to its full nodes, which check
 * them. It keeps them until a block confirms them or they are an hour
 * old, and at most a few megabytes of them.
 */

const assert = require('bsert');

const RELAY_BYTES = 5 * 1000 * 1000;
const RELAY_TTL = 60 * 60 * 1000;

/**
 * Unconfirmed transactions, oldest first.
 */

class TXRelay {
  /**
   * @param {Object} [options]
   * @param {Number} [options.bytes] - The most bytes kept.
   * @param {Number} [options.ttl] - How long one is kept (ms).
   */

  constructor(options = {}) {
    this.maxBytes = options.bytes != null ? options.bytes : RELAY_BYTES;
    this.ttl = options.ttl != null ? options.ttl : RELAY_TTL;
    assert(this.maxBytes > 0 && this.ttl > 0);
    // Hash (hex) to {tx, time, size}, oldest first.
    this.map = new Map();
    this.bytes = 0;
  }

  get size() {
    return this.map.size;
  }

  has(hash) {
    return this.map.has(hash.toString('hex'));
  }

  get(hash) {
    const item = this.map.get(hash.toString('hex'));
    return item ? item.tx : null;
  }

  /**
   * Keep a transaction, if new; the oldest go past the limits.
   * @param {TX} tx
   * @param {Number} [now] - ms.
   * @returns {Boolean} - Whether it was new.
   */

  add(tx, now = Date.now()) {
    this.expire(now);

    const key = tx.hash().toString('hex');

    if (this.map.has(key))
      return false;

    const size = tx.getSize();

    if (size > this.maxBytes)
      return false;

    this.map.set(key, {tx, time: now, size});
    this.bytes += size;

    while (this.bytes > this.maxBytes)
      this.remove(Buffer.from(this.map.keys().next().value, 'hex'));

    return true;
  }

  remove(hash) {
    const key = hash.toString('hex');
    const item = this.map.get(key);

    if (!item)
      return;

    this.map.delete(key);
    this.bytes -= item.size;
  }

  /**
   * Forget what a block confirms.
   * @param {Block} block
   */

  removeBlock(block) {
    for (const tx of block.txs)
      this.remove(tx.hash());
  }

  /**
   * Forget what is too old.
   * @param {Number} [now] - ms.
   */

  expire(now = Date.now()) {
    for (const [key, item] of this.map) {
      if (now - item.time < this.ttl)
        break;
      this.map.delete(key);
      this.bytes -= item.size;
    }
  }

  /**
   * The transactions kept, oldest first.
   * @returns {TX[]}
   */

  toArray() {
    this.expire();
    return [...this.map.values()].map(item => item.tx);
  }
}

/*
 * Expose
 */

exports.RELAY_BYTES = RELAY_BYTES;
exports.RELAY_TTL = RELAY_TTL;
exports.TXRelay = TXRelay;
