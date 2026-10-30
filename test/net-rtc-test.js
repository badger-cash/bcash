/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * WebRTC between pages: the records a page signs and full nodes pass on,
 * the signals they carry, the data channel as a socket, and two pages on
 * full nodes that are not connected to each other finding each other and
 * becoming peers. WebRTC itself is an in-memory stand-in (the browser
 * does the real one); the nodes and pages speak WebTransport, which needs
 * the optional @fails-components/webtransport.
 */

const assert = require('bsert');
const crypto = require('crypto');
const secp256k1 = require('bcrypto/lib/secp256k1');
const util = require('../lib/utils/util');
const {
  RECORD_LIFETIME,
  MAX_RTCADDR,
  signals,
  keyAddress,
  RTCRecord,
  RTCSignal,
  RTCRecords,
  DataChannelSocket
} = require('../lib/net/rtc');
const FakeRTCPeerConnection = require('./util/fake-webrtc');

function makeRecord(options = {}) {
  const priv = options.priv || secp256k1.privateKeyGenerate();
  const record = new RTCRecord({
    key: secp256k1.publicKeyCreate(priv, true),
    time: options.time != null ? options.time : util.now(),
    host: options.host || '203.0.113.7',
    port: options.port || 18335
  });
  record.sign(priv);
  record.hashes = options.hashes || [{hash: 'ab'.repeat(32), notAfter: 1}];
  return record;
}

