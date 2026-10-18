/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * An SPV chain started from an anchor header instead of the genesis block.
 * Everything above the anchor is validated as usual: linkage, ASERT
 * difficulty, proof of work. Nothing below it is known.
 */

const assert = require('bsert');
const {randomBytes} = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Chain = require('../lib/blockchain/chain');
const Pool = require('../lib/net/pool');
const Peer = require('../lib/net/peer');
const Block = require('../lib/primitives/block');
const Network = require('../lib/protocol/network');
const consensus = require('../lib/protocol/consensus');
const common = require('../lib/blockchain/common');
const hash256 = require('bcrypto/lib/hash256');

const network = Network.get('main');

// Five consecutive eCash mainnet headers, 971519 to 971523.
const MAINNET = [
  { height: 971519, hash: '0000000000000000b0e2883a2f9b67ee69fabede4bc9ee025b6af49bff5e5d0a',
    header: '00802f28ef1bdb388f1c1051f8996fb5b8316ac441d42918b800f06500000000000000000b9cd8d341dfea6171fc15279b474d6876061e51b7f324ab1cebcc40d3c27a116335d46a52c2001912931d85' },
  { height: 971520, hash: '00000000000000002057dab2069b426562205b974723218b741a4ee28827fc54',
    header: '0000f8310a5d5eff9bf46a5b02eec94bdebefa69ee679b2f3a88e2b0000000000000000043a8af6f56cdc1850dfb6a072ec9daf7ef5c52f87d466defcfa88b4665d760bcb237d46aedc2001929e8e23c' },
  { height: 971521, hash: '000000000000000081f58601f03132902c488ae440bfd032f85215936b852be2',
    header: '00402c2754fc2788e24e1a748b212347975b206265429b06b2da57200000000000000000a9c96f439b3a6a8d1f7bbcdb33b14781e68559534006c8a0689938f4551af5c69c39d46aecc200191782f70f' },
  { height: 971522, hash: '000000000000000035265eb26ea436af88b59b40183141a73caf41a795a0f57d',
    header: '00800236e22b856b931552f832d0bf40e48a482c903231f00186f5810000000000000000f39b52e4338a42060fcad58024d99a0477c5c0d75589d8d19ede7a6e798f5a61623dd46ad6c200193e8f85a4' },
  { height: 971523, hash: '0000000000000000ac805f618b511645b8be7c0338c73d454e6bc1bd3265480e',
    header: '00e012207df5a095a741af3ca7413118409bb588af36a46eb25e26350000000000000000d3d6d2c46dcf8debd00f6466f520afab8ea2fdf3ef1cca0c7f5333a8a5e1d6b0a73dd46a1fc300194845b847' },
];

const raw = (hex) => Buffer.from(hex, 'hex');
const headerBlock = (header) => Block.fromRaw(Buffer.concat([header, Buffer.from([0])]));

