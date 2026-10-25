/*!
 * send.js - a web wallet's payments
 * Copyright (c) 2026, Vin Armani (MIT License).
 * https://github.com/badger-cash/bcash
 */

'use strict';

/*
 * Pay XEC from a key: its spendable coins only (never one kept apart for
 * tokens), change back to the key, the fee at the relay minimum, signed
 * and checked here before it goes to peers.
 */

const assert = require('bsert');
const Address = require('../../lib/primitives/address');
const Coin = require('../../lib/primitives/coin');
const MTX = require('../../lib/primitives/mtx');
const Script = require('../../lib/script/script');
const policy = require('../../lib/protocol/policy');

// 1 sat a byte: the relay minimum on eCash.
const RATE = policy.MIN_RELAY;

/**
 * An address as typed: with its prefix, or without.
 */

function parseAddress(text, network) {
  text = text.trim();

  if (!text.includes(':')) {
    const prefix = Address.fromHash(Buffer.alloc(20))
      .toString(network).split(':')[0];
    text = `${prefix}:${text}`;
  }

  try {
    return Address.fromString(text, network);
  } catch (e) {
    throw new Error('Not an address for this network.');
  }
}

/**
 * Build and sign a payment.
 * @param {Object} options
 * @param {Coins} options.coins
 * @param {KeyRing} options.ring
 * @param {String} options.address - the key's own.
 * @param {String} options.to
 * @param {Number} [options.value] - sats; with `max`, all of it.
 * @param {Boolean} [options.max]
 * @returns {Promise} {tx, fee, value}
 */

async function buildPayment({coins, ring, address, to, value, max = false}) {
  const network = coins.network;
  const dest = parseAddress(to, network);

  const spendable = coins.spendable(address).map(c => Coin.fromOptions({
    version: 1,
    height: c.height,
    value: c.value,
    script: Script.fromRaw(Buffer.from(c.script, 'hex')),
    coinbase: false,
    hash: Buffer.from(c.txid, 'hex').reverse(),
    index: c.vout
  }));

  const total = spendable.reduce((sum, c) => sum + c.value, 0);
  assert(total > 0, 'Nothing to spend.');

  const mtx = new MTX();

  if (max) {
    mtx.addOutput(dest, total);
  } else {
    assert(Number.isSafeInteger(value) && value > 0, 'Enter an amount.');
    mtx.addOutput(dest, value);
    assert(!mtx.outputs[0].isDust(RATE),
      'Too small: below the dust limit (5.46 XEC).');
  }

  try {
    await mtx.fund(spendable, {
      changeAddress: ring.getAddress(),
      rate: RATE,
      selection: max ? 'all' : 'value',
      subtractFee: max ? 0 : -1
    });
  } catch (e) {
    throw new Error(max
      ? 'Too little to pay the fee.'
      : 'Not enough XEC for that and the fee.');
  }

  mtx.sign(ring);
  assert(mtx.verify(), 'The payment did not verify.');

  const tx = mtx.toTX();

  return {tx, fee: mtx.getFee(), value: mtx.outputs[0].value};
}

/**
 * Send it: to peers, and into the wallet at once, unconfirmed.
 */

async function sendPayment({coins, node, tx}) {
  coins.addTX(tx, -1, null);
  await node.sendTX(tx);
}

exports.RATE = RATE;
exports.parseAddress = parseAddress;
exports.buildPayment = buildPayment;
exports.sendPayment = sendPayment;
