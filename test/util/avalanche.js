'use strict';

/*
 * Build avalanche proofs for tests.
 */

const hash160 = require('bcrypto/lib/hash160');
const random = require('bcrypto/lib/random');
const secp256k1 = require('bcrypto/lib/secp256k1');
const consensus = require('../../lib/protocol/consensus');
const CoinEntry = require('../../lib/coins/coinentry');
const Outpoint = require('../../lib/primitives/outpoint');
const Output = require('../../lib/primitives/output');
const Script = require('../../lib/script/script');
const Proof = require('../../lib/avalanche/proof');
const {Stake} = require('../../lib/avalanche/stake');

const pub = key => secp256k1.publicKeyCreate(key, true);

function randomOutpoint() {
  return new Outpoint(random.randomBytes(32), 0);
}

/**
 * @param {Object} options
 * @param {Buffer} [options.key] - Stake key, and master key by default.
 * @param {Buffer} [options.master] - Master key.
 * @param {Number|BigInt} [options.sequence]
 * @param {Number|BigInt} [options.expiration]
 * @param {Outpoint[]} [options.outpoints] - One random by default.
 * @param {Number|Number[]} [options.amount] - Per stake.
 * @param {Number|Number[]} [options.height] - Per stake.
 * @param {Boolean} [options.coinbase]
 * @returns {Proof}
 */

function buildProof(options = {}) {
  const key = options.key || secp256k1.privateKeyGenerate();
  const master = options.master || key;
  const outpoints = options.outpoints || [randomOutpoint()];
  const amount = options.amount != null
    ? options.amount
    : 10 * consensus.COIN;

  const height = options.height != null ? options.height : 123456;

  const stakes = outpoints.map((outpoint, i) => ({
    stake: new Stake({
      outpoint,
      amount: Array.isArray(amount) ? amount[i] : amount,
      height: Array.isArray(height) ? height[i] : height,
      coinbase: Boolean(options.coinbase),
      pubkey: pub(key)
    }),
    key
  }));

  return Proof.build({
    sequence: BigInt(options.sequence || 0),
    expiration: BigInt(options.expiration || 0),
    masterKey: master,
    payout: Script.fromPubkey(pub(master)),
    stakes
  });
}

/**
 * Just enough of a chain for ChainStakeVerifier: a tip, a height, its
 * median time past, and coins.
 */

class FakeChain {
  constructor(height = 100) {
    this.height = height;
    this.mtp = 0;
    this.tip = {};
    this.coins = new Map();
    this.db = {
      readCoin: async (prevout) => {
        return this.coins.get(prevout.toKey().toString('hex')) || null;
      }
    };
  }

  async getMedianTime() {
    return this.mtp;
  }

  /**
   * Add a P2PKH coin paying a key.
   */

  addCoin(outpoint, key, amount = Proof.PROOF_DUST_THRESHOLD, height = 100,
    coinbase = false) {
    const coin = new CoinEntry();
    coin.height = height;
    coin.coinbase = coinbase;
    coin.output = Output.fromOptions({
      value: amount,
      script: Script.fromPubkeyhash(hash160.digest(pub(key)))
    });
    this.coins.set(outpoint.toKey().toString('hex'), coin);
    return coin;
  }

  createUtxo(key, amount, height, coinbase) {
    const outpoint = randomOutpoint();
    this.addCoin(outpoint, key, amount, height, coinbase);
    return outpoint;
  }

  spendCoin(outpoint) {
    return this.coins.delete(outpoint.toKey().toString('hex'));
  }
}

// Bitcoin ABC's least valid proof score: one stake at the dust threshold.
const MIN_VALID_PROOF_SCORE = Proof.amountToScore(Proof.PROOF_DUST_THRESHOLD);

/**
 * Bitcoin ABC's buildRandomProof: one fresh coin worth a score, staked
 * by a random key, paid out to that key.
 * @param {FakeChain} chain
 * @param {Number} score
 * @param {Number} [height=100]
 * @param {Buffer} [masterKey]
 * @returns {Proof}
 */

function buildRandomProof(chain, score, height = 100, masterKey) {
  const key = secp256k1.privateKeyGenerate();
  const outpoint = randomOutpoint();
  const amount = score * (consensus.COIN / 100);

  chain.addCoin(outpoint, key, amount, height, false);

  const stake = new Stake({
    outpoint,
    amount,
    height,
    coinbase: false,
    pubkey: pub(key)
  });

  return Proof.build({
    sequence: 0n,
    expiration: 0xffffffffn,
    masterKey: masterKey || secp256k1.privateKeyGenerate(),
    payout: Script.fromPubkeyhash(hash160.digest(pub(key))),
    stakes: [{stake, key}]
  });
}

exports.pub = pub;
exports.randomOutpoint = randomOutpoint;
exports.buildProof = buildProof;
exports.FakeChain = FakeChain;
exports.MIN_VALID_PROOF_SCORE = MIN_VALID_PROOF_SCORE;
exports.buildRandomProof = buildRandomProof;
