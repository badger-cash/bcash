/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

const assert = require('bsert');
const FullNode = require('../lib/node/fullnode');
const NodeClient = require('../lib/client/node');

const ports = {
  p2p: 49331,
  node: 49332,
  wallet: 49333
};

const node = new FullNode({
  network: 'regtest',
  apiKey: 'foo',
  walletAuth: true,
  memory: true,
  workers: true,
  workersSize: 2,
  plugins: [require('../lib/wallet/plugin')],
  port: ports.p2p,
  httpPort: ports.node,
  env: {
    'BCASH_WALLET_HTTP_PORT': ports.wallet.toString()
  }
});

const nclient = new NodeClient({
  port: ports.node,
  apiKey: 'foo',
  timeout: 15000
});

describe('RPC', function() {
  this.timeout(15000);

  before(async () => {
    await node.open();
  });

  after(async () => {
    await node.close();
  });

  it('should rpc help', async () => {
    assert(await nclient.execute('help', []));

    await assert.rejects(async () => {
      await nclient.execute('help', ['getinfo']);
    }, {
      name: 'Error',
      message: /^getinfo/
    });
  });

  it('should rpc getinfo', async () => {
    const info = await nclient.execute('getinfo', []);
    assert.strictEqual(info.blocks, 0);
  });

  describe('getblock', function () {
    it('should rpc getblock', async () => {
      const {chain} = await nclient.getInfo();
      const info = await nclient.execute('getblock', [chain.tip]);

      // No segwit: no strippedsize or weight, as Bitcoin ABC's.
      const properties = [
        'hash', 'confirmations',
        'size', 'height', 'version',
        'versionHex', 'merkleroot', 'coinbase',
        'tx', 'time', 'mediantime', 'nonce',
        'bits', 'difficulty', 'chainwork',
        'nTx', 'previousblockhash', 'nextblockhash'
      ];

      for (const property of properties)
        assert(property in info, property);

      assert.deepEqual(chain.height, info.height);
      assert.deepEqual(chain.tip, info.hash);
      assert.equal(info.bits, '207fffff');
    });

    it('should return correct height', async () => {
      // Create an address to mine with.
      const wallet = await node.plugins.walletdb.wdb.get(0);
      const key = await wallet.createReceive(0);
      const address = key.getAddress().toString(node.network.type);

      // Mine two blocks.
      await nclient.execute('generatetoaddress', [2, address]);

      const {chain} = await nclient.getInfo();
      const info = await nclient.execute('getblock', [chain.tip]);

      // Assert the heights match.
      assert.deepEqual(chain.height, info.height);
    });

    it('should return confirmations (main chain)', async () => {
      const {chain} = await nclient.getInfo();

      const {genesis} = node.network;
      const hash = genesis.hash.reverse().toString('hex');

      const info = await nclient.execute('getblock', [hash]);

      assert.deepEqual(chain.height, info.confirmations - 1);
    });

    it('should return confirmations (orphan)', async () => {
      // Get the current chain state
      const {chain} = await nclient.getInfo();

      // Get the chain entry associated with
      // the genesis block.
      const {genesis} = node.network;
      let entry = await node.chain.getEntry(genesis.hash.reverse());

      // Reorg from the genesis block.
      for (let i = 0; i < chain.height + 1; i++) {
        const block = await node.miner.mineBlock(entry);
        await node.chain.add(block);
        entry = await node.chain.getEntry(block.hash());
      }

      // Call getblock using the previous tip
      const info = await nclient.execute('getblock', [chain.tip]);
      assert.deepEqual(info.confirmations, -1);
    });
  });
});
