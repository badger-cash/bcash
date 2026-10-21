/*!
 * stake.js - avalanche stake for bcash
 * Copyright (c) 2026, Marianas Rai Corp (MIT License).
 * Ported from Bitcoin ABC's src/avalanche/proof.h.
 */

'use strict';

const assert = require('bsert');
const bio = require('bufio');
const hash256 = require('bcrypto/lib/hash256');
const secp256k1 = require('bcrypto/lib/secp256k1');
const Outpoint = require('../primitives/outpoint');

/**
 * Stake
 * A coin locked into an avalanche proof.
 * @alias module:avalanche.Stake
 * @property {Outpoint} outpoint
 * @property {Number} amount - Satoshis.
 * @property {Number} height - Block height of the coin.
 * @property {Boolean} coinbase
 * @property {Buffer} pubkey - Key the coin pays to (P2PKH).
 */

class Stake {
  constructor(options) {
    this.outpoint = new Outpoint();
    this.amount = 0;
    this.height = 0;
    this.coinbase = false;
    this.pubkey = Buffer.alloc(0);
    this._id = null;

    if (options)
      this.fromOptions(options);
  }

  fromOptions(options) {
    assert(options.outpoint instanceof Outpoint);
    assert(Number.isSafeInteger(options.amount));
    assert((options.height >>> 0) === options.height);
    assert(options.height < 0x80000000);
    assert(Buffer.isBuffer(options.pubkey));
    this.outpoint = options.outpoint;
    this.amount = options.amount;
    this.height = options.height;
    this.coinbase = Boolean(options.coinbase);
    this.pubkey = options.pubkey;
    return this;
  }

  static fromOptions(options) {
    return new this().fromOptions(options);
  }

  /**
   * Stake id: hash256 of the serialized stake.
   * @returns {Buffer}
   */

  id() {
    if (!this._id)
      this._id = hash256.digest(this.toRaw());
    return this._id;
  }

  /**
   * The hash a stake signature commits to.
   * @param {Buffer} commitment - See {@link Stake.commitment}.
   * @returns {Buffer}
   */

  signatureHash(commitment) {
    assert(Buffer.isBuffer(commitment) && commitment.length === 32);
    return hash256.digest(Buffer.concat([commitment, this.toRaw()]));
  }

  /**
   * The stake commitment: binds stakes to one master key and expiration.
   * @param {BigInt} expiration
   * @param {Buffer} master
   * @returns {Buffer}
   */

  static commitment(expiration, master) {
    const bw = bio.write(8 + bio.sizeVarBytes(master));
    writeI64(bw, expiration);
    bw.writeVarBytes(master);
    return hash256.digest(bw.render());
  }

  getSize() {
    return 36 + 8 + 4 + bio.sizeVarBytes(this.pubkey);
  }

  toWriter(bw) {
    this.outpoint.toWriter(bw);
    bw.writeI64(this.amount);
    bw.writeU32((this.height << 1 | this.coinbase) >>> 0);
    bw.writeVarBytes(this.pubkey);
    return bw;
  }

  toRaw() {
    return this.toWriter(bio.write(this.getSize())).render();
  }

  fromReader(br) {
    this.outpoint = Outpoint.fromReader(br);
    this.amount = br.readI64();
    const height = br.readU32();
    this.height = height >>> 1;
    this.coinbase = (height & 1) === 1;
    this.pubkey = br.readVarBytes();
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
 * Signed Stake
 * A stake with the Schnorr signature of its coin's key.
 * @alias module:avalanche.SignedStake
 * @property {Stake} stake
 * @property {Buffer} signature - 64 byte Schnorr signature.
 */

class SignedStake {
  constructor(stake, signature) {
    this.stake = stake || new Stake();
    this.signature = signature || Buffer.alloc(64);
    assert(this.stake instanceof Stake);
    assert(Buffer.isBuffer(this.signature) && this.signature.length === 64);
  }

  /**
   * Sign a stake with the private key of its coin.
   * @param {Stake} stake
   * @param {Buffer} commitment
   * @param {Buffer} key - Private key.
   * @returns {SignedStake}
   */

  static sign(stake, commitment, key) {
    const hash = stake.signatureHash(commitment);
    return new this(stake, secp256k1.schnorrSign(hash, key));
  }

  verify(commitment) {
    return schnorrVerify(this.stake.signatureHash(commitment),
      this.signature, this.stake.pubkey);
  }

  getSize() {
    return this.stake.getSize() + 64;
  }

  toWriter(bw) {
    this.stake.toWriter(bw);
    bw.writeBytes(this.signature);
    return bw;
  }

  fromReader(br) {
    this.stake = Stake.fromReader(br);
    this.signature = br.readBytes(64);
    return this;
  }

  static fromReader(br) {
    return new this().fromReader(br);
  }
}

/*
 * Helpers
 */

// Bitcoin ABC accepts any serialized key and fails the signature
// check on an invalid one; bcrypto throws on it instead.
function schnorrVerify(msg, sig, key) {
  try {
    return secp256k1.schnorrVerify(msg, sig, key);
  } catch (e) {
    return false;
  }
}

function writeI64(bw, value) {
  assert(typeof value === 'bigint');
  const buf = Buffer.alloc(8);
  buf.writeBigInt64LE(value);
  return bw.writeBytes(buf);
}

function readI64(br) {
  return br.readBytes(8).readBigInt64LE();
}

function writeU64(bw, value) {
  assert(typeof value === 'bigint');
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value);
  return bw.writeBytes(buf);
}

function readU64(br) {
  return br.readBytes(8).readBigUInt64LE();
}

/*
 * Expose
 */

exports.Stake = Stake;
exports.SignedStake = SignedStake;
exports.schnorrVerify = schnorrVerify;
exports.writeI64 = writeI64;
exports.readI64 = readI64;
exports.writeU64 = writeU64;
exports.readU64 = readU64;
