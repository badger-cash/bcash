'use strict';
const bcash = require('../..');

// Default network (so we can avoid passing
// the `network` option into every object below.)
bcash.set('regtest');

// Start up a blockchain, mempool, and miner using in-memory
// databases (stored in a red-black tree instead of on-disk).
// A full chain keeps its blocks in a block store.
const blocks = new bcash.blockstore.LevelBlockStore({ memory: true });
const chain = new bcash.Chain({ memory: true, blocks: blocks });
const mempool = new bcash.Mempool({ chain: chain });
const miner = new bcash.Miner({
  chain: chain,
  mempool: mempool
});

(async () => {
  // Open the block store and the chain.
  await blocks.open();
  await chain.open();

  // Open the mempool and the miner.
  await mempool.open();
  await miner.open();

  // Create a CPU miner job.
  const job = await miner.createJob();

  // Run the miner.
  const block = await job.mineAsync();

  // Add the block to the chain.
  console.log('Adding %s to the blockchain.', block.rhash());
  console.log(block);
  await chain.add(block);
  console.log('Added block!');

  await miner.close();
  await mempool.close();
  await chain.close();
  await blocks.close();
})().catch((err) => {
  console.error(err.stack);
  process.exit(1);
});
