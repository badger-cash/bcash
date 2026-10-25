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
 *
 * Send a token: its own valid coins as the token inputs (no other
 * token's, which would burn), XEC coins for the dust and the fee, an SLP
 * SEND of the token's type with the change of both back to the key.
 */

const assert = require('bsert');
const Address = require('../../lib/primitives/address');
const Coin = require('../../lib/primitives/coin');
const MTX = require('../../lib/primitives/mtx');
const Script = require('../../lib/script/script');
const SLP = require('../../lib/script/slp');
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
 * What a payment QR code says: an address, as is or as a URI with an
 * amount in XEC (ecash:q...?amount=12.34).
 * @returns {Object} {address (with its prefix), value (sats, or null)}
 */

function parsePaymentURI(text, network) {
  text = text.trim();

  const [base, query = ''] = text.split('?');
  const address = parseAddress(base, network).toString(network);

  let value = null;
  const amount = new URLSearchParams(query).get('amount');
  if (amount != null) {
    value = toSats(amount);
    if (value == null)
      throw new Error('The code\'s amount is not one this wallet reads.');
  }

  return {address, value};
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

// What an output carrying tokens holds in XEC.
const DUST = 546;

const toCoin = c => Coin.fromOptions({
  version: 1,
  height: c.height,
  value: c.value,
  script: Script.fromRaw(Buffer.from(c.script, 'hex')),
  coinbase: false,
  hash: Buffer.from(c.txid, 'hex').reverse(),
  index: c.vout
});

/**
 * A token amount as typed ("0.05"), in base units, for its decimals.
 * @returns {BigInt|null}
 */

function toBase(text, decimals) {
  // "0.05", ".05", "5" and "5." alike: some digit, few enough decimals.
  const m = /^\s*(\d{0,19})(?:\.(\d*))?\s*$/.exec(text);
  if (!m || (m[1] + (m[2] || '')).length === 0)
    return null;
  if ((m[2] || '').length > decimals)
    return null;
  return BigInt((m[1] || '0') + (m[2] || '').padEnd(decimals, '0'));
}

/**
 * An amount of XEC as typed, in sats: 2 decimals.
 * @returns {Number|null}
 */

function toSats(text) {
  const base = toBase(text, 2);
  if (base == null || base > BigInt(Number.MAX_SAFE_INTEGER))
    return null;
  return Number(base);
}

/**
 * Base units as the token shows them ("0.05").
 */

function fromBase(base, decimals) {
  const text = BigInt(base).toString().padStart(decimals + 1, '0');
  if (decimals === 0)
    return text;
  return `${text.slice(0, -decimals)}.${text.slice(-decimals)}`;
}

/**
 * An SLP SEND script, every field a data push.
 */

function sendScript(version, tokenId, amounts) {
  const push = (data) => {
    assert(data.length > 0 && data.length < 0x4c);
    return Buffer.concat([Buffer.from([data.length]), data]);
  };
  const u64 = (n) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64BE(n);
    return b;
  };
  const script = Script.fromRaw(Buffer.concat([
    Buffer.from([0x6a]),
    push(Buffer.from('534c5000', 'hex')),
    push(Buffer.from([version])),
    push(Buffer.from('SEND')),
    push(Buffer.from(tokenId, 'hex')),
    ...amounts.map(a => push(u64(a)))
  ]));
  assert(SLP.fromScript(script).isValidSlp(), 'Bad SLP script.');
  return script;
}

/**
 * Build and sign a token payment.
 * @param {Object} options
 * @param {Coins} options.coins
 * @param {Tokens} options.tokens
 * @param {KeyRing} options.ring
 * @param {String} options.address - the key's own.
 * @param {String} options.to
 * @param {String} options.tokenId
 * @param {BigInt} options.amount - base units.
 * @returns {Promise} {tx, fee, amount}
 */

async function buildTokenPayment({coins, tokens, ring, address, to, tokenId,
  amount}) {
  const network = coins.network;
  const dest = parseAddress(to, network);
  const token = tokens.get(tokenId);
  assert(token, 'Add the token first.');
  assert(typeof amount === 'bigint' && amount > 0n, 'Enter an amount.');

  // The token's valid coins, largest first, until they cover it.
  const have = tokens.spendable(address, tokenId)
    .sort((a, b) => (BigInt(b.slp.amount) > BigInt(a.slp.amount) ? 1 : -1));
  const chosen = [];
  let total = 0n;
  for (const coin of have) {
    if (total >= amount)
      break;
    chosen.push(coin);
    total += BigInt(coin.slp.amount);
  }
  assert(total >= amount, `Not enough verified ${token.ticker || 'tokens'}.`);

  const change = total - amount;
  const mtx = new MTX();
  mtx.addOutput(sendScript(token.version, tokenId,
    change > 0n ? [amount, change] : [amount]), 0);
  mtx.addOutput(dest, DUST);
  if (change > 0n)
    mtx.addOutput(ring.getAddress(), DUST);

  for (const coin of chosen)
    mtx.addCoin(toCoin(coin));

  // XEC for the dust and the fee: plain coins only.
  const xecCoins = coins.spendable(address).sort((a, b) => b.value - a.value);
  const need = () => mtx.outputs.reduce((s, o) => s + o.value, 0)
    + 250 + 150 * mtx.inputs.length + 50 * mtx.outputs.length;
  for (const coin of xecCoins) {
    if (mtx.getInputValue() >= need())
      break;
    mtx.addCoin(toCoin(coin));
  }
  assert(mtx.getInputValue() >= need(), 'Not enough XEC for the fee.');

  // Change, then the fee at 1 sat a byte from the signed size.
  mtx.addOutput(ring.getAddress(), 0);
  const last = mtx.outputs.length - 1;
  const spare = () => mtx.getInputValue()
    - mtx.outputs.slice(0, last).reduce((s, o) => s + o.value, 0);

  mtx.outputs[last].value = spare();
  mtx.sign(ring);
  const fee = mtx.getSize() + 10;
  for (const input of mtx.inputs)
    input.script = new Script();

  if (spare() - fee >= DUST) {
    mtx.outputs[last].value = spare() - fee;
  } else {
    // Too little left for change: it goes to the fee.
    mtx.outputs.pop();
  }

  mtx.sign(ring);
  assert(mtx.verify(), 'The payment did not verify.');

  return {tx: mtx.toTX(), fee: mtx.getFee(), amount};
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
exports.parsePaymentURI = parsePaymentURI;
exports.buildPayment = buildPayment;
exports.buildTokenPayment = buildTokenPayment;
exports.toBase = toBase;
exports.toSats = toSats;
exports.fromBase = fromBase;
exports.DUST = DUST;
exports.sendPayment = sendPayment;
