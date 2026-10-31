/*!
 * coinbasepolicy.js - coinbase outputs eCash nodes require of a block
 * Copyright (c) 2026, Marianas Rai Corp (MIT License).
 * Ported from Bitcoin ABC's src/minerfund.cpp and
 * src/policy/block/stakingrewards.cpp.
 */

'use strict';

const Script = require('../script/script');
const {getStakingRewardAmount} = require('../avalanche/stakingrewards');

/*
 * Constants
 */

// The miner fund's P2SH hash: ecash:prfhcnyqnl5cgrnmlfmms675w93ld7mvvqd0y8lz07
// on every network, as Bitcoin ABC decodes it with mainnet parameters.
const MINER_FUND_HASH =
  Buffer.from('d37c4c809fe9840e7bfa77b86bd47163f6fb6c60', 'hex');

// Share of the block reward, in percent, for the miner fund: from
// Cowperthwaite, and before.
const MINER_FUND_RATIO = 32;
const LEGACY_MINER_FUND_RATIO = 8;

/*
 * Activations, as Bitcoin ABC checks them on the previous block. bcash's
 * heights are of the first block with the rules.
 */

function isActive(network, prev, name) {
  const height = network.block[name];
  return prev != null && height != null && prev.height + 1 >= height;
}

function isWellingtonEnabled(network, prev) {
  return isActive(network, prev, 'wellingtonHeight');
}

function isCowperthwaiteEnabled(network, prev) {
  return isActive(network, prev, 'cowperthwaiteHeight');
}

/**
 * The least the miner fund must be paid.
 * @param {Network} network
 * @param {Number} reward - Subsidy and fees.
 * @param {ChainEntry} prev
 * @returns {Number}
 */

function getMinerFundAmount(network, reward, prev) {
  const ratio = isCowperthwaiteEnabled(network, prev)
    ? MINER_FUND_RATIO
    : LEGACY_MINER_FUND_RATIO;
  return Math.floor(ratio * reward / 100);
}

function getMinerFundScript() {
  return Script.fromScripthash(MINER_FUND_HASH);
}

/**
 * The outputs a coinbase must have, besides the miner's own: the miner
 * fund (from Wellington, if enabled) and the staking reward winner (if
 * one is known).
 * @param {Object} options
 * @param {Network} options.network
 * @param {ChainEntry} options.prev
 * @param {Number} options.reward - Subsidy and fees.
 * @param {Boolean} options.minerFund
 * @param {Script|null} options.stakingWinner
 * @returns {Object[]} [{script, value}]
 */

function getCoinbaseOutputs(options) {
  const {network, prev, reward} = options;
  const outputs = [];

  if (options.minerFund && isWellingtonEnabled(network, prev)) {
    outputs.push({
      script: getMinerFundScript(),
      value: getMinerFundAmount(network, reward, prev)
    });
  }

  if (options.stakingWinner) {
    outputs.push({
      script: options.stakingWinner,
      value: getStakingRewardAmount(reward)
    });
  }

  return outputs;
}

/**
 * Bitcoin ABC's MinerFundPolicy: whether a block after `prev` pays the
 * miner fund at least its share, in one output, from Wellington on.
 * @param {Network} network
 * @param {Output[]} outputs - The coinbase's.
 * @param {Number} reward - Subsidy and fees.
 * @param {ChainEntry} prev
 * @returns {Boolean}
 */

function checkMinerFund(network, outputs, reward, prev) {
  if (!isWellingtonEnabled(network, prev))
    return true;

  const required = getMinerFundAmount(network, reward, prev);
  const script = getMinerFundScript().toRaw();

  return outputs.some(output => output.value >= required
    && output.script.toRaw().equals(script));
}

/**
 * Bitcoin ABC's StakingRewardsPolicy: whether a block pays one of the
 * staking reward winners at least its share, in one output.
 * @param {Output[]} outputs - The coinbase's.
 * @param {Number} reward - Subsidy and fees.
 * @param {Object[]} winners - [{payout}]; the winner first.
 * @returns {Boolean}
 */

function checkStakingReward(outputs, reward, winners) {
  const required = getStakingRewardAmount(reward);

  return outputs.some(output => output.value >= required
    && winners.some(w => w.payout.toRaw().equals(output.script.toRaw())));
}

/*
 * Expose
 */

exports.MINER_FUND_HASH = MINER_FUND_HASH;
exports.MINER_FUND_RATIO = MINER_FUND_RATIO;
exports.LEGACY_MINER_FUND_RATIO = LEGACY_MINER_FUND_RATIO;
exports.isWellingtonEnabled = isWellingtonEnabled;
exports.isCowperthwaiteEnabled = isCowperthwaiteEnabled;
exports.getMinerFundAmount = getMinerFundAmount;
exports.getMinerFundScript = getMinerFundScript;
exports.getCoinbaseOutputs = getCoinbaseOutputs;
exports.checkMinerFund = checkMinerFund;
exports.checkStakingReward = checkStakingReward;
