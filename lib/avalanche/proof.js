/*!
 * proof.js - avalanche proof for bcash
 * Copyright (c) 2026, Marianas Rai Corp (MIT License).
 * Ported from Bitcoin ABC's src/avalanche/proof.{h,cpp}.
 */

'use strict';

const assert = require('bsert');
const bio = require('bufio');
const hash256 = require('bcrypto/lib/hash256');
const secp256k1 = require('bcrypto/lib/secp256k1');
const consensus = require('../protocol/consensus');
const Script = require('../script/script');
const util = require('../utils/util');
const {
  Stake,
  SignedStake,
  schnorrVerify,
  writeI64,
  readI64,
  writeU64,
  readU64
} = require('./stake');

/*
 * Constants
 */

// Most coins one proof may stake.
const MAX_PROOF_STAKES = 1000;

// Least value a staked coin may hold.
const PROOF_DUST_THRESHOLD = 100 * consensus.COIN;

// Confirmations a coin needs before it can be staked.
const STAKE_UTXO_CONFIRMATIONS = 2016;

const ZERO_ID = Buffer.alloc(32, 0x00);

/**
 * Proof
 * Proof of stake that lets a node take part in avalanche.
 * @alias module:avalanche.Proof
 * @property {BigInt} sequence
 * @property {BigInt} expiration - Median time past; 0 never expires.
 * @property {Buffer} master - Master public key.
 * @property {SignedStake[]} stakes - Sorted by stake id.
 * @property {Script} payout - Staking reward script.
 * @property {Buffer} signature - Master key's signature of the limited id.
 */

class Proof {
  constructor() {
    this.sequence = 0n;
    this.expiration = 0n;
    this.master = Buffer.alloc(0);
    this.stakes = [];
    this.payout = new Script();
    this.signature = Buffer.alloc(64);
    this._limitedId = null;
    this._id = null;
  }

  /**
   * Build and sign a proof. Stakes are signed and sorted here.
   * @param {Object} options
   * @param {BigInt} options.sequence
   * @param {BigInt} options.expiration
   * @param {Buffer} options.masterKey - Master private key.
   * @param {Script} options.payout
   * @param {Array} options.stakes - [{stake: Stake, key: Buffer}, ...]
   * @returns {Proof}
   */

  static build(options) {
    const proof = new this();
    proof.sequence = options.sequence;
    proof.expiration = options.expiration;
    proof.master = secp256k1.publicKeyCreate(options.masterKey, true);
    proof.payout = options.payout;

    const commitment = Stake.commitment(proof.expiration, proof.master);

    proof.stakes = options.stakes
      .map(({stake, key}) => SignedStake.sign(stake, commitment, key))
      .sort((a, b) => compareIds(a.stake.id(), b.stake.id()));

    proof.signature = secp256k1.schnorrSign(proof.limitedId(),
      options.masterKey);

    return proof;
  }

  /**
   * Limited proof id: commits to everything but the master key and
   * the signatures.
   * @returns {Buffer}
   */

  limitedId() {
    if (!this._limitedId) {
      const bw = bio.write(this.getLimitedSize());
      writeU64(bw, this.sequence);
      writeI64(bw, this.expiration);
      bw.writeVarBytes(this.payout.toRaw());
      bw.writeVarint(this.stakes.length);
      for (const {stake} of this.stakes)
        stake.toWriter(bw);
      this._limitedId = hash256.digest(bw.render());
    }
    return this._limitedId;
  }

  /**
   * Proof id.
   * @returns {Buffer}
   */

  id() {
    if (!this._id)
      this._id = Proof.computeId(this.limitedId(), this.master);
    return this._id;
  }

  /**
   * Proof id, as Bitcoin ABC displays it.
   * @returns {String}
   */

  rid() {
    return util.revHex(this.id());
  }

  /**
   * Compute a proof id from its limited id and master key.
   * @param {Buffer} limitedId
   * @param {Buffer} master
   * @returns {Buffer}
   */

  static computeId(limitedId, master) {
    return hash256.digest(Buffer.concat([
      limitedId,
      bio.write(bio.sizeVarBytes(master)).writeVarBytes(master).render()
    ]));
  }

  getCommitment() {
    return Stake.commitment(this.expiration, this.master);
  }

  /**
   * Total staked value, clamped to MAX_MONEY as Bitcoin ABC does.
   * @returns {Number}
   */

  getStakedAmount() {
    let total = 0;
    for (const {stake} of this.stakes)
      total = moneyClamp(total + moneyClamp(stake.amount));
    return total;
  }

