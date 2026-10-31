'use strict';

const bcash = require('../..');

const key = bcash.KeyRing.generate();

const workers = new bcash.WorkerPool({
  enabled: true
});

const blocks = new bcash.blockstore.LevelBlockStore({
  network: 'regtest',
  memory: true
});

const chain = new bcash.Chain({
  network: 'regtest',
  memory: true,
  blocks: blocks,
  workers: workers
});

const miner = new bcash.Miner({
  chain: chain,
  addresses: [key.getAddress('string', 'regtest')],
  coinbaseFlags: 'my-miner',
  workers: workers
});

// The worker processes don't keep Node.js running on their own (they are
// unref'd), so hold the process open while a worker mines.
const keepAlive = setInterval(() => {}, 1000);

(async () => {
  await workers.open();
  await blocks.open();
  await chain.open();
  await miner.open();

  const tmpl = await miner.createBlock();

  console.log('Block template:');
  console.log(tmpl);

  const job = await miner.createJob();
  const block = await job.mineAsync();

  console.log('Mined block:');
  console.log(block);
  console.log(block.txs[0]);

  await chain.add(block);

  console.log('New tip:');
  console.log(chain.tip);

  await miner.close();
  await chain.close();
  await blocks.close();
  await workers.close();
  clearInterval(keepAlive);
})().catch((err) => {
  console.error(err.stack);
  process.exit(1);
});
