/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * P2P over WebTransport, for browsers. A node makes its own certificate,
 * one a page can pin by hash: ECDSA P-256, valid under 2 weeks; swaps to
 * the next before it ends; and takes each session as an inbound peer. An
 * SPV client dialing it over WebTransport alone syncs and finds its coins.
 * The last part needs the optional @fails-components/webtransport.
 */

const assert = require('bsert');
const crypto = require('crypto');
const EventEmitter = require('events');
const {
  makeCertificate,
  WebTransportServer,
  CERT_LIFETIME,
  CERT_RENEW
} = require('../lib/net/webtransport');

const DAY = 24 * 60 * 60 * 1000;

describe('WebTransport', function() {
  describe('certificate', function() {
    it('should be one a browser pins by hash', () => {
      const c = makeCertificate({host: '203.0.113.7'});
      const x = new crypto.X509Certificate(c.cert);

      // ECDSA P-256, as browsers require, self-signed.
      assert.strictEqual(x.publicKey.asymmetricKeyType, 'ec');
      assert.strictEqual(x.publicKey.asymmetricKeyDetails.namedCurve,
        'prime256v1');
      assert(x.verify(x.publicKey));

      // Valid under 14 days.
      const days = (Date.parse(x.validTo) - Date.parse(x.validFrom)) / DAY;
      assert(days < 14 && days >= 12.9);

      // The hash a page pins: SHA-256 of the certificate's DER.
      assert.strictEqual(c.hash,
        crypto.createHash('sha256').update(x.raw).digest('hex'));

      // Its IP address too.
      assert.strictEqual(x.subjectAltName, 'IP Address:203.0.113.7');

      // Its key matches.
      const key = crypto.createPrivateKey(c.privKey);
      const sig = crypto.sign('sha256', Buffer.from('x'), key);
      assert(crypto.verify('sha256', Buffer.from('x'), x.publicKey, sig));
    });

    it('should be a new key each time', () => {
      const a = makeCertificate();
      const b = makeCertificate();
      assert.notStrictEqual(a.hash, b.hash);
    });
  });

  describe('server', function() {
    // A stand-in for the addon's Http3Server.
    function fakeModule() {
      const servers = [];
      class Http3Server {
        constructor(options) {
          this.options = options;
          this.ready = Promise.resolve();
          this.stopped = false;
          servers.push(this);
        }

        startServer() {}

        stopServer() {
          this.stopped = true;
        }

        sessionStream() {
          return {getReader: () => ({read: () => new Promise(() => {})})};
        }
      }
      return {servers, module: {Http3Server}};
    }

    it('should listen on its own certificate, the next one ready', async () => {
      const {servers, module} = fakeModule();
      const wt = new WebTransportServer({load: async () => module});

      await wt.listen(4433, '127.0.0.1');
      try {
        assert.strictEqual(servers.length, 1);
        assert.strictEqual(servers[0].options.port, 4433);
        assert.strictEqual(servers[0].options.cert, wt.current.cert);

        // Current, then next: the next valid before the current ends.
        const [current, next] = wt.getHashes();
        assert.strictEqual(current.hash, wt.current.hash);
        assert.strictEqual(next.hash, wt.next.hash);
        assert(wt.next.notBefore < wt.current.notAfter - CERT_RENEW);
        assert(next.notAfter > current.notAfter);
      } finally {
        await wt.close();
      }
    });

    it('should swap to the next certificate before the current ends',
      async () => {
        const {servers, module} = fakeModule();
        const wt = new WebTransportServer({load: async () => module});
        await wt.listen(4433, '127.0.0.1');

        try {
          const {current, next} = wt;

          // Days left: no swap.
          assert.strictEqual(await wt.maybeRotate(), false);

          // Under two days left: the next is current, a new next, and the
          // listener on the new certificate.
          const rotated = [];
          wt.on('rotate', hashes => rotated.push(hashes));
          const late = current.notAfter - CERT_RENEW + 1000;
          assert.strictEqual(await wt.maybeRotate(late), true);

          assert.strictEqual(wt.current, next);
          assert.notStrictEqual(wt.next.hash, next.hash);
          assert.strictEqual(servers.length, 2);
          assert(servers[0].stopped);
          assert.strictEqual(servers[1].options.cert, next.cert);
          assert.strictEqual(rotated.length, 1);
          assert(wt.next.notAfter - late > CERT_LIFETIME - CERT_RENEW - DAY);
        } finally {
          await wt.close();
        }
      });

    it('should say what is missing without the optional module',
      async () => {
        const wt = new WebTransportServer({
          load: async () => {
            throw new Error('Cannot find package');
          }
        });
        await assert.rejects(wt.listen(4433),
          /optional dependency @fails-components\/webtransport/);
      });
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

    it('should sync an SPV client over WebTransport alone', async () => {
      const FullNode = require('../lib/node/fullnode');
      const SPVNode = require('../lib/node/spvnode');
      const KeyRing = require('../lib/primitives/keyring');
      const {connect} = require('../lib/net/webtransport');

      const wtPort = 20000 + (crypto.randomInt(0, 10000));

      const full = new FullNode({
        network: 'regtest',
        memory: true,
        workers: false,
        listen: false,
        bip37: true,
        host: '127.0.0.1',
        httpPort: wtPort + 1,
        wtPort,
        wtHost: '127.0.0.1'
      });

      await full.open();
      await full.connect();

      const address = KeyRing.generate().getAddress().toString('regtest');
      const rpc = async (method, ...params) => {
        const json = await full.rpc.call({method, params}, {});
        if (json.error)
          throw new Error(json.error.message);
        return json.result;
      };
      await rpc('generatetoaddress', 20, address);

      const [{hash}] = full.pool.wt.getHashes();
      const dialed = [];
      const spv = new SPVNode({
        network: 'regtest',
        memory: true,
        workers: false,
        httpPort: wtPort + 2,
        only: [`127.0.0.1:${wtPort}`],
        createSocket: (port, host) => {
          dialed.push(`${host}:${port}`);
          return connect(addon.WebTransport, host, port, hash);
        }
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

      try {
        const until = async (check) => {
          for (let i = 0; i < 400 && !check(); i++)
            await new Promise(r => setTimeout(r, 100));
          return check();
        };

        assert(await until(() => spv.chain.height === 20));
        assert(await until(() => found.size === 20));

        // One peer each way, over WebTransport: the node has no TCP
        // listener at all.
        assert.deepStrictEqual([...new Set(dialed)],
          [`127.0.0.1:${wtPort}`]);
        assert.strictEqual(full.pool.peers.inbound, 1);
        assert(full.pool.peers.head().socket instanceof EventEmitter);
        assert.strictEqual(full.pool.peers.head().socket.constructor.name,
          'WebTransportSocket');

        // A block mined now comes over the same stream.
        await rpc('generatetoaddress', 1, address);
        assert(await until(() => spv.chain.height === 21
          && found.size === 21));
      } finally {
        await spv.close();
        await full.close();
      }
    });
  });
});
