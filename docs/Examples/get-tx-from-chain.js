'use strict';

const bcash = require('../..');

const Logger = require('blgr');

// Setup logger to see what bcash is doing.
const logger = new Logger({
  level: 'info'
});

// A regtest chain, kept in memory, so this runs offline: we mine our own
// blocks instead of syncing them from peers.
bcash.set('regtest');

// A full chain keeps its blocks in a block store, which the indexer
// reads too.
const blocks = new bcash.blockstore.LevelBlockStore({
  logger: logger,
  memory: true
});

// Create an in-memory blockchain.
const chain = new bcash.Chain({
  logger: logger,
  memory: true,
  blocks: blocks
});

const miner = new bcash.Miner({
  chain: chain,
  addresses: [bcash.KeyRing.generate().getAddress()]
});

// Create a chain indexer which indexes tx by hash
const indexer = new bcash.TXIndexer({
  logger: logger,
  memory: true,
  chain: chain,
  blocks: blocks
});

(async function() {
  await logger.open();
  await blocks.open();
  await chain.open();
  await miner.open();
  await indexer.open();

  // Mine a block, so there is a transaction to look up: its coinbase.
  const job = await miner.createJob();
  await chain.add(await job.mineAsync());

  console.log('Current height:', chain.height);

  // The indexer follows the chain as blocks connect.
  await new Promise(r => setTimeout(r, 300));

  const block = await chain.getBlock(chain.tip.hash);
  const meta = await indexer.getMeta(block.txs[0].hash());
  const tx = meta.tx;
  const view = await indexer.getSpentView(tx);

  console.log(`Tx with hash ${tx.txid()}:`, meta);
  console.log(`Tx input: ${tx.getInputValue(view)},` +
    ` output: ${tx.getOutputValue()}, fee: ${tx.getFee(view)}`);

  await indexer.close();
  await miner.close();
  await chain.close();
  await blocks.close();
  await logger.close();
})().catch((err) => {
  console.error(err.stack);
  process.exit(1);
});
