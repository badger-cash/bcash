/*!
 * stakeverifier.js - avalanche stake verifier for bcash
 * Copyright (c) 2026, Marianas Rai Corp (MIT License).
 * Ported from Bitcoin ABC's Proof::verify against the chain, in
 * src/avalanche/proof.cpp.
 */

'use strict';

const assert = require('bsert');
const hash160 = require('bcrypto/lib/hash160');
const Proof = require('./proof');

/**
 * Chain Stake Verifier
 * Checks a proof's stakes against a full node's coins.
 * @alias module:avalanche.ChainStakeVerifier
 */

class ChainStakeVerifier {
  /**
   * @param {Object} options
   * @param {Chain} options.chain
   * @param {Number} [options.dustThreshold] - Least stake, in satoshis.
   * @param {Number} [options.confirmations] - Before a coin is mature.
   */

  constructor(options) {
    assert(options && options.chain);
    this.chain = options.chain;
    this.dustThreshold = options.dustThreshold != null
      ? options.dustThreshold
      : Proof.PROOF_DUST_THRESHOLD;
    this.confirmations = options.confirmations != null
      ? options.confirmations
      : Proof.STAKE_UTXO_CONFIRMATIONS;
  }

  /**
   * Check a proof, then its stakes against the chain tip.
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
      const coin = await this.chain.db.readCoin(stake.outpoint);

      if (!coin)
        return [false, 'utxo-missing-or-spent'];

      if (stake.coinbase !== coin.coinbase)
        return [false, 'coinbase-mismatch'];

      if (stake.height !== coin.height)
        return [false, 'height-mismatch'];

      if (stake.amount !== coin.output.value)
        return [false, 'amount-mismatch'];

      // As Bitcoin ABC's ExtractDestination: P2PK pays a key hash too.
      const script = coin.output.script;
      let hash = null;

      if (script.isPubkeyhash())
        hash = script.getPubkeyhash();
      else if (script.isPubkey())
        hash = hash160.digest(script.getPubkey());
      else if (script.isScripthash())
        return [false, 'destination-type-not-supported'];
      else
        return [false, 'non-standard-destination'];

      if (!hash.equals(hash160.digest(stake.pubkey)))
        return [false, 'destination-mismatch'];

      if (stake.height + this.confirmations - 1 > height)
        return [false, 'immature-utxo'];
    }

    return [true, 'valid'];
  }
}

/*
 * Expose
 */

module.exports = ChainStakeVerifier;
