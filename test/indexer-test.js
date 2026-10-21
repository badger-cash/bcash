/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

const assert = require('bsert');
const EventEmitter = require('events');
const reorg = require('./util/reorg');
const Script = require('../lib/script/script');
const Opcode = require('../lib/script/opcode');
const Address = require('../lib/primitives/address');
const Block = require('../lib/primitives/block');
const Chain = require('../lib/blockchain/chain');
const WorkerPool = require('../lib/workers/workerpool');
const Miner = require('../lib/mining/miner');
const MemWallet = require('./util/memwallet');
const TXIndexer = require('../lib/indexer/txindexer');
const AddrIndexer = require('../lib/indexer/addrindexer');
const BlockStore = require('../lib/blockstore/level');
const FullNode = require('../lib/node/fullnode');
const SPVNode = require('../lib/node/spvnode');
const Network = require('../lib/protocol/network');
const network = Network.get('regtest');
const NodeClient = require('../lib/client/node');
const WalletClient = require('../lib/client/wallet');
const {forValue, testdir, rimraf} = require('./util/common');

const ports = {
  p2p: 49331,
  node: 49332,
  wallet: 49334
};

const vectors = [
  // Secret for the public key vectors:
  // cVDJUtDjdaM25yNVVDLLX3hcHUfth4c7tY3rSc4hy9e8ibtCuj6G
  {
    addr: 'ecash:qzg9x9d3j62f7ljce5hzvu4krq4srv59cgjqu0fhkm',
    amount: 1.99,
    label: 'p2pkh'
  },
  {
    addr: 'ecash:qr23z9xn6fgq0yh4f4k7pg7kl7lrh6temvqwf7v325',
    amount: 0.11,
    label: 'p2pkh'
  }
];


const workers = new WorkerPool({
  enabled: true,
  size: 2
});

const blocks = new BlockStore({
  memory: true,
  network
});

const chain = new Chain({
  memory: true,
  network,
  workers,
  blocks
});

const miner = new Miner({
  chain,
  version: 4,
  workers
});

const cpu = miner.cpu;

const wallet = new MemWallet({
  network
});

const txindexer = new TXIndexer({
  memory: true,
  network,
  chain,
  blocks
});

const addrindexer = new AddrIndexer({
  memory: true,
  network,
  chain,
  blocks
});

describe('Indexer', function() {
  this.timeout(120000);

  before(async () => {
    await blocks.open();
    await chain.open();
    await miner.open();
    await txindexer.open();
    await addrindexer.open();
    await workers.open();
  });

  after(async () => {
    await workers.close();
    await blocks.close();
    await chain.close();
    await miner.close();
    await txindexer.close();
    await addrindexer.close();
  });

  describe('Unit', function() {
    it('should connect block', async () => {
      const indexer = new AddrIndexer({
        blocks: {},
        chain: {}
      });

      indexer.height = 9;

      indexer.getBlockMeta = (height) => {
        return {
          hash: Buffer.alloc(32, 0x00),
          height: height
        };
      };

      let called = false;
      indexer._addBlock = async () => {
        called = true;
      };

      const meta = {height: 10};
      const block = {prevBlock: Buffer.alloc(32, 0x00)};
      const view = {};

      const connected = await indexer._syncBlock(meta, block, view);
      assert.equal(connected, true);
      assert.equal(called, true);
    });

    it('should not connect block', async () => {
      const indexer = new AddrIndexer({
        blocks: {},
        chain: {}
      });

      indexer.height = 9;

      indexer.getBlockMeta = (height) => {
        return {
          hash: Buffer.alloc(32, 0x02),
          height: height
        };
      };

      let called = false;
      indexer._addBlock = async () => {
        called = true;
      };

      const meta = {height: 10};
      const block = {prevBlock: Buffer.alloc(32, 0x01)};
      const view = {};

      const connected = await indexer._syncBlock(meta, block, view);
      assert.equal(connected, false);
      assert.equal(called, false);
    });

    it('should disconnect block', async () => {
      const indexer = new AddrIndexer({
        blocks: {},
        chain: {}
      });

      indexer.height = 9;

      indexer.getBlockMeta = (height) => {
        return {
          hash: Buffer.alloc(32, 0x00),
          height: height
        };
      };

      let called = false;
      indexer._removeBlock = async () => {
        called = true;
      };

      const meta = {height: 9};
      const block = {hash: () => Buffer.alloc(32, 0x00)};
      const view = {};

      const connected = await indexer._syncBlock(meta, block, view);
      assert.equal(connected, true);
      assert.equal(called, true);
    });

    it('should not disconnect block', async () => {
      const indexer = new AddrIndexer({
        blocks: {},
        chain: {}
      });

      indexer.height = 9;

      indexer.getBlockMeta = (height) => {
        return {
          hash: Buffer.alloc(32, 0x01),
          height: height
        };
      };

      let called = false;
      indexer._removeBlock = async () => {
        called = true;
      };

      const meta = {height: 9};
      const block = {hash: () => Buffer.alloc(32, 0x02)};
      const view = {};

      const connected = await indexer._syncBlock(meta, block, view);
      assert.equal(connected, false);
      assert.equal(called, false);
    });

    it('should error with limits', async () => {
      const indexer = new AddrIndexer({
        blocks: {},
        chain: {},
        maxTxs: 10
      });

      await assert.rejects(async () => {
        await indexer.getHashesByAddress(vectors[0].addr, {limit: 11});
      }, {
        name: 'Error',
        message: 'Limit above max of 10.'
      });
    });

    it('should track bound chain events and remove on close', async () => {
      const indexer = new AddrIndexer({
        blocks: {},
        chain: new EventEmitter()
      });

      const events = ['connect', 'disconnect', 'reset'];

      await indexer.open();

      for (const event of events)
        assert.equal(indexer.chain.listeners(event).length, 1);

      await indexer.close();

      for (const event of events)
        assert.equal(indexer.chain.listeners(event).length, 0);
    });
  });

    describe('Integration', function() {
      const prefix = testdir('indexer');

      beforeEach(async () => {
        await rimraf(prefix);
      });

      after(async () => {
        await rimraf(prefix);
      });

      it('will not index if pruned', async () => {
        let err = null;

        try {
          new FullNode({
            prefix: prefix,
            network: 'regtest',
            apiKey: 'foo',
            memory: false,
            prune: true,
            indexTX: true,
            indexAddress: true,
            port: ports.p2p,
            httpPort: ports.node
          });
        } catch (e) {
          err = e;
        }

        assert(err);
        assert.equal(err.message, 'Can not index while pruned.');
      });

      it('will not index if spv', async () => {
        const node = new SPVNode({
          prefix: prefix,
          network: 'regtest',
          apiKey: 'foo',
          memory: false,
          indexTX: true,
          indexAddress: true,
          port: ports.p2p,
          httpPort: ports.node
        });

        assert.equal(node.txindex, null);
        assert.equal(node.addrindex, null);
      });
    });
});
