/*!
 * chronik.js - a transaction's block height, as a hint
 * Copyright (c) 2026, Vin Armani (MIT License).
 * https://github.com/badger-cash/bcash
 */

'use strict';

/*
 * The height of a transaction's block, from a Chronik indexer (the
 * explorers' backend, which browsers may ask: it allows any origin). Only
 * a hint: a token's genesis is added only once the wallet has fetched
 * that block from its own peers and found the genesis in it, so a wrong
 * height costs a failed check, not trust. Without one, a token is added
 * by hand.
 *
 * Chronik answers in protobuf. Of its Tx message only one path is read:
 * field 8, the block (BlockMetadata), and in it field 1, the height. A
 * transaction not in a block has no field 8.
 */

/**
 * Read a protobuf message's fields, as far as needed here.
 * @param {Uint8Array} data
 * @returns {Array} [{field, type, value}] (a varint as a Number, a
 *   length-delimited field as bytes)
 */

function fields(data) {
  const out = [];
  let i = 0;

  const varint = () => {
    let value = 0;
    let scale = 1;
    for (;;) {
      if (i >= data.length)
        throw new Error('Truncated protobuf.');
      const byte = data[i++];
      value += (byte & 0x7f) * scale;
      if (byte < 0x80)
        return value;
      scale *= 128;
      if (scale > 2 ** 63)
        throw new Error('Bad protobuf varint.');
    }
  };

  while (i < data.length) {
    const key = varint();
    const field = Math.floor(key / 8);
    const type = key % 8;

    switch (type) {
      case 0:
        out.push({field, type, value: varint()});
        break;
      case 1:
        i += 8;
        break;
      case 2: {
        const length = varint();
        if (i + length > data.length)
          throw new Error('Truncated protobuf.');
        out.push({field, type, value: data.subarray(i, i + length)});
        i += length;
        break;
      }
      case 5:
        i += 4;
        break;
      default:
        throw new Error(`Unknown protobuf wire type ${type}.`);
    }
  }

  return out;
}

/**
 * A transaction's block height, from a Chronik Tx message.
 * @param {Uint8Array} data
 * @returns {Number|null} null if not in a block.
 */

function heightOf(data) {
  const block = fields(data).find(f => f.field === 8 && f.type === 2);
  if (!block)
    return null;
  const height = fields(block.value).find(f => f.field === 1 && f.type === 0);
  return height ? height.value : null;
}

/**
 * Ask Chronik indexers, in turn, for a transaction's block height.
 * @param {String[]} urls - each one's base.
 * @param {String} txid
 * @param {Object} [options]
 * @param {Function} [options.fetch]
 * @param {Number} [options.timeout=8000] ms, each
 * @returns {Promise} the height, or null if none says.
 */

async function lookupHeight(urls, txid, options = {}) {
  const get = options.fetch || globalThis.fetch;
  const timeout = options.timeout || 8000;

  if (!/^[0-9a-f]{64}$/.test(txid))
    return null;

  for (const url of urls) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeout);
    try {
      const res = await get(`${url}/tx/${txid}`, {signal: abort.signal});
      if (!res.ok)
        continue;
      const height = heightOf(new Uint8Array(await res.arrayBuffer()));
      if (height != null)
        return height;
    } catch (e) {
      continue;
    } finally {
      clearTimeout(timer);
    }
  }

  return null;
}

// Each network's Chronik indexers, as Cashtab and the explorers use them.
const CHRONIK = {
  main: ['https://chronik.e.cash'],
  testnet: ['https://chronik-testnet.fabien.cash']
};

exports.fields = fields;
exports.heightOf = heightOf;
exports.lookupHeight = lookupHeight;
exports.CHRONIK = CHRONIK;
