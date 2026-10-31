/*!
 * spvstakeverifier.js - avalanche stake verifier for bcash in SPV mode
 * Copyright (c) 2026, Marianas Rai Corp (MIT License).
 */

'use strict';

const assert = require('bsert');
const {BloomFilter} = require('bfilter');
const Proof = require('./proof');
const {checkCoin} = require('./stakeverifier');

// Blocks scanRange asks a peer for at once.
const SCAN_BATCH = 16;

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
    // The heights walks started from: each proved its way up to the floor.
    this.walked = [];
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
    const stakes = proof.stakes.map(s => s.stake);
    const {coins, fetched} = await this.getCoins(stakes);

    let failure = null;
    let maturing = true;

    for (let i = 0; i < stakes.length; i++) {
      const [ok, why] = checkCoin(stakes[i], coins[i], height,
        this.confirmations);

      if (ok)
        continue;

      if (!failure)
        failure = why;

      if (why !== 'immature-utxo')
        maturing = false;
    }

    // Only the coins of a proof that holds, or will once they mature, are
    // kept and watched: a proof could name any coins, not its own.
    if (maturing) {
      for (const {stake, coin} of fetched) {
        this.coins.set(outpointKey(stake.outpoint), coin);
        // A block spending it now matches our filter.
        this.pool.watchOutpoint(stake.outpoint);
      }
    }

    if (failure)
      return [false, failure];

    return [true, 'valid'];
  }

  /**
   * The coins stakes claim, each if its block has it and no block since
   * spent it. Those not known are fetched together, in one scan, and not
   * kept: verify keeps those of a proof that holds.
   * @private
   * @param {Stake[]} stakes
   * @returns {Promise} - Returns {coins, fetched}: coins, each
   * {height, coinbase, output} or null; fetched, [{stake, coin}].
   */

  async getCoins(stakes) {
    const coins = [];
    const fetched = [];
    const wanted = [];

    for (const stake of stakes) {
      const key = outpointKey(stake.outpoint);
      const coin = this.spent.has(key) ? null : this.coins.get(key);

      coins.push(coin || null);

      if (coin || this.spent.has(key))
        continue;

      const entry = await this.blockAt(stake.height);

      // Not as far as our headers go; not cached, so asked again later.
      if (entry)
        wanted.push({index: coins.length - 1, stake, entry});
    }

    if (wanted.length === 0)
      return {coins, fetched};

    const txs = await this.fetchTXs(wanted.map(({stake, entry}) => {
      return {entry, txid: stake.outpoint.hash};
    }));

    for (const {index, stake, entry} of wanted) {
      const tx = txs.get(txKey(entry.hash, stake.outpoint.hash));

      if (!tx || stake.outpoint.index >= tx.outputs.length)
        continue;

      const coin = {
        height: entry.height,
        coinbase: tx.isCoinbase(),
        output: tx.outputs[stake.outpoint.index]
      };

      coins[index] = coin;
      fetched.push({stake, coin});
    }

    return {coins, fetched};
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
   * to the chain's first block, or to where an earlier walk started: that
   * block is proven, so the hash links into it prove the rest.
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

    let stop = floor;

    for (const start of this.walked) {
      if (start > from.height && start < stop.height)
        stop = {height: start, hash: this.below.get(start)};
    }

    const hashes = await this.pool.fetchHeaders(from.hash, stop.hash);

    // As many as the heights between: the walk ends at a trusted block.
    assert(hashes.length === stop.height - from.height,
      'Headers below the anchor do not reach it.');

    this.below.set(from.height, from.hash);
    for (let i = 0; i < hashes.length; i++)
      this.below.set(from.height + 1 + i, hashes[i]);

    this.walked.push(from.height);
  }

  /**
   * Fetch transactions from the blocks they are in, in one scan: by
   * merkleblocks, whose trees and hashes scanRange checks against the
   * headers, then whole blocks for those no peer served that way.
   * @private
   * @param {Object[]} items - {entry, txid}.
   * @returns {Promise} - Returns Map of txKey(block hash, txid) to TX.
   */

  async fetchTXs(items) {
    const found = new Map();

    const scan = async (list, options) => {
      const blocks = new Map();
      for (const {entry} of list) {
        blocks.set(entry.hash.toString('hex'),
          {height: entry.height, hash: entry.hash});
      }

      const entries = [...blocks.values()].sort((a, b) => a.height - b.height);
      const wanted = new Set(list.map(i => txKey(i.entry.hash, i.txid)));

      // As many peers as batches of blocks, not a full set for one.
      const peers = Math.max(1, Math.min(this.pool.options.maxOutbound,
        Math.ceil(entries.length / SCAN_BATCH)));

      try {
        await this.pool.scanRange({...options, entries, peers},
          async (entry, block) => {
            // Of a merkleblock, only what the verified partial tree matched.
            const tree = options.full ? null : block.getTree().map;
            for (const tx of block.txs) {
              const hash = tx.hash();
              if (tree && !tree.has(hash))
                continue;
              const key = txKey(entry.hash, hash);
              if (wanted.has(key))
                found.set(key, tx);
            }
          });
      } catch (e) {
        // What no peer served is tried whole, or is missing.
      }
    };

    const filter = BloomFilter.fromRate(items.length, 0.000001,
      BloomFilter.flags.NONE);

    for (const {txid} of items)
      filter.add(txid);

    await scan(items, {filter});

    const missing = items.filter(i => !found.has(txKey(i.entry.hash, i.txid)));

    if (missing.length > 0)
      await scan(missing, {full: true});

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

function txKey(blockHash, txid) {
  return blockHash.toString('hex') + txid.toString('hex');
}

/*
 * Expose
 */

module.exports = SpvStakeVerifier;
