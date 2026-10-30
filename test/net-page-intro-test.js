/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * Pages introduce pages: two pages with no full node, each connected only
 * to a third page, find each other through it and connect. WebRTC is an
 * in-memory stand-in; the node and pages speak WebTransport, which needs
 * the optional @fails-components/webtransport.
 */

const assert = require('bsert');
const crypto = require('crypto');
const {RTCSignal} = require('../lib/net/rtc');
const FakeRTCPeerConnection = require('./util/fake-webrtc');

describe('Page introductions', function() {
  this.timeout(180000);

  let addon = null;
  before(async function() {
    try {
      addon = await import('@fails-components/webtransport');
    } catch (e) {
      this.skip();
    }
  });

  it('should connect pages with no node, through a page', async () => {
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
      wtHost: '127.0.0.1',
      stunPort: base + 9,
      stunHost: '127.0.0.1'
    });

    const until = async (check, what, ms = 90000) => {
      const end = Date.now() + ms;
      while (!(await check()) && Date.now() < end)
        await new Promise(r => setTimeout(r, 100));
      assert(await check(), `Timed out: ${what}`);
    };

    // The keys of a page's WebRTC peers, and how many nodes it has.
    const rtcKeys = (page) => {
      const keys = new Set();
      for (let p = page.pool.peers.head(); p; p = p.next) {
        if (p.rtc && p.handshake)
          keys.add(p.rtcKey.toString('hex'));
      }
      return keys;
    };

    const nodePeers = (page) => {
      let n = 0;
      for (let p = page.pool.peers.head(); p; p = p.next) {
        if (!p.rtc)
          n += 1;
      }
      return n;
    };

    const leaveNode = async (page) => {
      page.pool.getHost = () => null;
      for (let p = page.pool.peers.head(); p; p = p.next) {
        if (!p.rtc)
          p.destroy();
      }
      await until(() => nodePeers(page) === 0, 'node gone');
    };

    const pages = [];

    const start = async (i) => {
      const [current, next] = node.pool.wt.getHashes();
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
      await page.open();
      await page.connect();
      page.startSync();
      return page;
    };

    try {
      await node.open();
      await node.connect();

      // Page B stays on the node.
      const b = await start(0);
      const idB = b.pool.rtc.id;
      let idA = null;
      let idC = null;

      // Page A meets B through the node, then leaves the node.
      const a = await start(1);
      idA = a.pool.rtc.id;
      await until(() => rtcKeys(a).has(idB), 'A meets B');
      await leaveNode(a);

      // The node no longer offers A: it can't reach it.
      await until(() => !node.pool.rtcRecords.get(idA), 'A forgotten');

      // Page C meets B through the node. The node can't introduce it to
      // A, which has left it: B does, as C asks B whom it knows.
      // The signals between A and C that B carries, and from whom.
      const carried = [];
      const handleRTCSignal = b.pool.handleRTCSignal.bind(b.pool);
      b.pool.handleRTCSignal = (peer, data) => {
        const signal = RTCSignal.decode(data);
        const ends = [signal.from, signal.to].map(k => k.toString('hex'));
        if (ends.includes(idA) && ends.includes(idC))
          carried.push(Boolean(peer.rtc));
        return handleRTCSignal(peer, data);
      };

      const c = await start(2);
      idC = c.pool.rtc.id;
      await until(() => rtcKeys(a).has(idC) && rtcKeys(c).has(idA),
        'A and C connected through B');
      assert(rtcKeys(c).has(idB));
      assert(carried.length > 0 && carried.every(Boolean),
        'the signals between A and C crossed B, from its page peers');

      // C leaves the node too: A and C keep their own link.
      await leaveNode(c);

      assert.strictEqual(nodePeers(a), 0);
      assert.strictEqual(nodePeers(c), 0);

      // With no node, a page still has the STUN server its node named.
      assert.deepStrictEqual(a.pool.rtc.iceServers(),
        [{urls: [`stun:127.0.0.1:${base + 9}`]}]);
      assert(rtcKeys(a).has(idB) && rtcKeys(c).has(idB));

      // A message across their own link.
      let peer = null;
      for (let p = a.pool.peers.head(); p; p = p.next) {
        if (p.rtc && p.rtcKey.toString('hex') === idC)
          peer = p;
      }
      peer.sendPing();
      await until(() => peer.lastPong > 0, 'pong');
    } finally {
      for (const page of pages)
        await page.close();
      await node.close();
    }
  });
});
