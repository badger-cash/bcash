/*!
 * txindexer.js - transaction indexer for bcoin
 * Copyright (c) 2018, the bcoin developers (MIT License).
 * https://github.com/bcoin-org/bcoin
 */

'use strict';

const assert = require('bsert');
const bdb = require('bdb');
const bio = require('bufio');
const layout = require('./layout');
const consensus = require('../protocol/consensus');
const TX = require('../primitives/tx');
const Block = require('../primitives/block');
const TXMeta = require('../primitives/txmeta');
const Indexer = require('./indexer');

/*
 * TXIndexer Database Layout:
 *  t[hash] -> tx record
 *  b[height] -> block record
 *  p[prefix, index] -> spender (height, offset, length, input)
 *  P -> spender fill-in (next height, last height)
 *
 * The transaction index maps a transaction to a block
 * and an index, offset, and length within that block. The
 * block hash is stored in a separate record by height so that
 * the 32 byte hash is not repeated for every transaction
 * within a block.
 *
 * It also maps each spent output to the input spending it, with one
 * record per input ever confirmed, so kept small. The key is the first
 * 12 bytes of the spent output's txid and its index (a varint); the
 * value locates the spending transaction in its block, as a tx record
 * does, and names its input, all varints. Finding a spender reads that
 * transaction from the block, which gives its txid, and checks that the
 * input spends the output asked for: two outputs sharing a key prefix,
 * which 96 bits make vanishingly rare, cannot give a wrong answer.
 *
 * An index made before it kept spenders fills them in once, in the
 * background, from the blocks it has already indexed (P keeps where it
 * is).
 */

Object.assign(layout, {
  t: bdb.key('t', ['hash256']),
  b: bdb.key('b', ['uint32']),
  p: bdb.key('p', ['buffer']),
  P: bdb.key('P')
});

// Blocks filled in per write, in the fill-in of spenders.
const FILL_BATCH = 100;

// Bytes of a spent output's txid in its spender record's key.
const SPENT_PREFIX = 12;

/**
 * The key of the spender record of an output.
 * @param {Hash} hash
 * @param {Number} index
 * @returns {Buffer}
 */

function spentKey(hash, index) {
  const bw = bio.write(SPENT_PREFIX + bio.sizeVarint(index));
  bw.copy(hash, 0, SPENT_PREFIX);
  bw.writeVarint(index);
  return layout.p.encode(bw.render());
}

/**
 * Block Record
 */

class BlockRecord {
  /**
   * Create a block record.
   * @constructor
   */

  constructor(options = {}) {
    this.block = options.block || consensus.ZERO_HASH;
    this.time = options.time || 0;

    assert(this.block.length === 32);
    assert((this.time >>> 0) === this.time);
  }

  /**
   * Inject properties from serialized data.
   * @private
   * @param {Buffer} data
   */

  fromRaw(data) {
    const br = bio.read(data);

    this.block = br.readHash();
    this.time = br.readU32();

    return this;
  }

  /**
   * Instantiate block record from serialized data.
   * @param {Hash} hash
   * @param {Buffer} data
   * @returns {BlockRecord}
   */

  static fromRaw(data) {
    return new this().fromRaw(data);
  }

  /**
   * Serialize the block record.
   * @returns {Buffer}
   */

  toRaw() {
    const bw = bio.write(36);

    bw.writeHash(this.block);
    bw.writeU32(this.time);

    return bw.render();
  }
}

/**
 * Transaction Record
 */

class TxRecord {
  /**
   * Create a transaction record.
   * @constructor
   */

  constructor(options = {}) {
    this.height = options.height || 0;
    this.index = options.index || 0;
    this.offset = options.offset || 0;
    this.length = options.length || 0;

    assert((this.height >>> 0) === this.height);
    assert((this.index >>> 0) === this.index);
    assert((this.offset >>> 0) === this.offset);
    assert((this.length >>> 0) === this.length);
  }

  /**
   * Inject properties from serialized data.
   * @private
   * @param {Buffer} data
   */

  fromRaw(data) {
    const br = bio.read(data);

    this.height = br.readU32();
    this.index = br.readU32();
    this.offset = br.readU32();
    this.length = br.readU32();

    return this;
  }

  /**
   * Instantiate transaction record from serialized data.
   * @param {Hash} hash
   * @param {Buffer} data
   * @returns {TxRecord}
   */

  static fromRaw(data) {
    return new this().fromRaw(data);
  }

