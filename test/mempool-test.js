/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

const assert = require('bsert');
const random = require('bcrypto/lib/random');
const common = require('../lib/blockchain/common');
const Block = require('../lib/primitives/block');
const MempoolEntry = require('../lib/mempool/mempoolentry');
const Mempool = require('../lib/mempool/mempool');
const WorkerPool = require('../lib/workers/workerpool');
const Chain = require('../lib/blockchain/chain');
const MTX = require('../lib/primitives/mtx');
const Coin = require('../lib/primitives/coin');
const KeyRing = require('../lib/primitives/keyring');
const Address = require('../lib/primitives/address');
const Outpoint = require('../lib/primitives/outpoint');
const Input = require('../lib/primitives/input');
const Script = require('../lib/script/script');
const MemWallet = require('./util/memwallet');
const policy = require('../lib/protocol/policy');
const Miner = require('../lib/mining/miner');
const BlockStore = require('../lib/blockstore/level');
const {BufferSet} = require('buffer-map');

const SHTYPE = Script.hashType.ALL | Script.hashType.SIGHASH_FORKID;
const VERIFY_NONE = common.flags.VERIFY_NONE;

const ONE_HASH = Buffer.alloc(32, 0x00);
ONE_HASH[0] = 0x01;

const workers = new WorkerPool({
  enabled: true,
  size: 2
});

const blocks = new BlockStore({
  memory: true
});

const chain = new Chain({
  memory: true,
  workers,
  blocks
});

const mempool = new Mempool({
  chain,
  workers,
  memory: true,
  indexAddress: true
});

const wallet = new MemWallet();

let cachedTX = null;

function dummyInput(script, hash) {
  const coin = new Coin();
  coin.height = 0;
  coin.value = 0;
  coin.script = script;
  coin.hash = hash;
  coin.index = 0;

  const fund = new MTX();
  fund.addCoin(coin);
  fund.addOutput(script, 70000);

  const [tx, view] = fund.commit();

  const entry = MempoolEntry.fromTX(tx, view, 0);

  mempool.trackEntry(entry, view);

  return Coin.fromTX(fund, 0, -1);
}

async function getMockBlock(chain, txs = [], cb = true) {
  if (cb) {
    const raddr = KeyRing.generate().getAddress();
    const mtx = new MTX();
    mtx.addInput(new Input());
    mtx.addOutput(raddr, 0);

    txs = [mtx.toTX(), ...txs];
  }

  const now = Math.floor(Date.now() / 1000);
  const time = chain.tip.time <= now ? chain.tip.time + 1 : now;

  const block = new Block();
  block.txs = txs;
  block.prevBlock = chain.tip.hash;
  block.time = time;
  block.bits = await chain.getTarget(block.time, chain.tip);

  return block;
}

