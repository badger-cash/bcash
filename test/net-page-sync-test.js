/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * A page keeps its newest blocks whole, and serves them to its page peers:
 * a page that loses every full node stays synced through another page,
 * and sees its payments. A page keeps its window across a restart.
 * WebRTC is an in-memory stand-in; the node and pages speak WebTransport,
 * which needs the optional @fails-components/webtransport.
 */

const assert = require('bsert');
const crypto = require('crypto');
const {BlockWindow} = require('../lib/net/blockwindow');
const KeyRing = require('../lib/primitives/keyring');
const FakeRTCPeerConnection = require('./util/fake-webrtc');
const common = require('./util/common');

describe('Page sync', function() {
  describe('window', function() {
    const hash = n => Buffer.alloc(32, n);

    it('should keep the newest, by count', () => {
      const win = new BlockWindow({blocks: 3, bytes: 1000});
      for (let h = 1; h <= 5; h++)
        win.add(h, hash(h), Buffer.alloc(10));
      assert.strictEqual(win.size, 3);
      assert.strictEqual(win.low(), 3);
      assert.strictEqual(win.high(), 5);
      assert(!win.has(hash(2)));
      assert.strictEqual(win.bytes, 30);
    });

    it('should keep the newest, by bytes', () => {
      const win = new BlockWindow({blocks: 100, bytes: 100});
      for (let h = 1; h <= 5; h++)
        win.add(h, hash(h), Buffer.alloc(40));
      assert.strictEqual(win.size, 2);
      assert.strictEqual(win.low(), 4);
      assert(win.bytes <= 100);
    });

    it('should not take an older block when full', () => {
      const win = new BlockWindow({blocks: 2, bytes: 1000});
      win.add(5, hash(5), Buffer.alloc(1));
      win.add(6, hash(6), Buffer.alloc(1));
      assert(win.isFullBelow(4));
      assert(!win.add(4, hash(4), Buffer.alloc(1)));
      assert.strictEqual(win.low(), 5);
    });

    it('should not take a block past its bytes', () => {
      const win = new BlockWindow({blocks: 10, bytes: 50});
      assert(!win.add(1, hash(1), Buffer.alloc(60)));
      assert.strictEqual(win.size, 0);
    });

    it('should replace a block at the same height', () => {
      const win = new BlockWindow({blocks: 10, bytes: 1000});
      win.add(7, hash(7), Buffer.alloc(5));
      win.add(7, hash(8), Buffer.alloc(6));
      assert(!win.has(hash(7)));
      assert(win.has(hash(8)));
      assert.strictEqual(win.bytes, 6);
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

    it('should stay synced through a page, with no node', async () => {
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

      const pages = [];
      const address = KeyRing.generate().getAddress();

      try {
        await node.open();
        await node.connect();
        await rpc('generatetoaddress', 20,
          KeyRing.generate().getAddress().toString('regtest'));

        const [current, next] = node.pool.wt.getHashes();

        for (let i = 0; i < 2; i++) {
          const page = new SPVNode({
            network: 'regtest',
            memory: true,
            workers: false,
            httpPort: base + 3 + i,
            maxOutbound: 1,
            webTransport: addon.WebTransport,
            webRTC: FakeRTCPeerConnection,
            wtSeeds: [{host: '127.0.0.1', port: base + 2,
              hashes: [current.hash, next.hash]}]
          });
          pages.push(page);
        }

        const [a, b] = pages;

        // Page A's payments, as its wallet watches for them.
        a.pool.watchAddress(address);
        const paid = new Set();
        a.on('block', (block) => {
          for (const tx of block.txs) {
            if (tx.outputs.some(o => o.getAddress()
              && o.getAddress().equals(address))) {
              paid.add(tx.txid());
            }
          }
        });

        for (const page of pages) {
          await page.open();
          await page.connect();
          page.startSync();
        }

        await until(() => a.chain.height === 20 && b.chain.height === 20,
          'pages synced');

        // Each holds the node's blocks whole.
        await until(() => b.pool.window.size === 20, 'window filled');
        assert.strictEqual(b.pool.window.low(), 1);
        assert.strictEqual(b.pool.window.high(), 20);

        await until(() => rtcPeer(a) && rtcPeer(b), 'pages connected');
        await until(() => rtcPeer(a).blockRange
          && rtcPeer(a).blockRange.high === 20, 'range told');

        // Page A loses its node, and cannot find another.
        a.pool.getHost = () => null;
        for (let p = a.pool.peers.head(); p; p = p.next) {
          if (!p.rtc)
            p.destroy();
        }
        await until(() => nodePeers(a) === 0, 'node gone');

        // It syncs from page B now.
        await until(() => a.pool.peers.load === rtcPeer(a), 'page loader');

        // The node mines three blocks, paying page A.
        await rpc('generatetoaddress', 3, address.toString('regtest'));

        await until(() => a.chain.height === 23, 'page A at the tip');
        assert.strictEqual(nodePeers(a), 0, 'page A has no node');
        assert.bufferEqual(a.chain.tip.hash, node.chain.tip.hash);
        await until(() => paid.size === 3, 'page A saw its payments');

        // And keeps them whole in turn, for its own page peers.
        await until(() => a.pool.window.high() === 23, 'page A window');

        // Page A misses five blocks, then catches up from page B: asking
        // what follows its tip (getblocks), the older three filtered for
        // it (its window here: the newest two) and the newest two whole.
        const handleBlockInv = a.pool.handleBlockInv.bind(a.pool);
        a.pool.handleBlockInv = async () => {};
        await rpc('generatetoaddress', 5, address.toString('regtest'));
        await until(() => rtcPeer(a).blockRange.high === 28, 'page B at 28');
        assert.strictEqual(a.chain.height, 23);

        a.pool.handleBlockInv = handleBlockInv;
        a.pool.window.maxBlocks = 2;
        const asked = {filtered: 0, whole: 0};
        const peerA = rtcPeer(a);
        const getItems = peerA.getItems.bind(peerA);
        peerA.getItems = (type, hashes) => {
          if (type === 3)
            asked.filtered += hashes.length;
          else if (type === 2)
            asked.whole += hashes.length;
          return getItems(type, hashes);
        };
        peerA.syncing = false;
        await a.pool.sendSync(peerA);

        await until(() => a.chain.height === 28, 'page A caught up');
        assert.bufferEqual(a.chain.tip.hash, node.chain.tip.hash);
        assert.deepStrictEqual(asked, {filtered: 3, whole: 2});
        await until(() => paid.size === 8, 'page A saw all its payments');
      } finally {
        for (const page of pages)
          await page.close();
        await node.close();
      }
    });

    it('should keep its window across a restart', async () => {
      const FullNode = require('../lib/node/fullnode');
      const SPVNode = require('../lib/node/spvnode');

      const base = 20000 + crypto.randomInt(0, 5000) * 2;
      const dir = common.testdir('window');

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

      const until = async (check, what, ms = 60000) => {
        const end = Date.now() + ms;
        while (!(await check()) && Date.now() < end)
          await new Promise(r => setTimeout(r, 100));
        assert(await check(), `Timed out: ${what}`);
      };

      const page = () => {
        const [current, next] = node.pool.wt.getHashes();
        return new SPVNode({
          network: 'regtest',
          prefix: dir,
          memory: false,
          workers: false,
          httpPort: base + 3,
          maxOutbound: 1,
          webTransport: addon.WebTransport,
          webRTC: FakeRTCPeerConnection,
          wtSeeds: [{host: '127.0.0.1', port: base + 2,
            hashes: [current.hash, next.hash]}]
        });
      };

      let p = null;

      try {
        await node.open();
        await node.connect();
        await node.rpc.call({method: 'generatetoaddress', params: [12,
          KeyRing.generate().getAddress().toString('regtest')]}, {});

        p = page();
        await p.ensure();
        await p.open();
        await p.connect();
        p.startSync();
        await until(() => p.chain.height === 12
          && p.pool.window.size === 12, 'window filled');
        const held = [...p.pool.window.blocks.keys()].sort();
        await p.close();

        // Opened again: the same blocks, before any peer is reached.
        p = page();
        await p.open();
        assert.strictEqual(p.pool.window.size, 12);
        assert.deepStrictEqual([...p.pool.window.blocks.keys()].sort(), held);
        assert.strictEqual(p.pool.window.low(), 1);
        assert.strictEqual(p.pool.window.high(), 12);

        // A block it drops goes from its database too.
        p.pool.window.remove(Buffer.from(held[0], 'hex'));
        await new Promise(r => setTimeout(r, 100));
        await p.close();

        p = page();
        await p.open();
        assert.strictEqual(p.pool.window.size, 11);
        assert(!p.pool.window.blocks.has(held[0]));
      } finally {
        if (p && p.opened)
          await p.close();
        await node.close();
        await common.rimraf(dir);
      }
    });
  });
});