  /**
   * Serialize the transaction record.
   * @returns {Buffer}
   */

  toRaw() {
    const bw = bio.write(16);

    bw.writeU32(this.height);
    bw.writeU32(this.index);
    bw.writeU32(this.offset);
    bw.writeU32(this.length);

    return bw.render();
  }
}

/**
 * TXIndexer
 * @alias module:indexer.TXIndexer
 * @extends Indexer
 */

class TXIndexer extends Indexer {
  /**
   * Create a indexer
   * @constructor
   * @param {Object} options
   */

  constructor(options) {
    super('tx', options);

    this.db = bdb.create(this.options);

    // The fill-in of spenders: what is left, and whether it runs.
    this.fill = {next: 0, end: -1};
    this.filling = null;
    this.closing = false;
  }

  /**
   * Open the index, and fill in spenders if it was made without them.
   * @returns {Promise}
   */

  async open() {
    await super.open();

    const data = await this.db.get(layout.P.encode());

    if (data) {
      this.fill = {
        next: data.readUInt32LE(0),
        end: data.readInt32LE(4)
      };
    } else if (this.height > 0) {
      // Indexed before spenders were: the blocks to height, again.
      this.fill = {next: 1, end: this.height};
      await this.saveFill();
      this.logger.info(
        'Filling in spenders for %d indexed blocks, in the background.',
        this.height);
    } else {
      // New: spenders are indexed with the blocks.
      await this.saveFill();
    }

    if (this.fill.next <= this.fill.end) {
      this.filling = this.fillSpenders().catch((err) => {
        this.logger.error('Filling in spenders stopped: %s', err.message);
      });
    }
  }

  /**
   * Close the index, stopping the fill-in where it is.
   * @returns {Promise}
   */

  async close() {
    this.closing = true;
    if (this.filling)
      await this.filling;
    await super.close();
  }

  async saveFill(batch) {
    const data = Buffer.alloc(8);
    data.writeUInt32LE(this.fill.next, 0);
    data.writeInt32LE(this.fill.end, 4);
    if (batch)
      batch.put(layout.P.encode(), data);
    else
      await this.db.put(layout.P.encode(), data);
  }

  /**
   * Whether every spent output's spender is indexed.
   * @returns {Boolean}
   */

  get spendersComplete() {
    return this.fill.next > this.fill.end;
  }

  /**
   * Fill in spenders for blocks indexed before spenders were, from the
   * blocks on disk: a block at a time, written each FILL_BATCH blocks
   * with where it is, so a restart goes on from there.
   * @private
   * @returns {Promise}
   */

  async fillSpenders() {
    let batch = this.db.batch();
    let count = 0;

    while (!this.closing && this.fill.next <= this.fill.end) {
      const height = this.fill.next;
      const meta = await this.getBlockMeta(height);
      const block = meta ? await this.chain.getBlock(meta.hash) : null;

      if (!block)
        throw new Error(`No block at height ${height} to fill in from.`);

      this.putSpenders(block, height, batch);
      this.fill.next = height + 1;
      count += 1;

      if (count % FILL_BATCH === 0 || this.fill.next > this.fill.end) {
        await this.saveFill(batch);
        await batch.write();
        batch = this.db.batch();
      }

      if (height % 10000 === 0)
        this.logger.info('Filled in spenders to height %d of %d.',
          height, this.fill.end);
    }

    if (count % FILL_BATCH !== 0) {
      await this.saveFill(batch);
      await batch.write();
    }

    if (this.spendersComplete)
      this.logger.info('Spenders filled in for every indexed block.');
  }

  /**
   * Record, for each output a block's transactions spend, the input
   * spending it: where its transaction is in the block, and which input.
   * @private
   * @param {Block} block
   * @param {Number} height
   * @param {Batch} batch
   */

  putSpenders(block, height, batch) {
    const bblock = block.txs[0]._block ? block : Block.fromRaw(block.toRaw());

    for (const tx of bblock.txs) {
      if (tx.isCoinbase())
        continue;

      const {offset, size} = tx.getPosition();

      for (let i = 0; i < tx.inputs.length; i++) {
        const {prevout} = tx.inputs[i];
        const bw = bio.write(bio.sizeVarint(height) + bio.sizeVarint(offset)
          + bio.sizeVarint(size) + bio.sizeVarint(i));
        bw.writeVarint(height);
        bw.writeVarint(offset);
        bw.writeVarint(size);
        bw.writeVarint(i);
        batch.put(spentKey(prevout.hash, prevout.index), bw.render());
      }
    }
  }