describe('Mempool', function() {
  this.timeout(5000);

  it('should open mempool', async () => {
    await workers.open();
    await blocks.open();
    await chain.open();
    await mempool.open();
  });

  it('should handle incoming orphans and TXs', async () => {
    const key = KeyRing.generate();

    const t1 = new MTX();
    t1.addOutput(wallet.getAddress(), 50000);
    t1.addOutput(wallet.getAddress(), 10000);

    const script = Script.fromPubkey(key.publicKey);

    t1.addCoin(dummyInput(script, ONE_HASH));

    const sig = t1.signature(0, script, 70000, key.privateKey, SHTYPE);

    t1.inputs[0].script = Script.fromItems([sig]);

    // balance: 51000
    wallet.sign(t1);

    const t2 = new MTX();
    t2.addTX(t1, 0); // 50000
    t2.addOutput(wallet.getAddress(), 20000);
    t2.addOutput(wallet.getAddress(), 20000);

    // balance: 49000
    wallet.sign(t2);

    const t3 = new MTX();
    t3.addTX(t1, 1); // 10000
    t3.addTX(t2, 0); // 20000
    t3.addOutput(wallet.getAddress(), 23000);

    // balance: 47000
    wallet.sign(t3);

    const t4 = new MTX();
    t4.addTX(t2, 1); // 24000
    t4.addTX(t3, 0); // 23000
    t4.addOutput(wallet.getAddress(), 11000);
    t4.addOutput(wallet.getAddress(), 11000);

    // balance: 22000
    wallet.sign(t4);

    const f1 = new MTX();
    f1.addTX(t4, 1); // 11000
    f1.addOutput(new Address(), 9000);

    // balance: 11000
    wallet.sign(f1);

    const fake = new MTX();
    fake.addTX(t1, 1); // 1000 (already redeemed)
    fake.addOutput(wallet.getAddress(), 6000); // 6000 instead of 500

    // Script inputs but do not sign
    wallet.template(fake);

    // Fake signature
    const input = fake.inputs[0];
    input.script.setData(0, Buffer.alloc(73, 0x00));
    input.script.compile();
    // balance: 11000

    {
      await mempool.addTX(fake.toTX());
      await mempool.addTX(t4.toTX());

      const balance = mempool.getBalance();
      assert.strictEqual(balance, 70000);
    }

    {
      await mempool.addTX(t1.toTX());

      const balance = mempool.getBalance();
      assert.strictEqual(balance, 60000);
    }

    {
      await mempool.addTX(t2.toTX());

      const balance = mempool.getBalance();
      assert.strictEqual(balance, 50000);
    }

    {
      await mempool.addTX(t3.toTX());

      const balance = mempool.getBalance();
      assert.strictEqual(balance, 22000);
    }

    {
      await mempool.addTX(f1.toTX());

      const balance = mempool.getBalance();
      assert.strictEqual(balance, 20000);
    }

    const txs = mempool.getHistory();
    assert(txs.some((tx) => {
      return tx.hash().equals(f1.hash());
    }));
  });

  it('should handle locktime', async () => {
    const key = KeyRing.generate();

    const tx = new MTX();
    tx.addOutput(wallet.getAddress(), 50000);
    tx.addOutput(wallet.getAddress(), 10000);

    const prev = Script.fromPubkey(key.publicKey);
    const prevHash = random.randomBytes(32);

    tx.addCoin(dummyInput(prev, prevHash));
    tx.setLocktime(200);

    chain.tip.height = 200;

    const sig = tx.signature(0, prev, 70000, key.privateKey, SHTYPE);
    tx.inputs[0].script = Script.fromItems([sig]);

    await mempool.addTX(tx.toTX());
    chain.tip.height = 0;
  });

  // A P2SH 1-of-15 spend: standard, dense enough for INPUT_SIGCHECKS, and
  // 15 SigChecks, which at 50 bytes each weigh more than the transaction.
  const multisigSpend = () => {
    const key = KeyRing.generate();
    const keys = [];
    for (let i = 1; i < 15; i++)
      keys.push(KeyRing.generate().getPublicKey());
    keys.push(key.getPublicKey());
    const redeem = new Script();
    redeem.pushInt(1);
    for (const pub of keys)
      redeem.pushData(pub);
    redeem.pushInt(15);
    redeem.pushOp(Script.opcodes.OP_CHECKMULTISIG);
    redeem.compile();

    const tx = new MTX();
    tx.addCoin(dummyInput(Script.fromScripthash(redeem.hash160()),
      random.randomBytes(32)));
    tx.addOutput(wallet.getAddress(), 60000);

    const sig = tx.ecdsaSignature(0, redeem, 70000, key.privateKey, SHTYPE);
    tx.inputs[0].script = new Script()
      .pushInt(0)
      .pushData(sig)
      .pushData(redeem.toRaw())
      .compile();

    return tx;
  };

  it('should count SigChecks, and rate fees on virtual size', async () => {
    const tx = multisigSpend();
    await mempool.addTX(tx.toTX());

    const entry = mempool.getEntry(tx.hash());
    assert.strictEqual(entry.sigchecks, 15);
    assert(entry.size < 15 * policy.BYTES_PER_SIGCHECK);
    assert.strictEqual(entry.getVirtualSize(), 15 * policy.BYTES_PER_SIGCHECK);
    assert.strictEqual(entry.getRate(),
      policy.getRate(15 * policy.BYTES_PER_SIGCHECK, 10000));

    // Kept when the mempool is persisted.
    const copy = MempoolEntry.fromRaw(entry.toRaw());
    assert.strictEqual(copy.sigchecks, 15);
    assert.strictEqual(copy.getVirtualSize(), entry.getVirtualSize());
  });

  it('should fill a block template to its SigChecks limit', async () => {
    // Two 15-SigCheck spends, and a miner with room for one. The miner sees
    // only them: the mempool's other entries here fund the tests' coins
    // from nothing, with negative fees no template can price.
    const entries = [];
    for (let i = 0; i < 2; i++) {
      const tx = multisigSpend().toTX();
      await mempool.addTX(tx);
      entries.push(mempool.getEntry(tx.hash()));
    }
    const view = {
      tip: mempool.tip,
      map: new Map(entries.map(e => [e.txid(), e])),
      hasEntry: () => false
    };

    // This chain is on mainnet's parameters at its start, before Phonon,
    // when blocks are packed by sigops; move Phonon to its start.
    const phononHeight = chain.network.block.phononHeight;
    chain.network.block.phononHeight = 0;
    try {
      const tight = new Miner({ chain, mempool: view, maxSigchecks: 20 });
      const one = await tight.createBlock(chain.tip, wallet.getAddress());
      assert.strictEqual(one.items.length, 1);
      assert.strictEqual(one.sigchecks, 15);

      const roomy = new Miner({ chain, mempool: view, maxSigchecks: 30 });
      const two = await roomy.createBlock(chain.tip, wallet.getAddress());
      assert.strictEqual(two.items.length, 2);
      assert.strictEqual(two.sigchecks, 30);
    } finally {
      chain.network.block.phononHeight = phononHeight;
    }
  });

  it('should refuse inputs too dense in SigChecks', async () => {
    // A P2SH 1-of-15 whose redeem script carries a runt key: 15 SigChecks in
    // a scriptSig too short for them (Bitcoin ABC's "SigChecks on P2SH
    // CHECKMULTISIG 1-of-15 ECDSA with a runt key"). Under the standard
    // flags, as the mempool verifies.
    // CHECKMULTISIG takes keys from the top of the stack, the last pushed:
    // ours is last, so the runt key is never examined, only counted.
    const key = KeyRing.generate();
    const keys = [Buffer.from([0x02])];
    for (let i = 1; i < 14; i++)
      keys.push(KeyRing.generate().getPublicKey());
    keys.push(key.getPublicKey());
    const redeem = new Script();
    redeem.pushInt(1);
    for (const pub of keys)
      redeem.pushData(pub);
    redeem.pushInt(15);
    redeem.pushOp(Script.opcodes.OP_CHECKMULTISIG);
    redeem.compile();

    const tx = new MTX();
    tx.addCoin(dummyInput(Script.fromScripthash(redeem.hash160()),
      random.randomBytes(32)));
    tx.addOutput(wallet.getAddress(), 60000);

    const sig = tx.ecdsaSignature(0, redeem, 70000, key.privateKey, SHTYPE);
    tx.inputs[0].script = new Script()
      .pushInt(0)
      .pushData(sig)
      .pushData(redeem.toRaw())
      .compile();

    let err = null;
    try {
      tx.toTX().check(tx.view, Script.flags.STANDARD_VERIFY_FLAGS);
    } catch (e) {
      err = e;
    }
    assert(err);
    assert.strictEqual(err.code, 'INPUT_SIGCHECKS');
  });

  it('should handle invalid locktime', async () => {
    const key = KeyRing.generate();

    const tx = new MTX();
    tx.addOutput(wallet.getAddress(), 50000);
    tx.addOutput(wallet.getAddress(), 10000);

    const prev = Script.fromPubkey(key.publicKey);
    const prevHash = random.randomBytes(32);

    tx.addCoin(dummyInput(prev, prevHash));
    tx.setLocktime(200);
    chain.tip.height = 200 - 1;

    const sig = tx.signature(0, prev, 70000, key.privateKey, SHTYPE);
    tx.inputs[0].script = Script.fromItems([sig]);

    let err;
    try {
      await mempool.addTX(tx.toTX());
    } catch (e) {
      err = e;
    }

    assert(err);

    chain.tip.height = 0;
  });

  it('should cache non-malleated tx without sig', async () => {
    const key = KeyRing.generate();

    const tx = new MTX();
    tx.addOutput(wallet.getAddress(), 50000);
    tx.addOutput(wallet.getAddress(), 10000);

    const prev = Script.fromPubkey(key.publicKey);
    const prevHash = random.randomBytes(32);

    tx.addCoin(dummyInput(prev, prevHash));

    let err;
    try {
      await mempool.addTX(tx.toTX());
    } catch (e) {
      err = e;
    }

    assert(err);
    assert(!err.malleated);
    assert(mempool.hasReject(tx.hash()));

    cachedTX = tx;
  });

  it('should clear reject cache', async () => {
    const tx = new MTX();
    tx.addOutpoint(new Outpoint());
    tx.addOutput(wallet.getAddress(), 50000);

    assert(mempool.hasReject(cachedTX.hash()));

    await mempool.addBlock({ height: 1 }, [tx.toTX()]);

    assert(!mempool.hasReject(cachedTX.hash()));
  });

  it('should destroy mempool', async () => {
    await mempool.close();
    await chain.close();
    await workers.close();
  });

  describe('Index', function () {
    const workers = new WorkerPool({
      enabled: true,
      size: 2
    });

    const blocks = new BlockStore({
      memory: true
    });

    const chain = new Chain({
      memory: true,
      workers,
      blocks
    });

    const mempool = new Mempool({
      chain,
      workers,
      memory: true,
      indexAddress: true
    });

    before(async() => {
      await blocks.open();
      await mempool.open();
      await chain.open();
      await workers.open();
    });

    after(async () => {
      await workers.close();
      await chain.close();
      await mempool.close();
      await blocks.close();
    });

    // Number of coins available in
    // chaincoins (100k in satoshi per coin).
    const N = 100;
    const chaincoins = new MemWallet();
    const wallet = new MemWallet();

    it('should create coins in chain', async () => {
      const mtx = new MTX();
      mtx.addInput(new Input());

      for (let i = 0; i < N; i++) {
        const addr = chaincoins.createReceive().getAddress();
        mtx.addOutput(addr, 100000);
      }

      const cb = mtx.toTX();
      const block = await getMockBlock(chain, [cb], false);
      const entry = await chain.add(block, VERIFY_NONE);

      await mempool._addBlock(entry, block.txs);

      // Add 100 blocks so we don't get
      // premature spend of coinbase.
      for (let i = 0; i < 100; i++) {
        const block = await getMockBlock(chain);
        const entry = await chain.add(block, VERIFY_NONE);

        await mempool._addBlock(entry, block.txs);
      }

      chaincoins.addTX(cb);
    });

    it('should spend txs and coins in the mempool', async () => {
      // Verify coins are removed from the coin index.
      const coin = chaincoins.getCoins()[0];
      const addr = wallet.createReceive().getAddress();

      const mtx1 = new MTX();

      mtx1.addCoin(coin);
      mtx1.addOutput(addr, 90000);

      chaincoins.sign(mtx1);

      const tx1 = mtx1.toTX();

      chaincoins.addTX(tx1, -1);
      wallet.addTX(tx1, -1);

      {
        const missing = await mempool.addTX(tx1);
        assert.strictEqual(missing, null);
      }

      assert(mempool.hasCoin(tx1.hash(), 0));

      {
        const txs = mempool.getTXByAddress(addr);
        const metas = mempool.getMetaByAddress(addr);

        assert.strictEqual(txs.length, 1);
        assert.strictEqual(metas.length, 1);

        assert.bufferEqual(txs[0].hash(), tx1.hash());
      }

      const mtx2 = new MTX();

      mtx2.addTX(tx1, 0, -1);
      mtx2.addOutput(addr, 80000);

      wallet.sign(mtx2);

      const tx2 = mtx2.toTX();

      {
        const missing = await mempool.addTX(tx2);
        assert.strictEqual(missing, null);
      }

      wallet.addTX(tx2, -1);

      assert(!mempool.hasCoin(tx1.hash(), 0));
      assert(mempool.hasCoin(tx2.hash(), 0));

      {
        const txs = mempool.getTXByAddress(addr);

        assert.strictEqual(txs.length, 2);
      }
    });

    it('should spend resolved orphans', async () => {
      const coin = chaincoins.getCoins()[0];
      const addr = wallet.createReceive().getAddress();

      const pmtx = new MTX();

      pmtx.addOutput(addr, 90000);
      pmtx.addCoin(coin);

      chaincoins.sign(pmtx);

      const parentTX = pmtx.toTX();

      const cmtx = new MTX();

      cmtx.addTX(pmtx.toTX(), 0, -1);
      cmtx.addOutput(addr, 80000);

      wallet.sign(cmtx);

      const childTX = cmtx.toTX();

      {
        // Create orphan tx.
        const missing = await mempool.addTX(childTX);

        // We only have one input missing
        assert.strictEqual(missing.length, 1);
      }

      {
        const txs = mempool.getTXByAddress(addr);

        assert.strictEqual(txs.length, 0);
      }

      {
        // Orphans are not coins
        const childCoin = mempool.getCoin(childTX.hash(), 0);
        assert.strictEqual(childCoin, null);
      }

      {
        // Orphans should be resolved.
        const missing = await mempool.addTX(parentTX);
        assert.strictEqual(missing, null);

        // Coins should be available once they are resolved.
        const parentCoin = mempool.getCoin(parentTX.hash(), 0);

        // We spent this.
        assert.strictEqual(parentCoin, null);

        const childCoin = mempool.getCoin(childTX.hash(), 0);
        assert(childCoin);
      }

      {
        const txs = mempool.getTXByAddress(addr);
        assert.strictEqual(txs.length, 2);
      }

      // Update coins in the wallets.
      for (const tx of [parentTX, childTX]) {
        chaincoins.addTX(tx);
        wallet.addTX(tx);
      }
    });

    it('should remove double spend tx from mempool', async () => {
      const coin = chaincoins.getCoins()[0];
      const addr = wallet.createReceive().getAddress();
      const randomAddress = KeyRing.generate().getAddress();

      // We check double spending our mempool tx.
      const mtx1 = new MTX();

      mtx1.addCoin(coin);
      mtx1.addOutput(addr, 90000);

      chaincoins.sign(mtx1);

      // This will double spend in block.
      const mtx2 = new MTX();

      mtx2.addCoin(coin);
      mtx2.addOutput(randomAddress, 90000);

      chaincoins.sign(mtx2);

      const tx1 = mtx1.toTX();
      const tx2 = mtx2.toTX();

      {
        const missing = await mempool.addTX(tx1);
        assert.strictEqual(missing, null);
      }

      {
        const txs = mempool.getTXByAddress(addr);
        assert.strictEqual(txs.length, 1);
      }

      assert(mempool.hasCoin(tx1.hash(), 0));

      const block = await getMockBlock(chain, [tx2]);
      const entry = await chain.add(block, VERIFY_NONE);

      await mempool._addBlock(entry, block.txs);

      {
        const txs = mempool.getTXByAddress(addr);
        assert.strictEqual(txs.length, 0);
      }

      assert(!mempool.hasCoin(tx1.hash(), 0));

      chaincoins.addTX(tx2);
    });

    it('should remove confirmed txs from mempool', async () => {
      const coin = chaincoins.getCoins()[0];
      const addr = wallet.createReceive().getAddress();

      const mtx = new MTX();

      mtx.addCoin(coin);
      mtx.addOutput(addr, 90000);

      chaincoins.sign(mtx);

      const tx = mtx.toTX();

      await mempool.addTX(tx);

      assert(mempool.hasCoin(tx.hash(), 0));

      {
        const txs = mempool.getTXByAddress(addr);
        assert.strictEqual(txs.length, 1);
      }

      const block = await getMockBlock(chain, [tx]);
      const entry = await chain.add(block, VERIFY_NONE);

      await mempool._addBlock(entry, block.txs);

      {
        const txs = mempool.getTXByAddress(addr);
        assert.strictEqual(txs.length, 0);
      }

      assert(!mempool.hasCoin(tx.hash(), 0));

      chaincoins.addTX(tx);
      wallet.addTX(tx);
    });
  });

    describe('Mempool persistent cache', function () {
    const workers = new WorkerPool({
      enabled: true,
      size: 2
    });

    const blocks = new BlockStore({
      memory: true
    });

    const chain = new Chain({
      memory: true,
      workers,
      blocks
    });

    const mempool = new Mempool({
      chain,
      workers,
      memory: true,
      indexAddress: true,
      persistent: true
    });

    before(async () => {
      await blocks.open();
      await mempool.open();
      await chain.open();
      await workers.open();
    });

    after(async () => {
      await workers.close();
      await chain.close();
      await mempool.close();
      await blocks.close();
    });

    // Number of coins available in
    // chaincoins (100k satoshi per coin).
    const N = 100;
    const chaincoins = new MemWallet();
    const wallet = new MemWallet();

    it('should create txs in chain', async () => {
      const mtx = new MTX();
      mtx.addInput(new Input());

      for (let i = 0; i < N; i++) {
        const addr = chaincoins.createReceive().getAddress();
        mtx.addOutput(addr, 100000);
      }

      const cb = mtx.toTX();
      const block = await getMockBlock(chain, [cb], false);
      const entry = await chain.add(block, VERIFY_NONE);

      await mempool._addBlock(entry, block.txs);

      // Add 100 blocks so we don't get premature
      // spend of coinbase.
      for (let i = 0; i < 100; i++) {
        const block = await getMockBlock(chain);
        const entry = await chain.add(block, VERIFY_NONE);

        await mempool._addBlock(entry, block.txs);
      }

      chaincoins.addTX(cb);
    });

    it('should restore txs in the mempool', async () => {
      this.timeout(20000);
      const coins = chaincoins.getCoins();

      assert.strictEqual(coins.length, N);

      const addrs = [];
      const txs = 20;
      const spend = 5;

      for (let i = 0; i < txs; i++)
        addrs.push(wallet.createReceive().getAddress());

      const mempoolTXs = new BufferSet();
      const mempoolCoins = new BufferSet();

      // Send 15 txs to the wallet.
      for (let i = 0; i < txs - spend; i++) {
        const mtx = new MTX();

        mtx.addCoin(coins[i]);
        mtx.addOutput(addrs[i], 90000);

        chaincoins.sign(mtx);

        const tx = mtx.toTX();
        const missing = await mempool.addTX(tx);

        assert.strictEqual(missing, null);
        assert(mempool.hasCoin(tx.hash(), 0));

        // Indexer checks.
        {
          const txs = mempool.getTXByAddress(addrs[i]);

          assert.strictEqual(txs.length, 1);
          assert.bufferEqual(txs[0].hash(), tx.hash());
        }

        wallet.addTX(tx);

        mempoolTXs.add(tx.hash());
        mempoolCoins.add(Outpoint.fromTX(tx, 0).toKey());
      }

      // Spend first 5 coins from the mempool.
      for (let i = 0; i < spend; i++) {
        const coin = wallet.getCoins()[0];
        const addr = addrs[txs - spend + i];
        const mtx = new MTX();

        mtx.addCoin(coin);
        mtx.addOutput(addr, 80000);

        wallet.sign(mtx);

        const tx = mtx.toTX();
        const missing = await mempool.addTX(tx);

        assert.strictEqual(missing, null);
        assert(!mempool.hasCoin(coin.hash, 0));
        assert(mempool.hasCoin(tx.hash(), 0));

        {
          const txs = mempool.getTXByAddress(addr);
          assert.strictEqual(txs.length, 1);
        }

        {
          const txs = mempool.getTXByAddress(addrs[i]);
          assert.strictEqual(txs.length, 2);
        }

        mempoolTXs.add(tx.hash());
        mempoolCoins.delete(coin.toKey());
        mempoolCoins.add(Outpoint.fromTX(tx, 0).toKey());

        wallet.addTX(tx);
      }

      const verifyMempoolState = (mempool) => {
        // Verify general state of the mempool.
        assert.strictEqual(mempool.map.size, txs);
        assert.strictEqual(mempool.spents.size, txs);

        assert.strictEqual(mempool.addrindex.map.size, txs);

        // Verify txs are same.
        for (const val of mempoolTXs.values())
          assert(mempool.getTX(val));

        for (const opkey of mempoolCoins.values()) {
          const outpoint = Outpoint.fromRaw(opkey);
          assert(mempool.hasCoin(outpoint.hash, outpoint.index));
        }

        // Coins in these txs are spent.
        for (let i = 0; i < spend; i++) {
          const addr = addrs[i];

          const txs = mempool.getTXByAddress(addr);
          assert.strictEqual(txs.length, 2);
        }

        // These txs are untouched.
        for (let i = spend; i < txs - spend; i++) {
          const addr = addrs[i];

          const txs = mempool.getTXByAddress(addr);
          assert.strictEqual(txs.length, 1);
        }

        // These are txs spending mempool txs.
        for (let i = txs - spend; i < txs; i++) {
          const addr = addrs[i];

          const txs = mempool.getTXByAddress(addr);
          assert.strictEqual(txs.length, 1);
        }
      };

      verifyMempoolState(mempool);

      // Hack to get in memory cache in new mempool.
      const cache = mempool.cache;

      // We need to manually sync because when first block
      // was mined there were no mempool txs.
      await cache.sync(chain.tip.hash);

      // Apply batch to the memdb.
      await cache.flush();
      await mempool.close();

      let err;
      {
        const mempool = new Mempool({
          chain,
          workers,
          memory: true,
          indexAddress: true,
          persistent: true
        });

        mempool.cache = cache;

        await mempool.open();

        try {
          verifyMempoolState(mempool);
        } catch (e) {
          err = e;
        } finally {
          await cache.wipe();
          await mempool.close();
        }
      }

      // Reopen for after cleanup.
      await mempool.open();

      if (err)
        throw err;
    });
  });
});

