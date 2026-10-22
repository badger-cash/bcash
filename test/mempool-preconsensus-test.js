/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * Bitcoin ABC's avalanche pre-consensus in the mempool: the transactions
 * avalanche finalized (CTxMemPool::setAvalancheFinalized, finalizedTxs,
 * removeForFinalizedBlock), kept once mined until their block is
 * finalized, never evicted, and no more than fit in a block.
 */

const assert = require('bsert');
const {BufferSet} = require('buffer-map');
const common = require('../lib/blockchain/common');
const Block = require('../lib/primitives/block');
const Mempool = require('../lib/mempool/mempool');
const Chain = require('../lib/blockchain/chain');
const MTX = require('../lib/primitives/mtx');
const KeyRing = require('../lib/primitives/keyring');
const Input = require('../lib/primitives/input');
const MemWallet = require('./util/memwallet');
const BlockStore = require('../lib/blockstore/level');
const Pool = require('../lib/net/pool');
const Processor = require('../lib/avalanche/processor');

const VERIFY_NONE = common.flags.VERIFY_NONE;

async function getMockBlock(chain, txs = [], cb = true) {
  if (cb) {
    const mtx = new MTX();
    mtx.addInput(new Input());
    mtx.addOutput(KeyRing.generate().getAddress(), 0);
    txs = [mtx.toTX(), ...txs];
  }

  const now = Math.floor(Date.now() / 1000);
  const block = new Block();
  block.txs = txs;
  block.prevBlock = chain.tip.hash;
  block.time = chain.tip.time <= now ? chain.tip.time + 1 : now;
  block.bits = await chain.getTarget(block.time, chain.tip);
  return block;
}

describe('Mempool avalanche pre-consensus', function() {
  this.timeout(30000);

  const blocks = new BlockStore({memory: true});
  const chain = new Chain({memory: true, blocks, avalanche: true});
  const mempool = new Mempool({chain, memory: true});

  const coins = new MemWallet();
  const wallet = new MemWallet();
  let coinBlock;

  async function mine(txs = []) {
    const block = await getMockBlock(chain, txs);
    const entry = await chain.add(block, VERIFY_NONE);
    await mempool._addBlock(entry, block.txs);
    return entry;
  }

  // A transaction spending one of the chain's coins, in the mempool.
  async function spend(value = 90000) {
    const mtx = new MTX();
    mtx.addCoin(coins.getCoins()[0]);
    mtx.addOutput(wallet.createReceive().getAddress(), value);
    coins.sign(mtx);
    const tx = mtx.toTX();
    coins.addTX(tx, -1);
    wallet.addTX(tx, -1);
    assert.strictEqual(await mempool.addTX(tx), null);
    return tx;
  }

  // A transaction spending one of the wallet's mempool coins.
  async function spendChild(parent) {
    const mtx = new MTX();
    mtx.addCoin(wallet.getCoins().find(c => c.hash.equals(parent.hash())));
    mtx.addOutput(wallet.createReceive().getAddress(), 80000);
    wallet.sign(mtx);
    const tx = mtx.toTX();
    wallet.addTX(tx, -1);
    assert.strictEqual(await mempool.addTX(tx), null);
    return tx;
  }

  before(async () => {
    await blocks.open();
    await mempool.open();
    await chain.open();

    const mtx = new MTX();
    mtx.addInput(new Input());
    for (let i = 0; i < 20; i++)
      mtx.addOutput(coins.createReceive().getAddress(), 100000);
    const cb = mtx.toTX();

    const block = await getMockBlock(chain, [cb], false);
    coinBlock = await chain.add(block, VERIFY_NONE);
    await mempool._addBlock(coinBlock, block.txs);
    coins.addTX(cb);

    // Past coinbase maturity.
    for (let i = 0; i < 100; i++)
      await mine();
  });

  after(async () => {
    await chain.close();
    await mempool.close();
    await blocks.close();
  });

  it('should wait for the block of the coins it spends', async () => {
    const tx = await spend();
    const entry = mempool.getEntry(tx.hash());

    assert(mempool.isWorthPolling(tx.hash()));
    assert.strictEqual(await mempool.setAvalancheFinalized(entry), null);
    assert(!mempool.isAvalancheFinalized(tx.hash()));

    // Once avalanche finalized it, the transaction can be.
    assert(await chain.finalize(coinBlock));
    const done = await mempool.setAvalancheFinalized(entry);
    assert.deepStrictEqual(done, [tx.hash()]);
    assert(mempool.isAvalancheFinalized(tx.hash()));
  });

  it('should finalize a transaction with its ancestors', async () => {
    const parent = await spend();
    const child = await spendChild(parent);

    const done = await mempool.setAvalancheFinalized(
      mempool.getEntry(child.hash()));

    // Ancestors first.
    assert.deepStrictEqual(done, [parent.hash(), child.hash()]);
    assert(mempool.isAvalancheFinalized(parent.hash()));
  });

  it('should keep them once mined, until their block is final', async () => {
    const tx = await spend();
    await mempool.setAvalancheFinalized(mempool.getEntry(tx.hash()));

    const entry = await mine([tx]);
    assert(!mempool.hasEntry(tx.hash()));
    assert(mempool.isAvalancheFinalized(tx.hash()));

    // A block below it final: still mined in a block above.
    mempool.removeForFinalizedBlock(new BufferSet([tx.hash()]));
    assert(mempool.isAvalancheFinalized(tx.hash()));

    // Its block final: done.
    assert(await chain.finalize(entry));
    mempool.removeForFinalizedBlock(new BufferSet());
    assert(!mempool.isAvalancheFinalized(tx.hash()));
  });

  it('should forget one removed other than by a block', async () => {
    const tx = await spend();
    const entry = mempool.getEntry(tx.hash());
    await mempool.setAvalancheFinalized(entry);
    const size = mempool.finalizedSize;

    mempool.evictEntry(entry);
    assert(!mempool.isAvalancheFinalized(tx.hash()));
    assert.strictEqual(mempool.finalizedSize, size - entry.size);
  });

  it('should never evict them', async () => {
    const kept = await spend();
    await mempool.setAvalancheFinalized(mempool.getEntry(kept.hash()));
    const other = await spend();

    // Everything expired, and the mempool over its size.
    const {expiryTime, maxSize} = mempool.options;
    mempool.options.expiryTime = -1;
    mempool.options.maxSize = 1;
    try {
      mempool.limitSize(other.hash());
    } finally {
      mempool.options.expiryTime = expiryTime;
      mempool.options.maxSize = maxSize;
    }

    assert(mempool.hasEntry(kept.hash()));
    assert(!mempool.hasEntry(other.hash()));
  });

  it('should finalize no more than fits in a block', async () => {
    const tx = await spend();
    const entry = mempool.getEntry(tx.hash());

    // Room for those finalized already, and not this one.
    const maxSize = mempool.options.finalizedMaxSize;
    mempool.options.finalizedMaxSize = mempool.finalizedSize + entry.size;
    try {
      assert(!mempool.isWorthPolling(tx.hash()));
      assert.strictEqual(await mempool.setAvalancheFinalized(entry), null);
    } finally {
      mempool.options.finalizedMaxSize = maxSize;
    }

    assert(mempool.isWorthPolling(tx.hash()));
  });
});

