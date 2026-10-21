/*!
 * protocol.js - avalanche messages for bcash
 * Copyright (c) 2026, Marianas Rai Corp (MIT License).
 * Ported from Bitcoin ABC's src/avalanche/protocol.h and the signing in
 * src/avalanche/processor.cpp and src/net_processing.cpp.
 */

'use strict';

const assert = require('bsert');
const bio = require('bufio');
const hash256 = require('bcrypto/lib/hash256');
const secp256k1 = require('bcrypto/lib/secp256k1');
const InvItem = require('../primitives/invitem');
const Delegation = require('./delegation');
const {schnorrVerify, writeU64, readU64} = require('./stake');

/*
 * Constants
 */

// Inventory types for what avalanche votes on.
const invTypes = {
  TX: InvItem.types.TX,
  BLOCK: InvItem.types.BLOCK,
  AVA_PROOF: 0x1f000001,
  AVA_STAKE_CONTENDER: 0x1f000002
};

// Items a poll may carry: the least a node may accept, and what Bitcoin
// ABC accepts by default. Each node says its own in its hello.
const MAX_ELEMENT_POLL_LEGACY = 16;
const DEFAULT_MAX_ELEMENT_POLL = 1024;

/**
 * Hello (avahello)
 * A node's delegation, and the session key's signature binding it to
 * this connection. A delegation with a zero limited id means no proof.
 * @alias module:avalanche.Hello
 */

class Hello {
  constructor(delegation, signature,
    maxElements = DEFAULT_MAX_ELEMENT_POLL) {
    this.delegation = delegation || new Delegation();
    this.signature = signature || Buffer.alloc(64);
    this.maxElements = maxElements;
  }

  hasProof() {
    return !this.delegation.limitedId.equals(Buffer.alloc(32));
  }

  /**
   * The hash a hello signs. The signer's nonce and extra entropy come
   * before the receiver's.
   * @param {Buffer} delegationId
   * @param {Buffer} signerNonce - 8 byte version nonce.
   * @param {Buffer} receiverNonce
   * @param {BigInt} signerEntropy - Version extra entropy.
   * @param {BigInt} receiverEntropy
   * @returns {Buffer}
   */

  static sighash(delegationId, signerNonce, receiverNonce,
    signerEntropy, receiverEntropy) {
    assert(signerNonce.length === 8 && receiverNonce.length === 8);
    const bw = bio.write(32 + 8 * 4);
    bw.writeBytes(delegationId);
    bw.writeBytes(signerNonce);
    bw.writeBytes(receiverNonce);
    writeU64(bw, signerEntropy);
    writeU64(bw, receiverEntropy);
    return hash256.digest(bw.render());
  }

  sign(key, ...args) {
    const hash = Hello.sighash(this.delegation.id(), ...args);
    this.signature = secp256k1.schnorrSign(hash, key);
    return this;
  }

  /**
   * Check a peer's hello: its delegation, and its signature by the
   * delegated key.
   * @returns {Array} [valid, reason, pubkey] - pubkey is the session key.
   */

  verify(...args) {
    const [valid, reason, pubkey] = this.delegation.verify();

    if (!valid)
      return [false, reason, pubkey];

    const hash = Hello.sighash(this.delegation.id(), ...args);

    if (!schnorrVerify(hash, this.signature, pubkey))
      return [false, 'invalid-avahello-signature', pubkey];

    return [true, 'valid', pubkey];
  }

  getSize() {
    return this.delegation.getSize() + 64 + 4;
  }

  toWriter(bw) {
    this.delegation.toWriter(bw);
    bw.writeBytes(this.signature);
    bw.writeU32(this.maxElements);
    return bw;
  }

  toRaw() {
    return this.toWriter(bio.write(this.getSize())).render();
  }

  fromReader(br) {
    this.delegation = Delegation.fromReader(br);
    this.signature = br.readBytes(64);
    this.maxElements = br.readU32();
    return this;
  }

