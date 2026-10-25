/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * The web wallet's block height hint (browser/wallet/chronik.js): from a
 * Chronik Tx message, its block's height; from none, nothing. The fixture
 * is chronik-testnet.fabien.cash's answer for the TCENT genesis, 4d7f7032...,
 * in testnet block 1,737,200.
 */

const assert = require('bsert');
const fs = require('fs');
const path = require('path');
const {heightOf, lookupHeight} = require('../browser/wallet/chronik');

const TXID = '4d7f70321939cd4108bd5fb7ca71306b1fe781f9e0afd05ebc6ae4b061b41c9c';
const answer = fs.readFileSync(path.join(__dirname, 'data',
  'chronik-tx-tcent-genesis.bin'));

// A Chronik Tx message without its block: fields 1 (txid) and 2 only.
const unconfirmed = Buffer.concat([Buffer.from([0x0a, 0x20]),
  Buffer.alloc(32, 1), Buffer.from([0x10, 0x02])]);

describe('Web wallet height hint', function() {
  it('should read a transaction\'s block height', () => {
    assert.strictEqual(heightOf(answer), 1737200);
    assert.strictEqual(heightOf(unconfirmed), null);
    // Cut inside a field (its inputs, from byte 36): an error, not a guess.
    assert.throws(() => heightOf(answer.subarray(0, 40)), /Truncated/);
  });

  it('should ask each indexer in turn', async () => {
    const asked = [];
    const fetch = async (url) => {
      asked.push(url);
      if (url.startsWith('https://down'))
        return {ok: false};
      return {ok: true, arrayBuffer: async () => answer};
    };

    assert.strictEqual(await lookupHeight(['https://down', 'https://up'],
      TXID, {fetch}), 1737200);
    assert.deepStrictEqual(asked,
      [`https://down/tx/${TXID}`, `https://up/tx/${TXID}`]);

    // Nothing to say: null, not a guess.
    assert.strictEqual(await lookupHeight(['https://up'], TXID, {
      fetch: async () => ({ok: true, arrayBuffer: async () => unconfirmed})
    }), null);
    assert.strictEqual(await lookupHeight(['https://up'], 'not a txid',
      {fetch}), null);
  });
});
