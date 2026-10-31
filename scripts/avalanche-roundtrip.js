#!/usr/bin/env node

'use strict';

/*
 * Measure how soon a transaction we broadcast is final by avalanche
 * pre-consensus, as an SPV client sees it. Each round spends our coin back
 * to ourselves and times, from the broadcast:
 *   - request: a peer first asks for it (getdata): the network has it;
 *   - back:    a peer of a second, listening pool announces it (inv): it
 *              is in another node's mempool and being relayed. (Our own
 *              peers never announce it to us: they know we have it.)
 *   - final:   avalanche finalized it ('tx final').
 * The next round spends the last one's output once it is final.
 *
 * Usage: node scripts/avalanche-roundtrip.js --key=key.json
 *        [--network=main] [--rounds=10] [--fee=500]
 *        [--api=https://ecash.badger.cash] [--utxo=txid:index:value]
 *        [--seed-hosts=hosts.json]
 *
 * key.json holds {wif, address}. The coin to spend is the address's
 * largest, from a bcash node's HTTP index (--api), or --utxo.
 */

const fs = require('fs');
const https = require('https');
const Chain = require('../lib/blockchain/chain');
const Pool = require('../lib/net/pool');
const Network = require('../lib/protocol/network');
const NetAddress = require('../lib/net/netaddress');
const common = require('../lib/net/common');
const KeyRing = require('../lib/primitives/keyring');
const MTX = require('../lib/primitives/mtx');
const Coin = require('../lib/primitives/coin');
const Script = require('../lib/script/script');
const TX = require('../lib/primitives/tx');
const util = require('../lib/utils/util');

const args = {};
for (const arg of process.argv.slice(2)) {
  const [name, value] = arg.replace(/^--/, '').split('=');
  args[name] = value;
}

const networkName = args.network || 'main';
const network = Network.get(networkName);
const rounds = Number(args.rounds || 10);
const fee = Number(args.fee || 500);
const api = args.api || 'https://ecash.badger.cash';

const start = Date.now();
const log = (event, fields = {}) => console.log(JSON.stringify({
  t: ((Date.now() - start) / 1000).toFixed(1), event, ...fields
}));

function get(path) {
  return new Promise((resolve, reject) => {
    https.get(api + path, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`${path}: ${data.slice(0, 200)}`));
        }
      });
    }).on('error', reject);
  });
}

const wait = ms => new Promise(r => setTimeout(r, ms));

async function until(fn, timeout, what) {
  const end = Date.now() + timeout;
  while (!await fn()) {
    if (Date.now() > end)
      throw new Error(`Timed out waiting for ${what}.`);
    await wait(250);
  }
}

// The coin to spend first: --utxo, or the address's largest.
async function firstCoin(address) {
  const script = Script.fromAddress(address);

  if (args.utxo) {
    const [txid, index, value] = args.utxo.split(':');
    return Coin.fromOptions({
      hash: Buffer.from(txid, 'hex').reverse(),
      index: Number(index),
      value: Number(value),
      script,
      height: -1
    });
  }

  const coins = await get(`/coin/address/${address.toString(network)}`);
  if (coins.length === 0)
    throw new Error(`No coins for ${address.toString(network)}.`);

  coins.sort((a, b) => b.value - a.value);
  const c = coins[0];

  return Coin.fromOptions({
    hash: Buffer.from(c.hash, 'hex').reverse(),
    index: c.index,
    value: c.value,
    script,
    height: c.height
  });
}

function spend(ring, coin) {
  const mtx = new MTX();
  mtx.addCoin(coin);
  mtx.addOutput(ring.getAddress(), coin.value - fee);
  mtx.sign(ring);
  return mtx.toTX();
}

const percentile = (values, p) => {
  const sorted = values.filter(v => v != null).sort((a, b) => a - b);
  if (sorted.length === 0)
    return null;
  return sorted[Math.min(sorted.length - 1,
    Math.floor(p / 100 * sorted.length))];
};