// What the pool does with avalanche's votes on mempool transactions.
describe('Pool transaction votes', function() {
  this.timeout(30000);

  const blocks = new BlockStore({memory: true});
  const chain = new Chain({memory: true, blocks, avalanche: true});
  const mempool = new Mempool({chain, memory: true});
  const pool = new Pool({chain, mempool, memory: true, listen: false,
    avalanche: true, avalanchePreConsensus: true});
  const {voteStatus} = Processor;

  const coins = new MemWallet();
  let coinBlock;

  async function mine(txs = []) {
    const block = await getMockBlock(chain, txs);
    const entry = await chain.add(block, VERIFY_NONE);
    await mempool._addBlock(entry, block.txs);
    return entry;
  }

  async function spend() {
    const mtx = new MTX();
    mtx.addCoin(coins.getCoins()[0]);
    mtx.addOutput(KeyRing.generate().getAddress(), 90000);
    coins.sign(mtx);
    const tx = mtx.toTX();
    coins.addTX(tx, -1);
    assert.strictEqual(await mempool.addTX(tx), null);
    return tx;
  }

  before(async () => {
    await blocks.open();
    await mempool.open();
    await chain.open();

    const mtx = new MTX();
    mtx.addInput(new Input());
    for (let i = 0; i < 10; i++)
      mtx.addOutput(coins.createReceive().getAddress(), 100000);
    const cb = mtx.toTX();

    coinBlock = await chain.add(await getMockBlock(chain, [cb], false),
      VERIFY_NONE);
    coins.addTX(cb);

    for (let i = 0; i < 100; i++)
      await mine();

    // Avalanche finalized a block: transactions are polled.
    assert(await chain.finalize(coinBlock));
    assert(!pool.avalanche.isPreconsensusActivated());
    pool.avalanche.finalizedSinceStart = true;
    assert(pool.avalanche.isPreconsensusActivated());
  });

  after(async () => {
    await chain.close();
    await mempool.close();
    await blocks.close();
  });

  it('should poll a transaction entering the mempool', async () => {
    const tx = await spend();
    await pool.avalanche.transactionAddedToMempool(tx);
    assert(pool.avalanche.voteRecords.has(`3:${tx.hash().toString('hex')}`));
  });

  it('should keep a finalized transaction as final', async () => {
    const tx = await spend();
    await pool.applyTxVote(tx, voteStatus.FINALIZED);
    assert(mempool.isAvalancheFinalized(tx.hash()));
    assert(pool.avalanche.isRecentlyFinalized(tx.hash()));
  });

  it('should drop a rejected one, and remember an invalid one', async () => {
    const rejected = await spend();
    await pool.applyTxVote(rejected, voteStatus.REJECTED);
    assert(!mempool.hasEntry(rejected.hash()));
    assert(!mempool.rejects.test(rejected.hash()));

    const invalid = await spend();
    await pool.applyTxVote(invalid, voteStatus.INVALID);
    assert(!mempool.hasEntry(invalid.hash()));
    assert(mempool.rejects.test(invalid.hash()));
  });

  it('should forget mined ones as their block is final', async () => {
    const tx = await spend();
    await pool.applyTxVote(tx, voteStatus.FINALIZED);

    const entry = await mine([tx]);
    assert(mempool.isAvalancheFinalized(tx.hash()));

    // A block below it: still mined above.
    await pool.finalizedBlockForMempool(await chain.getPrevious(entry));
    assert(mempool.isAvalancheFinalized(tx.hash()));

    await pool.finalizedBlockForMempool(entry);
    assert(!mempool.isAvalancheFinalized(tx.hash()));
  });
});

