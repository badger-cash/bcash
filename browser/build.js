/*!
 * build.js - bundle bcash's SPV node for a web page
 * Copyright (c) 2026, Vin Armani (MIT License).
 * https://github.com/badger-cash/bcash
 */

'use strict';

/*
 * Bundles browser/spv.js into browser/bcash-spv.js, a script exposing
 * `bcash`, the wallet page's app (browser/app.js) into
 * browser/bcash-wallet.js, and its QR code reader, loaded only when used,
 * into browser/bcash-scan.js. The wallet's bundle takes the English
 * wordlist alone (browser/wordlist-english.js), and the browser's own
 * Unicode normalization.
 *
 * Each bundle is also written compressed beside it, Brotli (.br, at its
 * best) and gzip (.gz), for a server that sends files as they are stored
 * (nginx's brotli_static and gzip_static, Caddy's precompressed); any
 * other compresses them itself, or sends them plain.
 *
 * bcash's and its dependencies' browser fields pick the browser modules
 * (IndexedDB storage, JavaScript crypto, stubs for TCP, DNS and files);
 * the Node.js built-ins left get a polyfill, a stub (os), or an empty
 * module where the SPV node never calls them.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const empty = path.join(__dirname, 'empty.js');
const resolve = name => require.resolve(name, {paths: [root]});

// The wallet's: English phrases only (the other lists were most of the
// bundle), and Unicode normalization by the browser's own
// String#normalize, as bcash does in Node, not the tables its browser
// field brings for browsers without it: every one with WebTransport has it.
const walletOnly = {
  name: 'wallet-only',
  setup(build) {
    const hd = path.join(root, 'lib', 'hd');
    build.onResolve({filter: /^\.\/(wordlist|nfkd)$/}, (args) => {
      if (args.resolveDir !== hd)
        return null;
      if (args.path === './wordlist')
        return {path: path.join(__dirname, 'wordlist-english.js')};
      return {path: path.join(hd, 'nfkd.js')};
    });
  }
};

async function bundle(entry, outfile, globalName, plugins = []) {
  const result = await esbuild.build({
    entryPoints: [path.join(__dirname, entry)],
    outfile,
    bundle: true,
    platform: 'browser',
    format: 'iife',
    globalName,
    plugins,
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

/**
 * Write a file's Brotli and gzip forms beside it.
 */

function precompress(file) {
  const data = fs.readFileSync(file);

  fs.writeFileSync(`${file}.br`, zlib.brotliCompressSync(data, {
    params: {
      [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
      [zlib.constants.BROTLI_PARAM_QUALITY]:
        zlib.constants.BROTLI_MAX_QUALITY,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length
    }
  }));

  fs.writeFileSync(`${file}.gz`, zlib.gzipSync(data, {
    level: zlib.constants.Z_BEST_COMPRESSION
  }));
}

async function build() {
  const results = await bundles();

  for (const {outfile} of results)
    precompress(outfile);
  precompress(path.join(__dirname, 'index.html'));

  return results;
}

async function bundles() {
  return [
    await bundle('spv.js', path.join(__dirname, 'bcash-spv.js'), 'bcash'),
    await bundle('app.js', path.join(__dirname, 'bcash-wallet.js'),
      undefined, [walletOnly]),
    await bundle('scan.js', path.join(__dirname, 'bcash-scan.js'),
      'bcashScan')
  ];
}

if (require.main === module) {
  build().then((results) => {
    for (const result of results)
      console.log('Built %s (%d bytes).', result.outfile, result.bytes);
  }).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = build;
