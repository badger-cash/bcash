/*!
 * spv.js - bcash's SPV node for a web page
 * Copyright (c) 2026, Vin Armani (MIT License).
 * https://github.com/badger-cash/bcash
 */

'use strict';

/*
 * The SPV node in a page: its chain kept in IndexedDB, its peers bcash
 * full nodes reached over the browser's own WebTransport, by certificate
 * hash, starting from a seed list served beside the page. No proxy:
 * browser/build.js bundles this into browser/bcash-spv.js.
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
