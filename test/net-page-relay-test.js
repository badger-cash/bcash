/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * Pages relay unconfirmed transactions: a page with no full node hears
 * of a payment to it, unconfirmed, through another page, and its own
 * payment reaches a full node through that page. WebRTC is an in-memory
 * stand-in; the node and pages speak WebTransport, which needs the
 * optional @fails-components/webtransport.
 */

const assert = require('bsert');
const crypto = require('crypto');
const {TXRelay} = require('../lib/net/txrelay');
const KeyRing = require('../lib/primitives/keyring');
const MTX = require('../lib/primitives/mtx');
const Coin = require('../lib/primitives/coin');
const FakeRTCPeerConnection = require('./util/fake-webrtc');

function fakeTX(size) {
  const mtx = new MTX();
  mtx.addInput({prevout: {hash: crypto.randomBytes(32), index: 0}});
  mtx.addOutput(KeyRing.generate().getAddress(), 1000);
  const tx = mtx.toTX();
  tx.getSize = () => size;
  return tx;
}

describe('Page relay', function() {
  describe('relay pool', function() {
    it('should keep each once, the oldest out past its bytes', () => {
      const relay = new TXRelay({bytes: 250});
      const txs = [fakeTX(100), fakeTX(100), fakeTX(100)];
      assert(relay.add(txs[0], 0));
      assert(!relay.add(txs[0], 0), 'a second time is not new');
      relay.add(txs[1], 0);
      relay.add(txs[2], 0);
      assert.strictEqual(relay.size, 2);
      assert(!relay.has(txs[0].hash()));
      assert(relay.bytes <= 250);
    });

    it('should forget the old, and what a block confirms', () => {
      const relay = new TXRelay({ttl: 1000});
      const [a, b, c] = [fakeTX(10), fakeTX(10), fakeTX(10)];
      relay.add(a, 0);
      relay.add(b, 500);
      relay.add(c, 1200);
      assert(!relay.has(a.hash()), 'an hour old, dropped');
      assert(relay.has(b.hash()));

      relay.removeBlock({txs: [b]});
      assert(!relay.has(b.hash()));
      assert.strictEqual(relay.get(c.hash()), c);
    });
  });

  describe('pages', function() {
    this.timeout(120000);

    let addon = null;
    before(async function() {
      try {
        addon = await import('@fails-components/webtransport');
      } catch (e) {
        this.skip();
      }
    });

    it('should relay payments for a page with no node', async () => {
      const FullNode = require('../lib/node/fullnode');
      const SPVNode = require('../lib/node/spvnode');

      const base = 20000 + crypto.randomInt(0, 5000) * 2;

      const node = new FullNode({
        network: 'regtest',
        memory: true,
        workers: false,
        bip37: true,
        listen: false,
        host: '127.0.0.1',
        httpPort: base + 1,
        wtPort: base + 2,
        wtHost: '127.0.0.1'
      });

      const rpc = async (method, ...params) => {
        const json = await node.rpc.call({method, params}, {});
        if (json.error)
          throw new Error(json.error.message);
        return json.result;
      };

      const until = async (check, what, ms = 60000) => {
        const end = Date.now() + ms;
        while (!(await check()) && Date.now() < end)
          await new Promise(r => setTimeout(r, 100));
        assert(await check(), `Timed out: ${what}`);
      };

      const rtcPeer = (page) => {
        for (let p = page.pool.peers.head(); p; p = p.next) {
          if (p.rtc && p.handshake)
            return p;
        }
        return null;
      };

      const nodePeers = (page) => {
        let n = 0;
        for (let p = page.pool.peers.head(); p; p = p.next) {
          if (!p.rtc)
            n += 1;
        }
        return n;
      };

      const miner = KeyRing.generate();
      const ring = KeyRing.generate();
      const pages = [];

      try {
        await node.open();
        await node.connect();
        await rpc('generatetoaddress', 101,
          miner.getAddress().toString('regtest'));

        const [current, next] = node.pool.wt.getHashes();

        for (let i = 0; i < 2; i++) {
          pages.push(new SPVNode({
            network: 'regtest',
            memory: true,
            workers: false,
            httpPort: base + 3 + i,
            maxOutbound: 1,
            webTransport: addon.WebTransport,
            webRTC: FakeRTCPeerConnection,
            wtSeeds: [{host: '127.0.0.1', port: base + 2,
              hashes: [current.hash, next.hash]}]
          }));
        }

        const [a, b] = pages;

        a.pool.watchAddress(ring.getAddress());
        const heard = new Set();
        a.on('tx', tx => heard.add(tx.txid()));

        for (const page of pages) {
          await page.open();
          await page.connect();
          page.startSync();
        }

        await until(() => a.chain.synced && b.chain.synced
          && a.chain.height === 101 && b.chain.height === 101,
          'pages synced');
        await until(() => rtcPeer(a) && rtcPeer(b), 'pages connected');

        // Page A loses its node, and cannot find another.
        a.pool.getHost = () => null;
        for (let p = a.pool.peers.head(); p; p = p.next) {
          if (!p.rtc)
            p.destroy();
        }
        await until(() => nodePeers(a) === 0, 'node gone');

        // A payment to page A, sent to the node.
        const hash = await node.chain.getHash(1);
        const block = await node.chain.getBlock(hash);
        const coin = Coin.fromTX(block.txs[0], 0, 1);

        const pay = new MTX();
        pay.addCoin(coin);
        pay.addOutput(ring.getAddress(), 1000000);
        pay.addOutput(miner.getAddress(), coin.value - 1000000 - 1000);
        pay.sign(miner);
        const tx1 = pay.toTX();
        await node.mempool.addTX(tx1);

        // Page A hears of it, unconfirmed, through page B.
        await until(() => heard.has(tx1.txid()), 'payment heard');
        assert.strictEqual(nodePeers(a), 0, 'page A has no node');
        assert(b.pool.relay.has(tx1.hash()));

        // Page A pays on from it; the node gets it through page B.
        const spend = new MTX();
        spend.addCoin(Coin.fromTX(tx1, 0, -1));
        spend.addOutput(KeyRing.generate().getAddress(), 1000000 - 1000);
        spend.sign(ring);
        const tx2 = spend.toTX();
        a.pool.broadcast(tx2).catch(() => {});

        await until(() => node.mempool.hasEntry(tx2.hash()), 'spend relayed');
        assert(b.pool.relay.has(tx2.hash()));

        // A block confirms both: the pages forget them.
        await rpc('generatetoaddress', 1,
          miner.getAddress().toString('regtest'));
        await until(() => a.chain.height === 102, 'page A at the tip');
        await until(() => !b.pool.relay.has(tx1.hash())
          && !b.pool.relay.has(tx2.hash()), 'confirmed, forgotten');
      } finally {
        for (const page of pages)
          await page.close();
        await node.close();
      }
    });
  });
});
