/*!
 * delegation.js - avalanche delegation for bcash
 * Copyright (c) 2026, Marianas Rai Corp (MIT License).
 * Ported from Bitcoin ABC's src/avalanche/delegation.{h,cpp}.
 */

'use strict';

const assert = require('bsert');
const bio = require('bufio');
const hash256 = require('bcrypto/lib/hash256');
const secp256k1 = require('bcrypto/lib/secp256k1');
const util = require('../utils/util');
const Proof = require('./proof');
const {schnorrVerify} = require('./stake');

/*
 * Constants
 */

const MAX_DELEGATION_LEVELS = 20;

/**
 * Delegation
 * Hands a proof's authority from its master key down a chain of keys.
 * The last key signs a node's avalanche messages.
 * @alias module:avalanche.Delegation
 * @property {Buffer} limitedId - Limited id of the proof.
 * @property {Buffer} master - Master key of the proof.
 * @property {Object[]} levels - [{pubkey, signature}, ...]
 */

class Delegation {
  constructor() {
    this.limitedId = Buffer.alloc(32);
    this.master = Buffer.alloc(0);
    this.levels = [];
  }

  /**
   * Start a delegation from a proof, with no levels.
   * @param {Proof} proof
   * @returns {Delegation}
   */

  static fromProof(proof) {
    const dg = new this();
    dg.limitedId = proof.limitedId();
    dg.master = proof.master;
    return dg;
  }

  /**
   * Delegate to another key.
   * @param {Buffer} key - Private key of the current delegated key.
   * @param {Buffer} pubkey - Key to delegate to.
   * @returns {Boolean} False if key is not the current delegated key.
   */

  addLevel(key, pubkey) {
    const from = secp256k1.publicKeyCreate(key, true);

    if (!from.equals(this.getDelegatedPubkey()))
      return false;

    const hash = levelHash(this.id(), pubkey);
    const signature = secp256k1.schnorrSign(hash, key);

    this.levels.push({pubkey, signature});

    return true;
  }

  proofId() {
    return Proof.computeId(this.limitedId, this.master);
  }

  /**
   * Delegation id: the proof id, hashed with each level's key.
   * @returns {Buffer}
   */

  id() {
    let hash = this.proofId();
    for (const {pubkey} of this.levels)
      hash = levelHash(hash, pubkey);
    return hash;
  }

  rid() {
    return util.revHex(this.id());
  }

  getDelegatedPubkey() {
    if (this.levels.length > 0)
      return this.levels[this.levels.length - 1].pubkey;
    return this.master;
  }

  /**
   * Check each level's signature.
   * @returns {Array} [valid, reason, pubkey] - pubkey is the last key
   * whose authority was proven.
   */

  verify() {
    if (this.levels.length > MAX_DELEGATION_LEVELS)
      return [false, 'too-many-levels', this.master];

    let hash = this.proofId();
    let auth = this.master;

    for (const {pubkey, signature} of this.levels) {
      hash = levelHash(hash, pubkey);

      if (!schnorrVerify(hash, signature, auth))
        return [false, 'invalid-signature', auth];

      auth = pubkey;
    }

    return [true, 'valid', auth];
  }

  getSize() {
    let size = 32;
    size += bio.sizeVarBytes(this.master);
    size += bio.sizeVarint(this.levels.length);
    for (const {pubkey} of this.levels)
      size += bio.sizeVarBytes(pubkey) + 64;
    return size;
  }

  toWriter(bw) {
    bw.writeBytes(this.limitedId);
    bw.writeVarBytes(this.master);
    bw.writeVarint(this.levels.length);
    for (const {pubkey, signature} of this.levels) {
      bw.writeVarBytes(pubkey);
      bw.writeBytes(signature);
    }
    return bw;
  }

  toRaw() {
    return this.toWriter(bio.write(this.getSize())).render();
  }

  toHex() {
    return this.toRaw().toString('hex');
  }

  fromReader(br) {
    this.limitedId = br.readBytes(32);
    this.master = br.readVarBytes();

    const count = br.readVarint();

    // Bitcoin ABC reads more and fails verify(); there is no point.
    if (count > MAX_DELEGATION_LEVELS)
      throw new Error('Too many delegation levels.');

    this.levels = [];
    for (let i = 0; i < count; i++) {
      const pubkey = br.readVarBytes();
      const signature = br.readBytes(64);
      this.levels.push({pubkey, signature});
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

  static fromHex(hex) {
    return this.fromRaw(Buffer.from(hex, 'hex'));
  }
}

/*
 * Helpers
 */

function levelHash(hash, pubkey) {
  assert(hash.length === 32);
  const bw = bio.write(32 + bio.sizeVarBytes(pubkey));
  bw.writeBytes(hash);
  bw.writeVarBytes(pubkey);
  return hash256.digest(bw.render());
}

/*
 * Expose
 */

Delegation.MAX_DELEGATION_LEVELS = MAX_DELEGATION_LEVELS;

module.exports = Delegation;
