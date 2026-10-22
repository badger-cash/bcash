/*!
 * spvstakeverifier.js - avalanche stake verifier for bcash in SPV mode
 * Copyright (c) 2026, Marianas Rai Corp (MIT License).
 */

'use strict';

const assert = require('bsert');
const {BloomFilter} = require('bfilter');
const Proof = require('./proof');
const {checkCoin} = require('./stakeverifier');

/**
 * SPV Stake Verifier
 * Checks a proof's stakes without a coin database. Each stake names the
 * height of its coin, so the block there is fetched, as a merkleblock
 * matching the coin's transaction, or whole if no peer serves one. The
 * coin is then watched: a block spending it makes it missing.
 *
 * On an anchored chain, a stake's block can be below the anchor. Then the
 * headers from the nearest checkpoint below it up to the chain's first
 * block are walked, each building on the one before and the last being
 * that trusted block, which proves every hash between. The hash of each
 * stake's block is kept in the chain's database.
 *
 * SPV cannot show a coin was unspent when first seen. Avalanche covers
 * that: full nodes vote down proofs whose coins are spent, and the
 * processor acts on those votes.
 * @alias module:avalanche.SpvStakeVerifier
 */

class SpvStakeVerifier {
  /**
   * @param {Object} options
   * @param {Chain} options.chain - An SPV chain.
   * @param {Pool} options.pool - An SPV pool, for scanRange and watching.
   * @param {Number} [options.dustThreshold]
   * @param {Number} [options.confirmations]
   */

  constructor(options) {
    assert(options && options.chain && options.pool);
    this.chain = options.chain;
    this.pool = options.pool;
    this.dustThreshold = options.dustThreshold != null
      ? options.dustThreshold
      : Proof.PROOF_DUST_THRESHOLD;
    this.confirmations = options.confirmations != null
      ? options.confirmations
      : Proof.STAKE_UTXO_CONFIRMATIONS;

    // Outpoint key to {height, coinbase, output}, for coins we found.
    this.coins = new Map();
    // Height to hash below an anchor, walked this run, and the range.
    this.below = new Map();
    // Outpoint key to {height, coin}, for those blocks spent.
    this.spent = new Map();

    this.chain.on('connect', (entry, block) => this.connectBlock(entry, block));
    this.chain.on('disconnect', entry => this.disconnectBlock(entry));
  }

  /**
   * Check a proof, then its stakes against the header chain.
   * @param {Proof} proof
   * @returns {Promise} - Returns [valid, reason].
   */

  async verify(proof) {
    const [valid, reason] = proof.verify(this.dustThreshold);

    if (!valid)
      return [false, reason];

    const tip = this.chain.tip;
    const mtp = tip ? await this.chain.getMedianTime(tip) : 0;

    if (proof.expiration > 0n && BigInt(mtp) >= proof.expiration)
      return [false, 'expired-proof'];

    const height = this.chain.height;

    for (const {stake} of proof.stakes) {
      const coin = await this.getCoin(stake);

      const [ok, why] = checkCoin(stake, coin, height, this.confirmations);

      if (!ok)
        return [false, why];
    }

    return [true, 'valid'];
  }

  /**
   * The coin a stake claims, if its block has it and no block since
   * spent it.
   * @private
   * @param {Stake} stake
   * @returns {Promise} - Returns {height, coinbase, output} or null.
   */

  async getCoin(stake) {
    const key = outpointKey(stake.outpoint);

    if (this.spent.has(key))
      return null;

    const cached = this.coins.get(key);
    if (cached)
      return cached;

    const entry = await this.blockAt(stake.height);

    // Not as far as our headers go; not cached, so asked again later.
    if (!entry)
      return null;

    const tx = await this.fetchTX(entry, stake.outpoint.hash);

    if (!tx || stake.outpoint.index >= tx.outputs.length)
      return null;

    const coin = {
      height: entry.height,
      coinbase: tx.isCoinbase(),
      output: tx.outputs[stake.outpoint.index]
    };

    this.coins.set(key, coin);

    // A block spending it now matches our filter.
    this.pool.watchOutpoint(stake.outpoint);

    return coin;
  }