(async () => {
  const key = JSON.parse(fs.readFileSync(args.key, 'utf8'));
  const ring = KeyRing.fromSecret(key.wif, network);
  const address = ring.getAddress();

  let coin = await firstCoin(address);
  log('coin', {txid: util.revHex(coin.hash), index: coin.index,
    value: coin.value, height: coin.height});

  // An anchored SPV chain, from a few blocks back.
  const info = await get('/');
  const height = info.chain.height - 2;
  const block = await get(`/block/${height}`);
  const chain = new Chain({network, spv: true, memory: true,
    anchor: {height, hash: block.hash}, avalanche: true});
  const pool = new Pool({network, chain, spv: true, memory: true,
    listen: false, avalanche: true, avalanchePreConsensus: true});

  await chain.open();
  await pool.open();

  // A saved address book, as a client that has run before keeps one.
  if (args['seed-hosts']) {
    for (const host of JSON.parse(fs.readFileSync(args['seed-hosts']))) {
      const addr = NetAddress.fromHostname(host, network);
      addr.services = common.services.NETWORK | common.services.AVALANCHE;
      addr.time = network.now();
      pool.hosts.add(addr);
    }
  }

  // The listener: a plain SPV pool, filtering for our address, so its
  // peers announce our transactions once they reach them.
  const listenChain = new Chain({network, spv: true, memory: true,
    anchor: {height, hash: block.hash}});
  const listener = new Pool({network, chain: listenChain, spv: true,
    memory: true, listen: false});

  await listenChain.open();
  await listener.open();
  listener.watchAddress(address);

  await pool.connect();
  pool.startSync();
  await listener.connect();
  listener.startSync();

  const ava = pool.avalanche;

  // When peers first asked for each transaction, and announced it to the
  // listener.
  const seen = new Map();
  const note = (field, cmd) => (packet, peer) => {
    if (packet.cmd !== cmd)
      return;
    for (const item of packet.items) {
      const timing = seen.get(item.hash.toString('hex'));
      if (timing && timing[field] == null) {
        timing[field] = Date.now() - timing.sent;
        timing[field + 'Peer'] = peer.hostname();
      }
    }
  };
  pool.on('packet', note('request', 'getdata'));
  listener.on('packet', note('back', 'inv'));

  const verdicts = new Map();
  for (const [event, verdict] of [['tx final', 'final'],
    ['tx rejected', 'rejected'], ['tx invalid', 'invalid']]) {
    pool.on(event, tx => verdicts.set(tx.txid(), {verdict, at: Date.now()}));
  }

  log('waiting', {for: 'pre-consensus'});
  await until(() => ava.isPreconsensusActivated(), 30 * 60000,
    'pre-consensus');
  log('ready', {proofs: ava.peerManager.peers.size,
    listening: listener.peers.size()});

  // The coin's own transaction final first, so rounds time only theirs.
  if (coin.height === -1) {
    const funding = await get(`/tx/${util.revHex(coin.hash)}`);
    const tx = TX.fromRaw(Buffer.from(funding.hex, 'hex'));
    await ava.watchTransaction(tx);
    await until(() => ava.getTransactionStatus(tx.hash()) === 'final',
      5 * 60000, 'the funding transaction to be final');
    log('funding final', {txid: tx.txid()});
  }

  const results = [];

  for (let i = 0; i < rounds; i++) {
    const tx = spend(ring, coin);
    const timing = {sent: Date.now()};
    seen.set(tx.hash().toString('hex'), timing);

    await ava.watchTransaction(tx);
    pool.broadcast(tx).catch(() => {});

    await until(() => verdicts.has(tx.txid()), 120000,
      `a verdict on ${tx.txid()}`);

    const {verdict, at} = verdicts.get(tx.txid());
    const result = {
      round: i + 1,
      txid: tx.txid(),
      verdict,
      request: timing.request,
      back: timing.back,
      final: at - timing.sent,
      requestPeer: timing.requestPeer,
      backPeer: timing.backPeer
    };
    results.push(result);
    log('round', result);

    if (verdict !== 'final')
      break;

    coin = Coin.fromTX(tx, 0, -1);
  }

  const summary = {};
  for (const field of ['request', 'back', 'final']) {
    const values = results.map(r => r[field]);
    summary[field] = {
      median: percentile(values, 50),
      p90: percentile(values, 90),
      max: percentile(values, 100),
      missing: values.filter(v => v == null).length
    };
  }

  log('summary', {rounds: results.length, ms: summary});

  await listener.close();
  await pool.close();
  process.exit(0);
})().catch((err) => {
  console.error(err.stack);
  process.exit(1);
});
