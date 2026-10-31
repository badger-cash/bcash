/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * Finding nodes over WebTransport. `addr` carries no certificate hash, so a
 * node announces its WebTransport port and hashes in `wtaddr`, keeps those
 * it hears, and answers `getwtaddr` with them. An SPV client given one seed
 * learns the rest, and dials them over WebTransport alone. The last part
 * needs the optional @fails-components/webtransport.
 */

const assert = require('bsert');
const crypto = require('crypto');
const NetAddress = require('../lib/net/netaddress');
const {
  WTAddr,
  WTHosts,
  MAX_WTADDR
} = require('../lib/net/webtransport');

const now = () => Math.floor(Date.now() / 1000);

function entry(host, port, ...expires) {
  const addr = NetAddress.fromHost(host, port);
  addr.services = 1;
  return new WTAddr(addr, expires.map(notAfter => ({
    hash: crypto.randomBytes(32).toString('hex'),
    notAfter
  })));
}

describe('wtaddr', function() {
  it('should round trip, binary', () => {
    const a = entry('203.0.113.7', 4433, now() + 100, now() + 200);
    const b = entry('2001:db8::1', 443, now() + 300);
    const raw = WTAddr.encode([a, b]);

    // Count, then each: services, IP, port; hashes and expiry.
    assert.strictEqual(raw.length, 1 + (26 + 1 + 2 * 36) + (26 + 1 + 36));

    const [x, y] = WTAddr.decode(raw);
    assert.strictEqual(x.addr.hostname, '203.0.113.7:4433');
    assert.strictEqual(x.addr.services, 1);
    assert.deepStrictEqual(x.hashes, a.hashes);
    assert.strictEqual(y.addr.hostname, '[2001:db8::1]:443');
    assert.deepStrictEqual(y.hashes, b.hashes);
  });

  it('should refuse more than a message may hold', () => {
    const list = [];
    for (let i = 0; i <= MAX_WTADDR; i++)
      list.push(entry('203.0.113.7', 1000 + i, now() + 100));

    assert.throws(() => WTAddr.encode(list));

    // As a peer may send it: the count alone says too many.
    const count = MAX_WTADDR + 1;
    const bad = Buffer.from([0xfd, count & 0xff, count >>> 8]);
    assert.throws(() => WTAddr.decode(bad), /Too many/);
  });

  it('should refuse a truncated message', () => {
    const raw = WTAddr.encode([entry('203.0.113.7', 4433, now() + 100)]);
    assert.throws(() => WTAddr.decode(raw.slice(0, raw.length - 1)));
  });

  it('should keep the newest, and drop the expired', () => {
    const hosts = new WTHosts();

    const old = entry('203.0.113.7', 4433, now() + 100);
    const newer = entry('203.0.113.7', 4433, now() + 100, now() + 200);
    const gone = entry('203.0.113.8', 4433, now() - 1);

    assert.strictEqual(hosts.add(old), true);
    assert.strictEqual(hosts.add(newer), true);
    assert.strictEqual(hosts.add(old), false);
    assert.strictEqual(hosts.add(gone), false);

    assert.strictEqual(hosts.size, 1);
    assert.strictEqual(hosts.get('203.0.113.7:4433'), newer);

    // Its time passes.
    assert.strictEqual(hosts.toArray(now() + 150).length, 1);
    assert.strictEqual(hosts.toArray(now() + 250).length, 0);
  });

  describe('P2P', function() {
    this.timeout(60000);

    let addon = null;
    before(async function() {
      try {
        addon = await import('@fails-components/webtransport');
      } catch (e) {
        this.skip();
      }
    });

    it('should find a second node from one seed', async () => {
      const FullNode = require('../lib/node/fullnode');
      const SPVNode = require('../lib/node/spvnode');
      const KeyRing = require('../lib/primitives/keyring');

      const base = 20000 + crypto.randomInt(0, 10000);

      // A listens on TCP and WebTransport; B dials A over TCP and
      // announces its own WebTransport endpoint to it. A's one TCP slot is
      // B's: pages over WebTransport have slots of their own.
      const a = new FullNode({
        network: 'regtest',
        memory: true,
        workers: false,
        bip37: true,
        listen: true,
        maxInbound: 1,
        host: '127.0.0.1',
        port: base,
        httpPort: base + 1,
        wtPort: base + 2,
        wtHost: '127.0.0.1'
      });

      const b = new FullNode({
        network: 'regtest',
        memory: true,
        workers: false,
        bip37: true,
        listen: false,
        only: [`127.0.0.1:${base}`],
        httpPort: base + 3,
        wtPort: base + 4,
        wtHost: '127.0.0.1'
      });

      const nodes = [a, b];
      let spv = null;

      const until = async (check) => {
        for (let i = 0; i < 400 && !check(); i++)
          await new Promise(r => setTimeout(r, 100));
        return check();
      };

      try {
        for (const node of nodes) {
          await node.open();
          await node.connect();
        }

        b.startSync();

        const address = KeyRing.generate().getAddress().toString('regtest');
        const json = await a.rpc.call({
          method: 'generatetoaddress',
          params: [20, address]
        }, {});
        assert(!json.error);

        assert(await until(() => b.chain.height === 20));

        // A heard B's endpoint.
        const bHost = `127.0.0.1:${base + 4}`;
        assert(await until(() => a.pool.wtHosts.get(bHost) != null));

        // The page's seed: A alone, by address and hashes.
        const [current, next] = a.pool.wt.getHashes();
        const dialed = new Set();

        spv = new SPVNode({
          network: 'regtest',
          memory: true,
          workers: false,
          httpPort: base + 5,
          maxOutbound: 2,
          webTransport: function(url, options) {
            dialed.add(new URL(url).host);
            return new addon.WebTransport(url, options);
          },
          wtSeeds: [{
            host: '127.0.0.1',
            port: base + 2,
            hashes: [current.hash, next.hash]
          }]
        });

        const found = new Set();
        spv.on('block', (block) => {
          for (const tx of block.txs) {
            if (tx.outputs.some(o => o.getAddress()
              && o.getAddress().toString('regtest') === address)) {
              found.add(tx.txid());
            }
          }
        });

        spv.pool.watchAddress(address);
        await spv.open();
        await spv.connect();
        spv.startSync();

        assert(await until(() => spv.chain.height === 20));
        assert(await until(() => found.size === 20));

        // Both, over WebTransport: B from what A told it.
        assert(await until(() => dialed.has(bHost)));
        assert(dialed.has(`127.0.0.1:${base + 2}`));
        assert(await until(() => spv.pool.peers.outbound === 2));
        for (let peer = spv.pool.peers.head(); peer; peer = peer.next)
          assert.strictEqual(peer.socket.constructor.name,
            'WebTransportSocket');
        assert.deepStrictEqual(a.pool.inboundCounts(),
          {tcp: 1, webTransport: 1});
      } finally {
        if (spv)
          await spv.close();
        for (const node of nodes.reverse())
          await node.close();
      }
    });

    it('should start from a seed by name, then from what it kept',
      async () => {
        const fs = require('fs');
        const os = require('os');
        const path = require('path');
        const FullNode = require('../lib/node/fullnode');
        const SPVNode = require('../lib/node/spvnode');
        const KeyRing = require('../lib/primitives/keyring');
        const {makeCertificate} = require('../lib/net/webtransport');

        const base = 20000 + crypto.randomInt(0, 10000);

        // The seed's certificate, for its name, in files: as a domain's
        // from Let's Encrypt.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bcash-wtseed-'));
        const seedCert = makeCertificate({host: 'localhost'});
        fs.writeFileSync(path.join(dir, 'cert.pem'), seedCert.cert);
        fs.writeFileSync(path.join(dir, 'key.pem'), seedCert.privKey);

        const full = new FullNode({
          network: 'regtest',
          memory: true,
          workers: false,
          bip37: true,
          listen: false,
          host: '127.0.0.1',
          httpPort: base + 1,
          wtPort: base + 2,
          wtHost: '127.0.0.1',
          wtSeedPort: base + 3,
          wtSeedCert: path.join(dir, 'cert.pem'),
          wtSeedKey: path.join(dir, 'key.pem')
        });

        // A page's WebTransport: the browser checks a seed's certificate
        // as for any site; here, by pinning it, as no CA signed it.
        const dials = [];
        function webTransport(url, options) {
          const {host} = new URL(url);
          dials.push([host, Boolean(options.serverCertificateHashes)]);
          if (host === `localhost:${base + 3}`) {
            assert(!options.serverCertificateHashes);
            options = {serverCertificateHashes: [{
              algorithm: 'sha-256',
              value: Buffer.from(seedCert.hash, 'hex')
            }]};
          }
          return new addon.WebTransport(url, options);
        }

        // A page's localStorage.
        const kept = {data: null};
        const wtStore = {
          load: async () => kept.data,
          save: async (data) => {
            kept.data = data;
          }
        };

        const until = async (check) => {
          for (let i = 0; i < 400 && !check(); i++)
            await new Promise(r => setTimeout(r, 100));
          return check();
        };

        const page = port => new SPVNode({
          network: 'regtest',
          memory: true,
          workers: false,
          httpPort: port,
          webTransport,
          wtStore,
          wtSeeds: [`localhost:${base + 3}`]
        });

        const self = `127.0.0.1:${base + 2}`;
        const peerHosts = (node) => {
          const hosts = [];
          for (let peer = node.pool.peers.head(); peer; peer = peer.next)
            hosts.push(peer.hostname());
          return hosts;
        };

        let spv = null;
        try {
          await full.open();
          await full.connect();

          const address = KeyRing.generate().getAddress()
            .toString('regtest');
          const json = await full.rpc.call({
            method: 'generatetoaddress',
            params: [20, address]
          }, {});
          assert(!json.error);

          // First visit: the seed, by name; it names the node's own
          // endpoint, and the page leaves it for that.
          spv = page(base + 4);
          await spv.open();
          await spv.connect();
          spv.startSync();

          assert(await until(() => spv.chain.height === 20));
          assert.deepStrictEqual(dials[0], [`localhost:${base + 3}`, false]);
          assert(dials.some(([host, pinned]) => host === self && pinned));
          assert(await until(() => {
            const hosts = peerHosts(spv);
            return hosts.length === 1 && hosts[0] === self;
          }));
          assert(kept.data);

          await spv.close();
          spv = null;

          // Back again: straight to the node it kept, no seed.
          dials.length = 0;
          spv = page(base + 5);
          await spv.open();
          await spv.connect();
          spv.startSync();

          assert(await until(() => spv.chain.height === 20));
          assert.deepStrictEqual(dials, [[self, true]]);

          await spv.close();
          spv = null;

          // Anchored, as a page at a checkpoint: a first visit fetches the
          // anchor's headers through the seed, before the pool opens, and
          // nothing below it.
          const more = await full.rpc.call({
            method: 'generatetoaddress',
            params: [20, address]
          }, {});
          assert(!more.error);

          kept.data = null;
          dials.length = 0;
          const hash = await full.chain.getHash(30);
          spv = new SPVNode({
            network: 'regtest',
            memory: true,
            workers: false,
            httpPort: base + 6,
            webTransport,
            wtStore,
            wtSeeds: [`localhost:${base + 3}`],
            anchor: {height: 30, hash: Buffer.from(hash).reverse()
              .toString('hex')}
          });
          await spv.open();
          assert.strictEqual(spv.chain.height, 30);
          assert.deepStrictEqual(dials[0], [`localhost:${base + 3}`, false]);

          await spv.connect();
          spv.startSync();

          assert(await until(() => spv.chain.height === 40));
          assert.strictEqual(await spv.chain.getEntry(10), null);
        } finally {
          if (spv)
            await spv.close();
          await full.close();
          fs.rmSync(dir, {recursive: true, force: true});
        }
      });
  });
});