  /**
   * Index transactions by txid.
   * @private
   * @param {BlockMeta} meta
   * @param {Block} block
   * @param {CoinView} view
   */

  async indexBlock(meta, block, view) {
    assert(block.hasRaw(), 'Expected raw data for block.');
    const brecord = new BlockRecord({
      block: meta.hash,
      time: block.time
    });

    this.put(layout.b.encode(meta.height), brecord.toRaw());

    const bblock = block.txs[0]._block ? block : Block.fromRaw(block.toRaw());
    for (let i = 0; i < bblock.txs.length; i++) {
      const tx = bblock.txs[i];

      const hash = tx.hash();
      const {offset, size} = tx.getPosition();

      const txrecord = new TxRecord({
        height: meta.height,
        index: i,
        offset: offset,
        length: size
      });

      this.put(layout.t.encode(hash), txrecord.toRaw());
    }

    this.putSpenders(bblock, meta.height, this.batch);
  }

  /**
   * Remove transactions from index.
   * @private
   * @param {BlockMeta} meta
   * @param {Block} block
   * @param {CoinView} view
   */

  async unindexBlock(meta, block, view) {
    this.del(layout.b.encode(meta.height));

    for (let i = 0; i < block.txs.length; i++) {
      const tx = block.txs[i];
      const hash = tx.hash();
      this.del(layout.t.encode(hash));

      // Its spends are undone.
      if (!tx.isCoinbase()) {
        for (const {prevout} of tx.inputs)
          this.del(spentKey(prevout.hash, prevout.index));
      }
    }
  }

  /**
   * The input spending an output, in a block.
   * @param {Hash} hash
   * @param {Number} index
   * @returns {Promise} - Returns {hash, index, height} or null.
   */

  async getSpender(hash, index) {
    const data = await this.db.get(spentKey(hash, index));
    if (!data)
      return null;

    const br = bio.read(data);
    const height = br.readVarint();
    const offset = br.readVarint();
    const length = br.readVarint();
    const input = br.readVarint();

    const braw = await this.db.get(layout.b.encode(height));
    if (!braw)
      return null;

    const {block} = BlockRecord.fromRaw(braw);
    const tx = TX.fromRaw(await this.blocks.read(block, offset, length));

    // Its input must spend this very output: a key is only a prefix.
    const spend = tx.inputs[input];
    if (!spend || spend.prevout.index !== index
        || !spend.prevout.hash.equals(hash)) {
      return null;
    }

    return {hash: tx.hash(), index: input, height};
  }

  /**
   * Get a transaction with metadata.
   * @param {Hash} hash
   * @returns {Promise} - Returns {@link TXMeta}.
   */

  async getMeta(hash) {
    const raw = await this.db.get(layout.t.encode(hash));
    if (!raw)
      return null;

    const record = TxRecord.fromRaw(raw);
    const {height, index, offset, length} = record;

    const braw = await this.db.get(layout.b.encode(height));
    if (!braw)
      return null;

    const brecord = BlockRecord.fromRaw(braw);
    const {block, time} = brecord;

    const data = await this.blocks.read(block, offset, length);

    const tx = TX.fromRaw(data);

    const meta = TXMeta.fromTX(tx);
    meta.height = height;
    meta.block = block;
    meta.time = time;
    meta.index = index;

    return meta;
  }

  /**
   * Retrieve a transaction.
   * @param {Hash} hash
   * @returns {Promise} - Returns {@link TX}.
   */

  async getTX(hash) {
    const meta = await this.getMeta(hash);

    if (!meta)
      return null;

    return meta.tx;
  }

  /**
   * @param {Hash} hash
   * @returns {Promise} - Returns Boolean.
   */

  async hasTX(hash) {
    return this.db.has(layout.t.encode(hash));
  }

  /**
   * Get coin viewpoint (historical).
   * @param {TX} tx
   * @returns {Promise} - Returns {@link CoinView}.
   */

  async getSpentView(tx) {
    const view = await this.chain.getCoinView(tx);

    for (const {prevout} of tx.inputs) {
      if (view.hasEntry(prevout))
        continue;

      const {hash, index} = prevout;
      const meta = await this.getMeta(hash);

      if (!meta)
        continue;

      const {tx, height} = meta;

      if (index < tx.outputs.length)
        view.addIndex(tx, index, height);
    }

    return view;
  }
}

module.exports = TXIndexer;