describe('Chain anchor', function() {
  this.timeout(20000);

  describe('options', function() {
    it('requires SPV mode', () => {
      assert.throws(() => new Chain({
        network, memory: true, spv: false, blocks: {},
        anchor: {height: 1, headers: [Buffer.alloc(80)]}
      }), /Anchors require SPV mode/);
    });

    it('requires 80 byte headers and a uint32 height', () => {
      assert.throws(() => new Chain({
        network, memory: true, spv: true,
        anchor: {height: 1, headers: [Buffer.alloc(79)]}
      }), /80 byte/);
      assert.throws(() => new Chain({
        network, memory: true, spv: true,
        anchor: {height: -1, headers: [Buffer.alloc(80)]}
      }), /uint32/);
      assert.throws(() => new Chain({
        network, memory: true, spv: true,
        anchor: {height: 1, headers: []}
      }), /at least one header/);
    });
  });

  describe('real mainnet headers', function() {
    const headers = MAINNET.map(h => raw(h.header));
    let chain;

    before(async () => {
      chain = new Chain({
        network, memory: true, spv: true,
        anchor: {height: MAINNET[0].height, headers: headers.slice(0, 2)}
      });
      await chain.open();
    });

    after(async () => {
      await chain.close();
    });

    it('opens at the anchor with the given heights', async () => {
      assert.strictEqual(chain.height, MAINNET[1].height);
      assert.strictEqual(chain.tip.rhash(), MAINNET[1].hash);
      const first = await chain.getEntryByHeight(MAINNET[0].height);
      assert.strictEqual(first.rhash(), MAINNET[0].hash);
      assert.strictEqual(await chain.getEntryByHeight(MAINNET[0].height - 1), null);
    });

    it('refuses headers that do not chain in the anchor itself', async () => {
      const bad = new Chain({
        network, memory: true, spv: true,
        anchor: {height: MAINNET[0].height, headers: [headers[0], headers[2]]}
      });
      await assert.rejects(bad.open(), /do not chain/);
    });

    it('accepts the real continuation, validating ASERT difficulty and work', async () => {
      for (let i = 2; i < MAINNET.length; i++) {
        const block = headerBlock(headers[i]);
        const entry = await chain.add(block, common.flags.VERIFY_POW);
        assert(entry, `header ${MAINNET[i].height} rejected`);
        assert.strictEqual(entry.height, MAINNET[i].height);
        assert.strictEqual(entry.rhash(), MAINNET[i].hash);
      }
      assert.strictEqual(chain.height, MAINNET[MAINNET.length - 1].height);
    });

    it('builds a locator that stops at the anchor', async () => {
      const locator = await chain.getLocator();
      assert(locator.length >= 2);
      assert.bufferEqual(locator[0], chain.tip.hash);
      assert.bufferEqual(locator[locator.length - 1], headerBlock(headers[0]).hash());
    });

    it('does not extend the chain with an altered header', async () => {
      // Real work cannot be re-done here, so the altered header fails on
      // its hash first; either way it must not extend the chain.
      const block = headerBlock(headers[4]);
      block.prevBlock = randomBytes(32);
      block.refresh();
      const height = chain.height;
      await assert.rejects(chain.add(block, common.flags.VERIFY_POW));
      assert.strictEqual(chain.height, height);
    });

    it('detects a database created from a different anchor', async () => {
      const original = chain.db.options.anchor;
      chain.db.options.anchor = {height: MAINNET[0].height, headers: [headers[1], headers[2]]};
      try {
        await assert.rejects(chain.db.verifyAnchor(), /not created from this anchor/);
      } finally {
        chain.db.options.anchor = original;
      }
      await chain.db.verifyAnchor();
    });
  });

  describe('synthetic continuation', function() {
    // Make the proof-of-work limit trivial so headers can be ground here.
    // The anchor time is far enough behind schedule that ASERT clamps to it.
    const EASY_BITS = 0x207fffff;
    const saved = {bits: network.pow.bits, limit: network.pow.limit};
    let chain;

    const mine = (prev, time, bits) => {
      const header = Buffer.alloc(80);
      header.writeUInt32LE(1, 0);
      prev.copy(header, 4);
      randomBytes(32).copy(header, 36);
      header.writeUInt32LE(time, 68);
      header.writeUInt32LE(bits, 72);
      const target = consensus.fromCompact(bits);
      for (let nonce = 0; ; nonce++) {
        header.writeUInt32LE(nonce, 76);
        const block = headerBlock(header);
        if (block.verifyPOW())
          return block;
      }
    };

    before(async () => {
      network.pow.bits = EASY_BITS;
      network.pow.limit = consensus.fromCompact(EASY_BITS);
      // Anchor at a plausible eCash height, 200 days behind the ASERT schedule.
      const height = 971000;
      const time = 1605447844 + 600 * (height - 661647) + 200 * 86400;
      const anchor = mine(randomBytes(32), time, EASY_BITS);
      chain = new Chain({
        network, memory: true, spv: true,
        anchor: {height, headers: [anchor.toHead()]}
      });
      await chain.open();
    });

    after(async () => {
      network.pow.bits = saved.bits;
      network.pow.limit = saved.limit;
      await chain.close();
    });

    it('computes the next target from the anchor alone', async () => {
      const bits = await chain.getTarget(chain.tip.time + 600, chain.tip);
      assert.strictEqual(bits, EASY_BITS);
    });

    it('accepts a run of ground headers', async () => {
      const start = chain.height;
      for (let i = 0; i < 30; i++) {
        const time = chain.tip.time + 600;
        const bits = await chain.getTarget(time, chain.tip);
        const block = mine(chain.tip.hash, time, bits);
        const entry = await chain.add(block, common.flags.VERIFY_POW);
        assert(entry);
        assert.strictEqual(entry.height, start + i + 1);
      }
      assert.strictEqual(chain.height, start + 30);
    });

    it('holds a header with an unknown parent as an orphan', async () => {
      const time = chain.tip.time + 600;
      const block = mine(randomBytes(32), time, EASY_BITS);
      const height = chain.height;
      const entry = await chain.add(block, common.flags.VERIFY_POW);
      assert.strictEqual(entry, null);
      assert(chain.hasOrphan(block.hash()));
      assert.strictEqual(chain.height, height);
    });

    it('rejects a header with the wrong difficulty', async () => {
      const time = chain.tip.time + 600;
      const block = mine(chain.tip.hash, time, 0x207ffffe);
      await assert.rejects(chain.add(block, common.flags.VERIFY_POW), /bad-diffbits/);
    });

    it('rejects a header without enough work', async () => {
      const time = chain.tip.time + 600;
      const bits = await chain.getTarget(time, chain.tip);
      const block = mine(chain.tip.hash, time, bits);
      // Keep the claimed bits, break the hash.
      block.nonce ^= 1;
      block.refresh();
      if (!block.verifyPOW())
        await assert.rejects(chain.add(block, common.flags.VERIFY_POW), /high-hash/);
    });

    it('still knows nothing below the anchor', async () => {
      assert.strictEqual(await chain.getEntryByHeight(970999), null);
      const locator = await chain.getLocator();
      assert.strictEqual(locator[locator.length - 1].equals(
        (await chain.getEntryByHeight(971000)).hash), true);
    });
  });

  describe('given by hash', function() {
    const COUNT = consensus.MEDIAN_TIMESPAN;
    const TRUSTED = 971010;

    // Chained headers; anchor headers are taken on trust, not on work.
    const chainOf = (n) => {
      const headers = [];
      let prev = randomBytes(32);
      for (let i = 0; i < n; i++) {
        const header = Buffer.alloc(80);
        header.writeUInt32LE(1, 0);
        prev.copy(header, 4);
        randomBytes(32).copy(header, 36);
        header.writeUInt32LE(1700000000 + i * 600, 68);
        header.writeUInt32LE(0x1d00ffff, 72);
        headers.push(header);
        prev = headerBlock(header).hash();
      }
      return headers;
    };
    const rhash = header => headerBlock(header).rhash();

    const headers = chainOf(COUNT);
    const trusted = {height: TRUSTED, hash: rhash(headers[COUNT - 1])};
    let prefix;

    const open = async (anchor) => {
      const chain = new Chain({
        network, spv: true, memory: false, prefix, anchor
      });
      await chain.open();
      return chain;
    };

    beforeEach(() => {
      prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'bcash-anchor-'));
    });

    afterEach(() => {
      fs.rmSync(prefix, {recursive: true, force: true});
    });

    it('checks the hash and that the height leaves room for ancestors', () => {
      assert.throws(() => new Chain({
        network, memory: true, spv: true,
        anchor: {height: TRUSTED, hash: 'zz'}
      }), /32 bytes of hex/);
      assert.throws(() => new Chain({
        network, memory: true, spv: true,
        anchor: {height: COUNT - 2, hash: trusted.hash}
      }), /too low/);
    });

    it('fetches the trusted block and its ancestors for a fresh database',
      async () => {
        const asked = [];
        const chain = await open({...trusted, getHeaders: async (t) => {
          asked.push(t);
          return headers;
        }});
        try {
          assert.deepStrictEqual(asked, [{...trusted, count: COUNT}]);
          assert.strictEqual(chain.height, TRUSTED);
          assert.strictEqual(chain.tip.rhash(), trusted.hash);
          const first = await chain.getEntryByHeight(TRUSTED - COUNT + 1);
          assert.strictEqual(first.rhash(), rhash(headers[0]));
          assert.strictEqual(
            await chain.getEntryByHeight(TRUSTED - COUNT), null);
        } finally {
          await chain.close();
        }
      });

    it('reopens from the database without fetching', async () => {
      await (await open({...trusted, getHeaders: async () => headers})).close();

      const chain = await open({...trusted, getHeaders: async () => {
        throw new Error('fetched on reopen');
      }});
      try {
        assert.strictEqual(chain.tip.rhash(), trusted.hash);
      } finally {
        await chain.close();
      }
    });

    it('refuses to reopen a database from another anchor', async () => {
      await (await open({...trusted, getHeaders: async () => headers})).close();

      const other = chainOf(COUNT);
      await assert.rejects(open({
        height: TRUSTED, hash: rhash(other[COUNT - 1]),
        getHeaders: async () => other
      }), /not created from this anchor/);
    });

    it('refuses a database that holds the trusted block but starts lower',
      async () => {
        // One more header below, chained to the same trusted block.
        const below = chainOf(1)[0];
        const longer = [below, ...headers];
        const block = headerBlock(longer[1]);
        block.prevBlock = headerBlock(below).hash();
        longer[1] = block.toHead();
        for (let i = 2; i < longer.length; i++) {
          const b = headerBlock(longer[i]);
          b.prevBlock = headerBlock(longer[i - 1]).hash();
          longer[i] = b.toHead();
        }
        const top = {height: TRUSTED, hash: rhash(longer[longer.length - 1])};

        await (await open({height: TRUSTED - COUNT, headers: longer})).close();
        await assert.rejects(open({...top, getHeaders: async () => {
          throw new Error('fetched on reopen');
        }}), /not created from this anchor/);
      });

    it('refuses headers that are too few, broken or end elsewhere, '
      + 'and writes nothing', async () => {
      const broken = [...headers];
      broken[3] = chainOf(1)[0];
      const cases = [
        [headers.slice(1), /needs 11 headers/],
        [broken, /do not chain/],
        [chainOf(COUNT), /do not end at the trusted block/]
      ];
      for (const [given, error] of cases) {
        await assert.rejects(
          open({...trusted, getHeaders: async () => given}), error);
      }

      // Still fresh: a correct fetch now creates it.
      const chain = await open({...trusted, getHeaders: async () => headers});
      assert.strictEqual(chain.tip.rhash(), trusted.hash);
      await chain.close();
    });

    it('refuses a fresh database with no way to fetch headers', async () => {
      await assert.rejects(open({...trusted}), /no way to fetch headers/);
    });

    it('gets its headers from a pool built on the chain', () => {
      const chain = new Chain({
        network, memory: true, spv: true, anchor: {...trusted}
      });
      const pool = new Pool({network, chain, spv: true, listen: false});
      assert.strictEqual(typeof chain.options.anchor.getHeaders, 'function');
      assert(pool);
    });

    describe('Pool#fetchAnchor', function() {
      const saved = {};
      const byHash = new Map(headers.map(h => [headerBlock(h).hash()
        .toString('hex'), h]));
      let destroyed;

      before(() => {
        for (const name of ['connect', 'open', 'sendFilterLoad', 'destroy'])
          saved[name] = Peer.prototype[name];
        Peer.prototype.connect = function(addr) {
          this.address = addr;
        };
        Peer.prototype.open = async function() {
          if (this.address.host === '10.0.0.2')
            throw new Error('connection refused');
        };
        Peer.prototype.sendFilterLoad = function() {};
        Peer.prototype.destroy = function() {
          destroyed.push(this.address.host);
        };
      });

      after(() => {
        Object.assign(Peer.prototype, saved);
      });

      const poolWith = (nodes, maxOutbound) => {
        const chain = new Chain({
          network, memory: true, spv: true, anchor: {...trusted}
        });
        const pool = new Pool({
          network, chain, spv: true, listen: false, nodes, maxOutbound
        });
        // 10.0.0.1 never answers; 10.0.0.3 serves the chain above.
        pool.requestHeader = (peer, hash) => {
          if (peer.address.host === '10.0.0.1')
            return new Promise(() => {});
          return Promise.resolve(byHash.get(hash.toString('hex')));
        };
        return pool;
      };

      beforeEach(() => {
        destroyed = [];
      });

      it('asks peers at once and takes the first complete walk', async () => {
        const pool = poolWith(['10.0.0.1:8333', '10.0.0.2:8333',
          '10.0.0.3:8333'], 2);
        const got = await pool.fetchAnchor({...trusted, count: COUNT});
        assert.deepStrictEqual(got.map(h => h.toString('hex')),
          headers.map(h => h.toString('hex')));
        // The silent peer was still waiting, and is dropped.
        assert(destroyed.includes('10.0.0.1'));
        assert(destroyed.includes('10.0.0.2'));
      });

      it('fails when no peer can serve the headers', async () => {
        const pool = poolWith(['10.0.0.2:8333'], 2);
        await assert.rejects(pool.fetchAnchor({...trusted, count: COUNT}),
          /connection refused/);
      });
    });
  });
});
