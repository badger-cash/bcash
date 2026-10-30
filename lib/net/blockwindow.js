/*!
 * blockwindow.js - a page's recent whole blocks
 * Copyright (c) 2026, the bcash contributors (MIT License).
 * https://github.com/badger-cash/bcash
 */

'use strict';

/*
 * An SPV node keeps no blocks, only what its filter matched. A page that
 * should serve other pages keeps the newest of its chain's blocks whole:
 * at most a number of them, and at most a number of bytes, whichever is
 * fewer. From them it answers peers' requests for blocks and for blocks
 * filtered for them, as a full node does.
 */

const assert = require('bsert');

// As BIP 159's NODE_NETWORK_LIMITED: the last 288 blocks, about 2 days.
const WINDOW_BLOCKS = 288;
const WINDOW_BYTES = 25 * 1000 * 1000;

/**
 * The newest blocks, by hash and height.
 */

class BlockWindow {
  /**
   * @param {Object} [options]
   * @param {Number} [options.blocks] - The most blocks kept.
   * @param {Number} [options.bytes] - The most bytes kept.
   */

  constructor(options = {}) {
    this.maxBlocks = options.blocks != null ? options.blocks : WINDOW_BLOCKS;
    this.maxBytes = options.bytes != null ? options.bytes : WINDOW_BYTES;
    assert(this.maxBlocks > 0 && this.maxBytes > 0);
    // Hash (hex) to {height, raw}; height to hash (hex).
    this.blocks = new Map();
    this.heights = new Map();
    this.bytes = 0;
  }

  get size() {
    return this.blocks.size;
  }

  has(hash) {
    return this.blocks.has(hash.toString('hex'));
  }

  /**
   * A block's raw bytes, if kept.
   * @param {Hash} hash
   * @returns {Buffer|null}
   */

  get(hash) {
    const item = this.blocks.get(hash.toString('hex'));
    return item ? item.raw : null;
  }

  /**
   * The lowest height kept, or -1.
   * @returns {Number}
   */

  low() {
    let low = -1;
    for (const height of this.heights.keys()) {
      if (low === -1 || height < low)
        low = height;
    }
    return low;
  }

  /**
   * The highest height kept, or -1.
   * @returns {Number}
   */

  high() {
    let high = -1;
    for (const height of this.heights.keys())
      high = Math.max(high, height);
    return high;
  }

  /**
   * Whether the window has no room for a block this old: it is full and
   * the block is below what it holds.
   * @param {Number} height
   * @returns {Boolean}
   */

  isFullBelow(height) {
    if (this.blocks.size < this.maxBlocks && this.bytes < this.maxBytes)
      return false;
    const low = this.low();
    return low !== -1 && height < low;
  }

  /**
   * Keep a block, dropping the lowest past either limit.
   * @param {Number} height
   * @param {Hash} hash
   * @param {Buffer} raw
   * @returns {Boolean} - Whether it was kept.
   */

  add(height, hash, raw) {
    const key = hash.toString('hex');

    if (this.blocks.has(key))
      return true;

    // One block past the limit by itself: never kept.
    if (raw.length > this.maxBytes)
      return false;

    // Another block at that height (a reorganization): replaced.
    const old = this.heights.get(height);
    if (old)
      this.remove(Buffer.from(old, 'hex'));

    this.blocks.set(key, {height, raw});
    this.heights.set(height, key);
    this.bytes += raw.length;

    while (this.blocks.size > this.maxBlocks || this.bytes > this.maxBytes) {
      const low = this.low();
      const lowest = this.heights.get(low);
      this.remove(Buffer.from(lowest, 'hex'));
      if (lowest === key)
        return false;
    }

    return true;
  }

  /**
   * Forget a block.
   * @param {Hash} hash
   */

  remove(hash) {
    const key = hash.toString('hex');
    const item = this.blocks.get(key);

    if (!item)
      return;

    this.blocks.delete(key);
    if (this.heights.get(item.height) === key)
      this.heights.delete(item.height);
    this.bytes -= item.raw.length;
  }
}

/*
 * Expose
 */

exports.WINDOW_BLOCKS = WINDOW_BLOCKS;
exports.WINDOW_BYTES = WINDOW_BYTES;
exports.BlockWindow = BlockWindow;
