/*!
 * history.js - blocks from before a page's chain begins
 * Copyright (c) 2026, Vin Armani (MIT License).
 * https://github.com/badger-cash/bcash
 */

'use strict';

/*
 * A page's chain starts at an anchor, the newest checkpoint built in, and
 * holds no header below it. An imported key may hold coins from before,
 * and a token's history may reach back past it: those blocks are scanned
 * all the same, by their hashes, proven another way.
 *
 * Between two points the wallet trusts (the genesis, each checkpoint built
 * into bcash, and the anchor), the headers are fetched from a peer, each
 * building on the one before, the last the next trusted point: so they
 * are as sure as those points (pool.fetchHeaders). A stretch so proven is
 * kept for the session. A merkle block scanned for a height must hash to
 * the block proven there (pool.scanRange, with entries), which is how its
 * transactions are known to be in it.
 *
 * scanBlocks takes any range, below the anchor, above it, or across it:
 * above, from the chain's own headers, as before.
 *
 * A page may also trust a block of its own, by height and hash (trust()):
 * a block its host names, such as the one holding a token's genesis. That
 * block is its own proof, as a checkpoint is: scanning it needs no header
 * at all, since the merkle block got for it must hash to it. And it stands
 * between stretches like any trusted point, so the headers fetched around
 * it are fewer.
 */

const assert = require('bsert');

class History {
  /**
   * @param {Object} options
   * @param {SPVNode} options.node
   */

  constructor({node, trusted = []}) {
    this.node = node;
    this.stretches = new Map();
    this.trusted = new Map();
    for (const point of trusted)
      this.trust(point);
  }

  /**
   * Trust a block by its height and hash (as explorers show it), as a
   * checkpoint is trusted: below the anchor, it is proven by its hash.
   * @param {Object} point - {height, hash}
   */

  trust({height, hash}) {
    assert((height >>> 0) === height, 'A trusted block needs a height.');
    assert(typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash),
      'A trusted block needs its hash, 64 hex digits.');
    this.trusted.set(height, Buffer.from(hash, 'hex').reverse());
    this.stretches.clear();
  }

  /**
   * The anchor: the lowest block the chain holds that it trusts.
   * @returns {Object} {height, hash (Buffer)}
   */

  get anchor() {
    const anchor = this.node.chain.options.anchor;
    if (!anchor || !anchor.trusted)
      return {height: -1, hash: null};
    return {
      height: anchor.trusted.height,
      hash: Buffer.from(anchor.trusted.hash, 'hex').reverse()
    };
  }

  /**
   * The lowest height the chain holds: the anchor's, less the blocks
   * before it kept for median time. From there up, the chain's headers.
   */

  get floor() {
    const anchor = this.node.chain.options.anchor;
    return anchor ? anchor.height : 0;
  }

  /**
   * The points trusted below the anchor, in order: the genesis, each
   * checkpoint, each block trusted, the anchor.
   * @returns {Object[]} [{height, hash}]
   */

  points() {
    const {network} = this.node;
    const anchor = this.anchor;
    const points = [{height: 0, hash: network.genesis.hash}];
    const seen = new Set([0]);

    for (const [height, hash] of Object.entries(network.checkpointMap)) {
      const h = Number(height);
      if (h > 0 && h < anchor.height) {
        points.push({height: h, hash});
        seen.add(h);
      }
    }

    for (const [h, hash] of this.trusted) {
      if (h > 0 && h < anchor.height && !seen.has(h))
        points.push({height: h, hash});
    }

    points.push(anchor);
    points.sort((a, b) => a.height - b.height);

    return points;
  }

  /**
   * The proven hashes of one stretch, from a trusted point to the next.
   * @returns {Promise} [{height, hash}] after `from`, ending at `to`.
   */

  async stretch(from, to) {
    const key = `${from.height}-${to.height}`;
    const kept = this.stretches.get(key);
    if (kept)
      return kept;

    const hashes = await this.node.pool.fetchHeaders(from.hash, to.hash);
    assert(hashes.length === to.height - from.height,
      'Headers between checkpoints did not count up.');

    const entries = hashes.map((hash, i) => ({
      height: from.height + 1 + i,
      hash
    }));

    this.stretches.set(key, entries);
    return entries;
  }

  /**
   * Proven blocks below (and at) the anchor, from `lo` to `hi`.
   * @returns {Promise} [{height, hash}]
   */

  async below(lo, hi) {
    // Every block wanted trusted: each its own proof, no header fetched.
    const wanted = [];
    for (let h = lo; h <= hi && this.trusted.has(h); h++)
      wanted.push({height: h, hash: this.trusted.get(h)});
    if (wanted.length === hi - lo + 1)
      return wanted;

    const points = this.points();
    const entries = [];

    for (let i = 0; i + 1 < points.length; i++) {
      const from = points[i];
      const to = points[i + 1];
      if (to.height < lo || from.height + 1 > hi)
        continue;
      for (const entry of await this.stretch(from, to)) {
        if (entry.height >= lo && entry.height <= hi)
          entries.push(entry);
      }
    }

    return entries;
  }

  /**
   * Scan blocks for what a filter matches, at any heights: below the
   * anchor by their proven hashes, above it from the chain.
   * @param {Object} options
   * @param {Number} options.start
   * @param {Number} options.end
   * @param {BloomFilter} options.filter
   * @param {Function} iter - async (entry, block): entry {height, hash,
   *   time}, block a MerkleBlock whose txs are the matched transactions.
   * @returns {Promise}
   */

  async scanBlocks({start, end, filter}, iter) {
    const anchor = this.anchor.height;
    // What the chain holds is scanned from it; only what is lower needs
    // headers proven between checkpoints.
    const below = Math.min(anchor, this.floor - 1);

    const each = (entry, block) => iter({
      height: entry.height,
      hash: entry.hash,
      // Its own header's: an entry below the anchor carries none.
      time: entry.time != null ? entry.time : block.time
    }, block);

    // Below the anchor, a stretch at a time: none is held longer than it
    // takes to scan.
    if (start <= below) {
      const points = this.points();
      for (let i = 0; i + 1 < points.length; i++) {
        const lo = Math.max(start, points[i].height + 1);
        const hi = Math.min(end, below, points[i + 1].height);
        if (lo > hi)
          continue;
        const entries = await this.below(lo, hi);
        if (entries.length > 0)
          await this.node.pool.scanRange({entries, filter}, each);
      }
    }

    const lo = Math.max(start, below + 1);
    if (lo <= end)
      await this.node.pool.scanRange({start: lo, end, filter}, each);
  }
}

exports.History = History;
