/*!
 * build.js - bundle bcash's SPV node for a web page
 * Copyright (c) 2026, Vin Armani (MIT License).
 * https://github.com/badger-cash/bcash
 */

'use strict';

/*
 * Bundles browser/spv.js into browser/bcash-spv.js, a script exposing
 * `bcash`. bcash's and its dependencies' browser fields pick the browser
 * modules (IndexedDB storage, JavaScript crypto, stubs for TCP, DNS and
 * files); the Node.js built-ins left get a polyfill, a stub (os), or an
 * empty module where the SPV node never calls them.
 */

const path = require('path');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const empty = path.join(__dirname, 'empty.js');
const resolve = name => require.resolve(name, {paths: [root]});

async function build() {
  const outfile = path.join(__dirname, 'bcash-spv.js');

  const result = await esbuild.build({
    entryPoints: [path.join(__dirname, 'spv.js')],
    outfile,
    bundle: true,
    platform: 'browser',
    format: 'iife',
    globalName: 'bcash',
    minify: true,
    metafile: true,
    define: {global: 'globalThis'},
    alias: {
      assert: resolve('assert/'),
      buffer: resolve('buffer/'),
      events: resolve('events/'),
      path: resolve('path-browserify'),
      util: resolve('util/'),
      crypto: empty,
      os: path.join(__dirname, 'os.js')
    },
    logLevel: 'warning'
  });

  const out = result.metafile.outputs[path.relative(process.cwd(), outfile)];

  return {outfile, bytes: out ? out.bytes : null};
}

if (require.main === module) {
  build().then((result) => {
    console.log('Built %s (%d bytes).', result.outfile, result.bytes);
  }).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = build;