describe('WebRTC', function() {
  describe('records', function() {
    it('should be signed by the page', () => {
      const record = makeRecord();
      assert(record.verify());

      const back = RTCRecord.decode(record.encode());
      assert(back.verify());
      assert.bufferEqual(back.key, record.key);
      assert.strictEqual(back.hostname, '203.0.113.7:18335');
      assert.deepStrictEqual(back.hashes, record.hashes);
    });

    it('should not hold with its home or time changed', () => {
      const record = makeRecord();

      const moved = RTCRecord.decode(record.encode());
      moved.host = '198.51.100.1';
      assert(!moved.verify());

      const later = RTCRecord.decode(record.encode());
      later.time += 1;
      assert(!later.verify());

      // The home node's hashes are its own, outside the signature.
      const rehashed = RTCRecord.decode(record.encode());
      rehashed.hashes = [];
      assert(rehashed.verify());
    });

    it('should expire', () => {
      const now = util.now();
      assert(makeRecord({time: now}).isFresh(now));
      assert(!makeRecord({time: now - RECORD_LIFETIME}).isFresh(now));
      assert(!makeRecord({time: now + 3600}).isFresh(now));
    });

    it('should travel in lists of at most 100', () => {
      const list = [makeRecord(), makeRecord()];
      const back = RTCRecord.decodeList(RTCRecord.encodeList(list));
      assert.strictEqual(back.length, 2);
      assert(back.every(r => r.verify()));

      const many = new Array(MAX_RTCADDR + 1).fill(list[0]);
      assert.throws(() => RTCRecord.encodeList(many));
    });

    it('should be kept newest first, one a key', () => {
      const priv = secp256k1.privateKeyGenerate();
      const now = util.now();
      const records = new RTCRecords(2);

      const a = makeRecord({priv, time: now - 10});
      const b = makeRecord({priv, time: now});
      assert(records.add(a));
      assert(records.add(b));
      assert(!records.add(a), 'an older record should not replace');
      assert.strictEqual(records.size, 1);

      // The oldest goes past the limit.
      const c = makeRecord();
      const d = makeRecord();
      records.add(c);
      records.add(d);
      assert.strictEqual(records.size, 2);
      assert.strictEqual(records.get(b.id), null);
      assert.deepStrictEqual(records.toArray().map(r => r.id), [d.id, c.id]);
    });
  });

  describe('signals', function() {
    it('should be signed by their sender', () => {
      const priv = secp256k1.privateKeyGenerate();
      const signal = new RTCSignal({
        to: secp256k1.publicKeyCreate(secp256k1.privateKeyGenerate(), true),
        from: secp256k1.publicKeyCreate(priv, true),
        time: util.now(),
        kind: signals.OFFER,
        data: Buffer.from('{"type":"offer","sdp":"x"}')
      });
      signal.sign(priv);

      const back = RTCSignal.decode(signal.encode());
      assert(back.verify());
      assert(back.isFresh());

      // Another page cannot speak for it.
      back.data = Buffer.from('{"type":"offer","sdp":"y"}');
      assert(!back.verify());
    });

    it('should refuse a large or unknown one', () => {
      const priv = secp256k1.privateKeyGenerate();
      const key = secp256k1.publicKeyCreate(priv, true);
      const big = new RTCSignal({to: key, from: key, time: util.now(),
        kind: signals.OFFER, data: Buffer.alloc(9000)}).sign(priv);
      assert.throws(() => RTCSignal.decode(big.encode()), /too large/);

      const odd = new RTCSignal({to: key, from: key, time: util.now(),
        kind: 9, data: Buffer.alloc(1)}).sign(priv);
      assert.throws(() => RTCSignal.decode(odd.encode()), /kind/);
    });
  });

  describe('data channel socket', function() {
    it('should carry a stream of any size, in order', async () => {
      const a = new FakeRTCPeerConnection();
      const b = new FakeRTCPeerConnection();
      const channel = a.createDataChannel('bcash');
      let theirs = null;
      b.ondatachannel = (event) => {
        theirs = event.channel;
      };

      await a.setLocalDescription(await a.createOffer());
      await b.setRemoteDescription(a.localDescription);
      await b.setLocalDescription(await b.createAnswer());
      await a.setRemoteDescription(b.localDescription);
      await a.addIceCandidate({candidate: 'x'});
      await b.addIceCandidate({candidate: 'x'});

      for (let i = 0; i < 20 && (!theirs || channel.readyState !== 'open'); i++)
        await new Promise(r => setImmediate(r));

      const key = secp256k1.publicKeyCreate(secp256k1.privateKeyGenerate(),
        true);
      const left = new DataChannelSocket(key);
      const right = new DataChannelSocket(key);
      left.attach(a, channel);
      right.attach(b, theirs);

      assert.strictEqual(left.remoteAddress, keyAddress(key));
      assert(left.remoteAddress.startsWith('fd'));

      const got = [];
      right.on('data', data => got.push(data));

      // Past a channel message's size: sent in pieces.
      const data = crypto.randomBytes(100000);
      left.write(data);
      left.write(Buffer.from('end'));

      for (let i = 0; i < 50 && Buffer.concat(got).length < 100003; i++)
        await new Promise(r => setImmediate(r));

      assert.bufferEqual(Buffer.concat(got),
        Buffer.concat([data, Buffer.from('end')]));

      let closed = false;
      right.on('close', () => {
        closed = true;
      });
      left.destroy();
      await new Promise(r => setImmediate(r));
      assert(closed, 'the other side should close');
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

    it('should find and connect pages on nodes apart', async () => {
      const FullNode = require('../lib/node/fullnode');
      const SPVNode = require('../lib/node/spvnode');

      const base = 20000 + crypto.randomInt(0, 9000) * 2;
      const port = i => base + i * 10;

      // N1 - N2 - N3: N1 and N3 know each other only through N2.
      const nodes = [];
      for (let i = 0; i < 3; i++) {
        nodes.push(new FullNode({
          network: 'regtest',
          memory: true,
          workers: false,
          bip37: true,
          listen: true,
          host: '127.0.0.1',
          port: port(i),
          httpPort: port(i) + 1,
          wtPort: port(i) + 2,
          wtHost: '127.0.0.1',
          stunPort: port(i) + 3,
          stunHost: '127.0.0.1',
          only: i === 1 ? [] : [`127.0.0.1:${port(1)}`]
        }));
      }

      const pages = [];
      const until = async (check, what, ms = 60000) => {
        const end = Date.now() + ms;
        while (!check() && Date.now() < end)
          await new Promise(r => setTimeout(r, 100));
        assert(check(), `Timed out: ${what}`);
      };

      const rtcPeer = (page) => {
        for (let p = page.pool.peers.head(); p; p = p.next) {
          if (p.rtc && p.handshake)
            return p;
        }
        return null;
      };

      try {
        for (const node of nodes) {
          await node.open();
          await node.connect();
        }

        await until(() => nodes[1].pool.peers.size() === 2, 'N2 links');

        // A page on N1 and a page on N3, each with one node of its own.
        for (const i of [0, 2]) {
          const [current, next] = nodes[i].pool.wt.getHashes();
          const page = new SPVNode({
            network: 'regtest',
            memory: true,
            workers: false,
            httpPort: port(i) + 5,
            maxOutbound: 1,
            webTransport: addon.WebTransport,
            webRTC: FakeRTCPeerConnection,
            wtSeeds: [{host: '127.0.0.1', port: port(i) + 2,
              hashes: [current.hash, next.hash]}]
          });
          pages.push(page);
          await page.open();
          await page.connect();
        }

        // Each is announced at its own node.
        await until(() => nodes[0].pool.rtcPages.size === 1
          && nodes[2].pool.rtcPages.size === 1, 'announced');

        // Each record crossed N2 to the far node.
        const [a, b] = pages.map(p => p.pool.rtc.id);
        await until(() => nodes[0].pool.rtcRecords.get(b)
          && nodes[2].pool.rtcRecords.get(a), 'records gossiped');

        assert(!nodes[0].pool.peers.has(`127.0.0.1:${port(2)}`),
          'N1 and N3 should not be connected');

        // Peers, over WebRTC.
        await until(() => rtcPeer(pages[0]) && rtcPeer(pages[1]),
          'pages connected', 60000);

        const [peerA, peerB] = pages.map(rtcPeer);
        assert.strictEqual(peerA.rtcKey.toString('hex'), b);
        assert.strictEqual(peerB.rtcKey.toString('hex'), a);
        assert.notStrictEqual(peerA.outbound, peerB.outbound);

        // Not a node to sync from, and no node's slot.
        assert(!peerA.loader && !peerB.loader);
        assert.strictEqual(pages[0].pool.peers.rtc, 1);

        // Each was given its nodes' STUN.
        const urls = FakeRTCPeerConnection.created
          .map(pc => pc.config.iceServers)
          .filter(servers => servers && servers.length > 0)
          .map(servers => servers[0].urls[0]);
        assert(urls.some(url => /^stun:127\.0\.0\.1:\d+$/.test(url)));

        // A message across, and its answer back.
        peerA.sendPing();
        await until(() => peerA.lastPong > 0, 'pong');

        // The dialer reached the other's home node to signal: it is the
        // only node both pages are connected to.
        const dialer = peerA.outbound ? 0 : 1;
        const home = dialer === 0 ? 2 : 0;
        assert(pages[dialer].pool.peers.has(`127.0.0.1:${port(home) + 2}`));
      } finally {
        for (const page of pages)
          await page.close();
        for (const node of nodes)
          await node.close();
      }
    });
  });
});
