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