  /**
   * Proof score: the stake in units of 1/100 COIN.
   * @returns {Number}
   */

  getScore() {
    return Proof.amountToScore(this.getStakedAmount());
  }

  static amountToScore(amount) {
    // Bitcoin ABC's (100 * amount) / COIN, without passing 2^53.
    return Math.floor(moneyClamp(amount) / (consensus.COIN / 100));
  }

  /**
   * Check the proof without the chain: its signatures and the shape
   * of its stakes.
   * @param {Number} [dustThreshold=PROOF_DUST_THRESHOLD]
   * @returns {Array} [valid, reason]
   */

  verify(dustThreshold = PROOF_DUST_THRESHOLD) {
    if (this.stakes.length === 0)
      return [false, 'no-stake'];

    if (this.stakes.length > MAX_PROOF_STAKES)
      return [false, 'too-many-utxos'];

    if (!this.payout.isStandard())
      return [false, 'payout-script-non-standard'];

    if (!schnorrVerify(this.limitedId(), this.signature, this.master))
      return [false, 'invalid-proof-signature'];

    const commitment = this.getCommitment();
    const outpoints = new Set();

    let prev = ZERO_ID;

    for (const signed of this.stakes) {
      const {stake} = signed;

      if (stake.amount < dustThreshold)
        return [false, 'amount-below-dust-threshold'];

      if (compareIds(stake.id(), prev) < 0)
        return [false, 'wrong-stake-ordering'];

      prev = stake.id();

      const key = stake.outpoint.toKey().toString('hex');

      if (outpoints.has(key))
        return [false, 'duplicated-stake'];

      outpoints.add(key);

      if (!signed.verify(commitment))
        return [false, 'invalid-stake-signature'];
    }

    return [true, 'valid'];
  }

  getLimitedSize() {
    let size = 8 + 8;
    size += bio.sizeVarBytes(this.payout.toRaw());
    size += bio.sizeVarint(this.stakes.length);
    for (const {stake} of this.stakes)
      size += stake.getSize();
    return size;
  }

  getSize() {
    let size = 8 + 8;
    size += bio.sizeVarBytes(this.master);
    size += bio.sizeVarint(this.stakes.length);
    for (const signed of this.stakes)
      size += signed.getSize();
    size += bio.sizeVarBytes(this.payout.toRaw());
    size += 64;
    return size;
  }

  toWriter(bw) {
    writeU64(bw, this.sequence);
    writeI64(bw, this.expiration);
    bw.writeVarBytes(this.master);
    bw.writeVarint(this.stakes.length);
    for (const signed of this.stakes)
      signed.toWriter(bw);
    bw.writeVarBytes(this.payout.toRaw());
    bw.writeBytes(this.signature);
    return bw;
  }

  toRaw() {
    return this.toWriter(bio.write(this.getSize())).render();
  }

  toHex() {
    return this.toRaw().toString('hex');
  }

  fromReader(br) {
    this.sequence = readU64(br);
    this.expiration = readI64(br);
    this.master = br.readVarBytes();

    const count = br.readVarint();

    // Bitcoin ABC reads more and fails verify(); there is no point.
    if (count > MAX_PROOF_STAKES)
      throw new Error('Too many stakes.');

    this.stakes = [];
    for (let i = 0; i < count; i++)
      this.stakes.push(SignedStake.fromReader(br));

    this.payout = Script.fromRaw(br.readVarBytes());
    this.signature = br.readBytes(64);
    this._limitedId = null;
    this._id = null;
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

/**
 * Compare two ids as Bitcoin ABC compares uint256: as numbers, so from
 * the last byte.
 * @param {Buffer} a
 * @param {Buffer} b
 * @returns {Number}
 */

function compareIds(a, b) {
  assert(a.length === 32 && b.length === 32);
  for (let i = 31; i >= 0; i--) {
    if (a[i] !== b[i])
      return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

function moneyClamp(value) {
  return Math.min(Math.max(value, 0), consensus.MAX_MONEY);
}

/*
 * Expose
 */

Proof.MAX_PROOF_STAKES = MAX_PROOF_STAKES;
Proof.PROOF_DUST_THRESHOLD = PROOF_DUST_THRESHOLD;
Proof.STAKE_UTXO_CONFIRMATIONS = STAKE_UTXO_CONFIRMATIONS;
Proof.compareIds = compareIds;

module.exports = Proof;
