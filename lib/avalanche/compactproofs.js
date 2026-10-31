/*!
 * compactproofs.js - avalanche compact proofs for bcash
 * Copyright (c) 2026, Marianas Rai Corp (MIT License).
 * Ported from Bitcoin ABC's src/avalanche/compactproofs.{h,cpp}.
 */

'use strict';

const assert = require('bsert');
const bio = require('bufio');
const random = require('bcrypto/lib/random');
const {siphash} = require('bcrypto/lib/siphash');
const Proof = require('./proof');

/*
 * Constants
 */

const SHORTPROOFIDS_LENGTH = 6;

/**
 * Compact Proofs
 * The proofs a node knows, as 6 byte short ids salted by a random
 * siphash key (avaproofs), plus any proofs sent in full (prefilled).
 * @alias module:avalanche.CompactProofs
 * @property {Buffer} key - 16 byte siphash key: k0 then k1, little endian.
 * @property {Number[]} shortIds
 * @property {Object[]} prefilled - [{index, proof}, ...], by index.
 */

class CompactProofs {
  constructor(key) {
    this.key = key || random.randomBytes(16);
    this.shortIds = [];
    this.prefilled = [];
    assert(Buffer.isBuffer(this.key) && this.key.length === 16);
  }

  /**
   * Short ids for proofs.
   * @param {Proof[]} proofs
   * @param {Buffer} [key]
   * @returns {CompactProofs}
   */

  static fromProofs(proofs, key) {
    const cp = new this(key);
    for (const proof of proofs)
      cp.shortIds.push(cp.sid(proof.id()));
    return cp;
  }

  /**
   * Short id of a proof id.
   * @param {Buffer} proofId
   * @returns {Number}
   */

  sid(proofId) {
    const [hi, lo] = siphash(proofId, this.key);
    return (hi & 0xffff) * 0x100000000 + (lo >>> 0);
  }

  get size() {
    return this.shortIds.length + this.prefilled.length;
  }

  getSize() {
    let size = 16;
    size += bio.sizeVarint(this.shortIds.length);
    size += this.shortIds.length * SHORTPROOFIDS_LENGTH;
    size += bio.sizeVarint(this.prefilled.length);
    let last = -1;
    for (const {index, proof} of this.prefilled) {
      size += bio.sizeVarint(index - last - 1);
      size += proof.getSize();
      last = index;
    }
    return size;
  }

  toWriter(bw) {
    bw.writeBytes(this.key);

    bw.writeVarint(this.shortIds.length);
    for (const id of this.shortIds) {
      bw.writeU32(id % 0x100000000);
      bw.writeU16(Math.floor(id / 0x100000000));
    }

    const indexes = this.prefilled.map(p => p.index);
    bw.writeVarint(this.prefilled.length);
    for (const [i, delta] of encodeDifferences(indexes).entries()) {
      bw.writeVarint(delta);
      this.prefilled[i].proof.toWriter(bw);
    }

    return bw;
  }

  toRaw() {
    return this.toWriter(bio.write(this.getSize())).render();
  }

  fromReader(br) {
    this.key = br.readBytes(16);

    const count = br.readVarint();

    this.shortIds = [];
    for (let i = 0; i < count; i++) {
      const lo = br.readU32();
      const hi = br.readU16();
      this.shortIds.push(hi * 0x100000000 + lo);
    }

    const prefilled = br.readVarint();
    const decoder = new DifferenceDecoder();

    this.prefilled = [];
    for (let i = 0; i < prefilled; i++) {
      const index = decoder.next(br.readVarint());
      const proof = Proof.fromReader(br);
      this.prefilled.push({index, proof});
    }

    // Indexes are absolute and sorted now, so the last is the highest.
    if (this.prefilled.length > 0) {
      const highest = this.prefilled[this.prefilled.length - 1].index;

      if (highest + this.shortIds.length > 0xffffffff)
        throw new Error('Indexes overflowed 32 bits.');

      // A gap in the indexes would leave a proof that cannot be found.
      if (highest >= this.size)
        throw new Error('Non contiguous indexes.');
    }

    return this;
  }

  fromRaw(data) {
    return this.fromReader(bio.read(data));
  }

  static fromReader(br) {
    return new this().fromReader(br);
  }

  static fromRaw(data) {
    return new this().fromRaw(data);
  }
}

/**
 * Proofs Request
 * Indexes into a peer's compact proofs, of the proofs we want
 * (avaproofsreq).
 * @alias module:avalanche.ProofsRequest
 * @property {Number[]} indexes - Ascending.
 */

class ProofsRequest {
  constructor(indexes) {
    this.indexes = indexes || [];
  }

  getSize() {
    let size = bio.sizeVarint(this.indexes.length);
    for (const delta of encodeDifferences(this.indexes))
      size += bio.sizeVarint(delta);
    return size;
  }

  toWriter(bw) {
    bw.writeVarint(this.indexes.length);
    for (const delta of encodeDifferences(this.indexes))
      bw.writeVarint(delta);
    return bw;
  }

  toRaw() {
    return this.toWriter(bio.write(this.getSize())).render();
  }

  fromReader(br) {
    const count = br.readVarint();
    const decoder = new DifferenceDecoder();

    this.indexes = [];
    for (let i = 0; i < count; i++)
      this.indexes.push(decoder.next(br.readVarint()));

    return this;
  }

  fromRaw(data) {
    return this.fromReader(bio.read(data));
  }

  static fromRaw(data) {
    return new this().fromRaw(data);
  }
}

/*
 * Helpers
 */

// Bitcoin ABC's DifferenceFormatter: each index is written as its gap
// from the one before, plus one.
function encodeDifferences(indexes) {
  const deltas = [];
  let shift = 0;
  for (const index of indexes) {
    if (index < shift)
      throw new Error('Differential value overflow.');
    deltas.push(index - shift);
    shift = index + 1;
  }
  return deltas;
}

class DifferenceDecoder {
  constructor() {
    this.shift = 0;
  }

  next(delta) {
    const index = this.shift + delta;
    if (index > 0xffffffff)
      throw new Error('Differential value overflow.');
    this.shift = index + 1;
    return index;
  }
}

/*
 * Expose
 */

exports.CompactProofs = CompactProofs;
exports.ProofsRequest = ProofsRequest;
exports.SHORTPROOFIDS_LENGTH = SHORTPROOFIDS_LENGTH;