  static fromRaw(data) {
    return new this().fromReader(bio.read(data));
  }
}

/**
 * Poll (avapoll)
 * @alias module:avalanche.Poll
 * @property {BigInt} round
 * @property {InvItem[]} invs
 */

class Poll {
  constructor(round = 0n, invs = []) {
    this.round = round;
    this.invs = invs;
  }

  getSize() {
    return 8 + bio.sizeVarint(this.invs.length) + this.invs.length * 36;
  }

  toWriter(bw) {
    writeU64(bw, this.round);
    bw.writeVarint(this.invs.length);
    for (const inv of this.invs)
      inv.toWriter(bw);
    return bw;
  }

  toRaw() {
    return this.toWriter(bio.write(this.getSize())).render();
  }

  fromReader(br) {
    this.round = readU64(br);

    const count = br.readVarint();

    this.invs = [];
    for (let i = 0; i < count; i++)
      this.invs.push(InvItem.fromReader(br));

    return this;
  }

  static fromRaw(data) {
    return new this().fromReader(bio.read(data));
  }
}

/**
 * Vote
 * @alias module:avalanche.Vote
 * @property {Number} error - 0 is yes; see VoteRecord#registerVote.
 * @property {Buffer} hash
 */

class Vote {
  constructor(error = 0xffffffff, hash = Buffer.alloc(32)) {
    this.error = error;
    this.hash = hash;
  }
}

/**
 * Response (avaresponse)
 * Votes in reply to a poll, signed by the session key.
 * @alias module:avalanche.Response
 * @property {BigInt} round
 * @property {Number} cooldown - Milliseconds before the next poll.
 * @property {Vote[]} votes
 * @property {Buffer} signature
 */

class Response {
  constructor(round = 0n, cooldown = 0, votes = []) {
    this.round = round;
    this.cooldown = cooldown;
    this.votes = votes;
    this.signature = Buffer.alloc(64);
  }

  getUnsignedSize() {
    return 8 + 4 + bio.sizeVarint(this.votes.length) + this.votes.length * 36;
  }

  writeUnsigned(bw) {
    writeU64(bw, this.round);
    bw.writeU32(this.cooldown);
    bw.writeVarint(this.votes.length);
    for (const {error, hash} of this.votes) {
      bw.writeU32(error);
      bw.writeBytes(hash);
    }
    return bw;
  }

  sighash() {
    const bw = bio.write(this.getUnsignedSize());
    return hash256.digest(this.writeUnsigned(bw).render());
  }

  sign(key) {
    this.signature = secp256k1.schnorrSign(this.sighash(), key);
    return this;
  }

  verify(pubkey) {
    return schnorrVerify(this.sighash(), this.signature, pubkey);
  }

  getSize() {
    return this.getUnsignedSize() + 64;
  }

  toWriter(bw) {
    this.writeUnsigned(bw);
    bw.writeBytes(this.signature);
    return bw;
  }

  toRaw() {
    return this.toWriter(bio.write(this.getSize())).render();
  }

  fromReader(br) {
    this.round = readU64(br);
    this.cooldown = br.readU32();

    const count = br.readVarint();

    this.votes = [];
    for (let i = 0; i < count; i++)
      this.votes.push(new Vote(br.readU32(), br.readBytes(32)));

    this.signature = br.readBytes(64);
    return this;
  }

  static fromRaw(data) {
    return new this().fromReader(bio.read(data));
  }
}

/*
 * Expose
 */

exports.invTypes = invTypes;
exports.MAX_ELEMENT_POLL_LEGACY = MAX_ELEMENT_POLL_LEGACY;
exports.DEFAULT_MAX_ELEMENT_POLL = DEFAULT_MAX_ELEMENT_POLL;
exports.Hello = Hello;
exports.Poll = Poll;
exports.Vote = Vote;
exports.Response = Response;
