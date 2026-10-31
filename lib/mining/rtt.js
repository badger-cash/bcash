/*!
 * rtt.js - real time targeting for bcash
 * Copyright (c) 2026, Marianas Rai Corp (MIT License).
 * Ported from Bitcoin ABC's src/policy/block/rtt.cpp.
 */

'use strict';

const BN = require('bcrypto/lib/bn');
const consensus = require('../protocol/consensus');
const {uint256ToDouble} = require('../avalanche/stakingrewards');

/*
 * Constants
 */

/**
 * Bitcoin ABC's RTT: a block mined too soon after those before it needs
 * more work than its bits say, or eCash nodes park it:
 *   target(t) = target(prev) * RTT_CONSTANT_FACTOR * t^(RTT_K - 1)
 * where t is the time since a past block was received, over windows of
 * 1, 2, 5, 11 and 17 blocks; the lowest target applies.
 */

const RTT_K = 6;

// gamma(1 + 1/RTT_K), which Bitcoin ABC computes with std::tgamma.
const GAMMA = 0.9277193336300394;

// RTT_K * gamma(1 + 1/RTT_K)^RTT_K / T^(RTT_K - 1), where T is the time
// the window should take.
function factor(spacing) {
  return RTT_K * Math.pow(GAMMA, RTT_K) / Math.pow(spacing, RTT_K - 1);
}

// Window (blocks back) to factor.
const RTT_CONSTANT_FACTOR = new Map([
  [1, factor(150)],
  [2, factor(600)],
  [5, factor(2400)],
  [11, factor(6000)],
  [17, factor(9600)]
]);

/**
 * Bitcoin ABC's GetNextRTTWorkRequired: the bits a block after `prev`
 * must meet if received at `now`.
 * @param {Number[]} received - Seconds each of the 17 blocks up to prev
 * was received, prev's first; 0 for a block read from disk.
 * @param {Number} now - Seconds.
 * @param {Number} prevBits - prev's bits.
 * @param {BN} powLimit
 * @returns {Number|null} Bits, or null if RTT does not apply.
 */

function getNextRTTWorkRequired(received, now, prevBits, powLimit) {
  // This block has no receive time.
  if (!now)
    return null;

  // A block read from disk: no reason to apply RTT.
  for (let i = 0; i < 17; i++) {
    if (!received[i])
      return null;
  }

  const prevTarget = consensus.fromCompact(prevBits);

  if (prevTarget.isNeg() || prevTarget.isZero() || prevTarget.gt(powLimit))
    return null;

  const prevTargetDouble = toDouble(prevTarget);

  let minTarget = toDouble(powLimit);

  for (const [i, f] of RTT_CONSTANT_FACTOR) {
    // Zero or negative difftimes are clamped to 1 second.
    const diffTime = Math.max(1, now - received[i - 1]);
    const target = prevTargetDouble * f * Math.pow(diffTime, RTT_K - 1);
    minTarget = Math.min(minTarget, target);
  }

  if (minTarget < 1)
    return null;

  // arith_uint256::fromDouble truncates.
  const next = new BN(BigInt(Math.floor(minTarget)).toString(16), 16);

  if (next.gt(powLimit))
    return null;

  return consensus.toCompact(next);
}

// arith_uint256::getdouble.
function toDouble(num) {
  return uint256ToDouble(num.toArrayLike(Buffer, 'le', 32));
}

/*
 * Expose
 */

exports.RTT_K = RTT_K;
exports.RTT_CONSTANT_FACTOR = RTT_CONSTANT_FACTOR;
exports.getNextRTTWorkRequired = getNextRTTWorkRequired;
