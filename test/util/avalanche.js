'use strict';

/*
 * Build avalanche proofs for tests.
 */

const random = require('bcrypto/lib/random');
const secp256k1 = require('bcrypto/lib/secp256k1');
const consensus = require('../../lib/protocol/consensus');
const Outpoint = require('../../lib/primitives/outpoint');
const Script = require('../../lib/script/script');
const Proof = require('../../lib/avalanche/proof');
const {Stake} = require('../../lib/avalanche/stake');

const pub = key => secp256k1.publicKeyCreate(key, true);

function randomOutpoint() {
  return new Outpoint(random.randomBytes(32), 0);
}

/**
 * @param {Object} options
 * @param {Buffer} [options.key] - Master and stake key.
 * @param {Number|BigInt} [options.sequence]
 * @param {Number|BigInt} [options.expiration]
 * @param {Outpoint[]} [options.outpoints] - One random by default.
 * @param {Number|Number[]} [options.amount] - Per stake.
 * @param {Number} [options.height]
 * @param {Boolean} [options.coinbase]
 * @returns {Proof}
 */

function buildProof(options = {}) {
  const key = options.key || secp256k1.privateKeyGenerate();
  const outpoints = options.outpoints || [randomOutpoint()];
  const amount = options.amount != null
    ? options.amount
    : 10 * consensus.COIN;

  const stakes = outpoints.map((outpoint, i) => ({
    stake: new Stake({
      outpoint,
      amount: Array.isArray(amount) ? amount[i] : amount,
      height: options.height != null ? options.height : 123456,
      coinbase: Boolean(options.coinbase),
      pubkey: pub(key)
    }),
    key
  }));

  return Proof.build({
    sequence: BigInt(options.sequence || 0),
    expiration: BigInt(options.expiration || 0),
    masterKey: key,
    payout: Script.fromPubkey(pub(key)),
    stakes
  });
}

exports.pub = pub;
exports.randomOutpoint = randomOutpoint;
exports.buildProof = buildProof;