  /**
   * The block at a height: the chain's own, or below an anchor, one whose
   * link to it was checked.
   * @private
   * @param {Number} height
   * @returns {Promise} - Returns {height, hash} or null.
   */

  async blockAt(height) {
    const entry = await this.chain.getEntryByHeight(height);

    if (entry)
      return entry;

    const floor = await this.anchorFloor();

    if (!floor || height >= floor.height)
      return null;

    let hash = this.below.get(height)
      || await this.chain.db.getBelowAnchor(height);

    if (!hash) {
      try {
        await this.walkBelow(height, floor);
      } catch (e) {
        return null;
      }

      hash = this.below.get(height);

      if (!hash)
        return null;

      await this.chain.db.putBelowAnchor(new Map([[height, hash]]));
    }

    return {height, hash};
  }

  /**
   * The first block of an anchored chain.
   * @private
   * @returns {Promise} - Returns {@link ChainEntry} or null.
   */

  async anchorFloor() {
    const anchor = this.chain.options.anchor;

    if (!anchor)
      return null;

    return this.chain.getEntryByHeight(anchor.height);
  }

  /**
   * Walk the headers from the nearest checkpoint at or below a height up
   * to the chain's first block.
   * @private
   * @param {Number} height
   * @param {ChainEntry} floor
   * @returns {Promise}
   */

  async walkBelow(height, floor) {
    const network = this.chain.network;

    let from = {height: 0, hash: network.genesis.hash};

    for (const checkpoint of network.checkpoints) {
      if (checkpoint.height <= height && checkpoint.height > from.height)
        from = checkpoint;
    }

    const hashes = await this.pool.fetchHeaders(from.hash, floor.hash);

    // As many as the heights between: the walk ends at the trusted floor.
    assert(hashes.length === floor.height - from.height,
      'Headers below the anchor do not reach it.');

    this.below.set(from.height, from.hash);
    for (let i = 0; i < hashes.length; i++)
      this.below.set(from.height + 1 + i, hashes[i]);
  }

  /**
   * Fetch a transaction from the block it is in: by merkleblock, whose
   * tree and hash scanRange checks against the header, or by the whole
   * block if no peer serves one.
   * @private
   * @param {ChainEntry} entry
   * @param {Hash} txid
   * @returns {Promise} - Returns {@link TX} or null.
   */

  async fetchTX(entry, txid) {
    const range = {entries: [{height: entry.height, hash: entry.hash}]};

    const filter = BloomFilter.fromRate(1, 0.000001, BloomFilter.flags.NONE);
    filter.add(txid);

    let found = null;

    try {
      await this.pool.scanRange({...range, filter}, async (_, block) => {
        // Only what the verified partial tree matched.
        if (!block.getTree().map.has(txid))
          return;
        found = block.txs.find(tx => tx.hash().equals(txid)) || null;
      });
    } catch (e) {
      found = null;
    }

    if (found)
      return found;

    try {
      await this.pool.scanRange({...range, full: true}, async (_, block) => {
        found = block.txs.find(tx => tx.hash().equals(txid)) || null;
      });
    } catch (e) {
      return null;
    }

    return found;
  }

  /**
   * A connected block's matched transactions may spend watched coins.
   * @private
   * @param {ChainEntry} entry
   * @param {MerkleBlock|Block} block
   */

  connectBlock(entry, block) {
    if (!block || !block.txs)
      return;

    for (const tx of block.txs) {
      for (const {prevout} of tx.inputs) {
        const key = outpointKey(prevout);
        const coin = this.coins.get(key);
        if (!coin)
          continue;
        this.coins.delete(key);
        this.spent.set(key, {height: entry.height, coin});
      }
    }
  }

  /**
   * Coins a disconnected block spent are unspent again.
   * @private
   * @param {ChainEntry} entry
   */

  disconnectBlock(entry) {
    for (const [key, {height, coin}] of this.spent) {
      if (height === entry.height) {
        this.spent.delete(key);
        this.coins.set(key, coin);
      }
    }
  }
}

/*
 * Helpers
 */

function outpointKey(outpoint) {
  return outpoint.toKey().toString('hex');
}

/*
 * Expose
 */

module.exports = SpvStakeVerifier;
