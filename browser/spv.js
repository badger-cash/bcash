/*!
 * spv.js - bcash's SPV node for a web page
 * Copyright (c) 2026, Vin Armani (MIT License).
 * https://github.com/badger-cash/bcash
 */

'use strict';

/*
 * The SPV node in a page: its chain kept in IndexedDB, its peers bcash
 * full nodes reached over the browser's own WebTransport, found from the
 * network's seeds (domains, as DNS seeds) and remembered for the next
 * visit. No proxy: browser/build.js bundles this into browser/bcash-spv.js.
 */

// Globals bcash takes from Node.js, set before any of it loads.
globalThis.Buffer = require('buffer').Buffer;
globalThis.process = require('process/browser');

exports.SPVNode = require('../lib/node/spvnode');
exports.Chain = require('../lib/blockchain/chain');
exports.Pool = require('../lib/net/pool');
exports.Network = require('../lib/protocol/network');
exports.Address = require('../lib/primitives/address');
exports.KeyRing = require('../lib/primitives/keyring');
exports.Script = require('../lib/script/script');
exports.TX = require('../lib/primitives/tx');
exports.MTX = require('../lib/primitives/mtx');
// What a page's own transactions take beyond the wallet's: coins, outputs,
// SLP scripts, and BIP70 whole: a PaymentRequest to pay, its certificate
// chain to check where it came by a channel HTTPS does not authenticate, the
// Payment and the PaymentACK answering it.
exports.Coin = require('../lib/primitives/coin');
exports.Outpoint = require('../lib/primitives/outpoint');
exports.Output = require('../lib/primitives/output');
exports.consensus = require('../lib/protocol/consensus');
exports.script = {SLP: require('../lib/script/slp')};
exports.bip70 = require('../lib/bip70');

/**
 * The newest checkpoint built into bcash for a network, as an anchor for
 * the SPV node: a page starts its chain there, not at genesis. It trusts
 * the checkpoint as it trusts this code, which carries it; every header
 * after it is checked.
 * @param {String} network
 * @returns {Object} {height, hash (as displayed)}
 */

exports.newestCheckpoint = function newestCheckpoint(network) {
  const {checkpointMap} = exports.Network.get(network);
  const height = Math.max(...Object.keys(checkpointMap).map(Number));

  return {
    height,
    hash: Buffer.from(checkpointMap[height]).reverse().toString('hex')
  };
};

/**
 * Keep the WebTransport nodes a page learned in localStorage, for the
 * pool's wtStore: a page that comes back starts from them.
 * @param {String} key
 * @returns {Object} {load, save}
 */

exports.localStore = function localStore(key) {
  return {
    async load() {
      try {
        const value = globalThis.localStorage.getItem(key);
        return value ? Buffer.from(value, 'base64') : null;
      } catch (e) {
        return null;
      }
    },
    async save(data) {
      try {
        globalThis.localStorage.setItem(key, data.toString('base64'));
      } catch (e) {
        ;
      }
    }
  };
};
