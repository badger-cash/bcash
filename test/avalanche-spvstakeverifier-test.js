/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * The SPV stake verifier against a fake SPV pool that serves merkleblocks
 * and blocks, as pool.scanRange does after checking them against the
 * header chain.
 */

const assert = require('bsert');
const EventEmitter = require('events');
const hash160 = require('bcrypto/lib/hash160');
const random = require('bcrypto/lib/random');
const secp256k1 = require('bcrypto/lib/secp256k1');
const Block = require('../lib/primitives/block');
const MerkleBlock = require('../lib/primitives/merkleblock');
const MTX = require('../lib/primitives/mtx');
const Outpoint = require('../lib/primitives/outpoint');
const Script = require('../lib/script/script');
const Proof = require('../lib/avalanche/proof');
const SpvStakeVerifier = require('../lib/avalanche/spvstakeverifier');
const {Stake} = require('../lib/avalanche/stake');

const pub = key => secp256k1.publicKeyCreate(key, true);

// A block at a height with a transaction paying a key.
function blockWith(key, amount) {
  const mtx = new MTX();
  mtx.addInput({prevout: new Outpoint(random.randomBytes(32), 0)});
  mtx.addOutput(Script.fromPubkeyhash(hash160.digest(pub(key))), amount);
  const tx = mtx.toTX();

  const filler = new MTX();
  filler.addInput({prevout: new Outpoint(random.randomBytes(32), 1)});
  filler.addOutput(new Script(), 1);

  const block = new Block();
  block.txs.push(filler.toTX(), tx);
  block.merkleRoot = block.createMerkleRoot();
  return [block, tx];
}

class FakeChain extends EventEmitter {
  constructor(anchor = null) {
    super();
    this.height = 3000;
    this.tip = {height: 3000};
    this.entries = new Map();
    this.options = {anchor};
    this.network = {genesis: {hash: Buffer.alloc(32, 0)}, checkpoints: []};
    this.saved = new Map();
    this.db = {
      getBelowAnchor: async height => this.saved.get(height) || null,
      putBelowAnchor: async (hashes) => {
        for (const [h, hash] of hashes)
          this.saved.set(h, hash);
      }
    };
  }

  async getMedianTime() {
    return 0;
  }

  async getEntryByHeight(height) {
    return this.entries.get(height) || null;
  }
}

// Serves blocks by height, as merkleblocks or whole.
class FakePool {
  constructor() {
    this.blocks = new Map();
    this.bloom = true;
    this.scans = [];
    this.watched = [];
    // What a dishonest peer sends after its merkleblock.
    this.extra = null;
    // Header hashes by height, and walks over them.
    this.headers = [];
    this.walks = 0;
    this.stops = [];
  }

  async scanRange(options, iter) {
    const {filter, full} = options;
    const start = options.entries[0].height;
    this.scans.push(full ? 'full' : 'merkle');

    const block = this.blocks.get(start);

    if (!full) {
      if (!this.bloom)
        throw new Error('No peers to scan from.');
      const hashes = block.txs.filter(tx => filter.test(tx.hash()))
        .map(tx => tx.hash());
      const mb = MerkleBlock.fromHashes(block, hashes);
      mb.txs = block.txs.filter(tx => hashes.some(h => h.equals(tx.hash())));
      if (this.extra)
        mb.txs.push(this.extra);
      await iter({height: start}, mb);
      return;
    }

    await iter({height: start}, block);
  }

  watchOutpoint(outpoint) {
    this.watched.push(outpoint);
  }

  // Headers after `from` up to `stop`, from this.headers.
  async fetchHeaders(from, stop) {
    this.walks += 1;
    this.stops.push(stop);
    const start = this.headers.findIndex(h => h.equals(from));
    const end = this.headers.findIndex(h => h.equals(stop));
    return this.headers.slice(start + 1, end + 1);
  }
}

describe('Avalanche SpvStakeVerifier', function() {
  let chain, pool, verifier;

  const masterKey = secp256k1.privateKeyGenerate();
  const stakeKey = secp256k1.privateKeyGenerate();
  const amount = Proof.PROOF_DUST_THRESHOLD;

  beforeEach(() => {
    chain = new FakeChain();
    pool = new FakePool();
    verifier = new SpvStakeVerifier({chain, pool, confirmations: 1});
  });

  // A stake on a coin in a block at height 100, and its proof.
  function setup(options = {}) {
    const [block, tx] = blockWith(stakeKey, amount);
    chain.entries.set(100, {height: 100, hash: block.hash()});
    pool.blocks.set(100, block);

    const stake = new Stake({
      outpoint: new Outpoint(tx.hash(), 0),
      amount: options.amount || amount,
      height: 100,
      pubkey: pub(stakeKey)
    });

    const proof = Proof.build({
      sequence: 0n,
      expiration: 0n,
      masterKey,
      payout: Script.fromPubkey(pub(masterKey)),
      stakes: [{stake, key: stakeKey}]
    });

    return {block, tx, stake, proof};
  }

  it('should find a stake by merkleblock, then watch it', async () => {
    const {stake, proof} = setup();

    assert.deepStrictEqual(await verifier.verify(proof), [true, 'valid']);
    assert.deepStrictEqual(pool.scans, ['merkle']);
    assert.strictEqual(pool.watched.length, 1);
    assert(pool.watched[0].equals(stake.outpoint));

    // Cached.
    assert.deepStrictEqual(await verifier.verify(proof), [true, 'valid']);
    assert.deepStrictEqual(pool.scans, ['merkle']);
  });

  it('should fetch the whole block without bloom peers', async () => {
    const {proof} = setup();
    pool.bloom = false;

    assert.deepStrictEqual(await verifier.verify(proof), [true, 'valid']);
    assert.deepStrictEqual(pool.scans, ['merkle', 'full']);
  });

  it('should not take a transaction outside the partial tree', async () => {
    const {tx, proof} = setup();

    // The peer sends the stake's transaction, but its merkleblock does not
    // match it: only what the tree proves counts.
    const block = pool.blocks.get(100);
    pool.blocks.set(100, Object.assign(Object.create(block), {
      txs: block.txs.filter(t => !t.hash().equals(tx.hash()))
    }));
    pool.extra = tx;

    const [valid, reason] = await verifier.verify(proof);
    assert.strictEqual(valid, false);
    assert.strictEqual(reason, 'utxo-missing-or-spent');
  });

  it('should check the coin as a full node does', async () => {
    const {proof} = setup({amount: amount + 1});
    assert.deepStrictEqual(await verifier.verify(proof),
      [false, 'amount-mismatch']);
  });

  it('should not find a stake beyond its headers, but try again', async () => {
    const {proof} = setup();
    const entry = chain.entries.get(100);
    chain.entries.delete(100);

    assert.deepStrictEqual(await verifier.verify(proof),
      [false, 'utxo-missing-or-spent']);
    assert.deepStrictEqual(pool.scans, []);

    chain.entries.set(100, entry);
    assert.deepStrictEqual(await verifier.verify(proof), [true, 'valid']);
  });

  describe('below an anchor', function() {
    // An anchored chain whose first block is at 2000; a checkpoint at 50.
    function anchored() {
      chain = new FakeChain({height: 2000});
      verifier = new SpvStakeVerifier({chain, pool, confirmations: 1});
      for (let h = 0; h <= 2000; h++)
        pool.headers.push(random.randomBytes(32));
      chain.entries.set(2000, {height: 2000, hash: pool.headers[2000]});
      chain.network.checkpoints = [{height: 50, hash: pool.headers[50]}];
    }

    it('should find a stake by walking up to the anchor', async () => {
      anchored();
      const {block, proof} = setup();
      // setup() put the stake's block in the chain; below an anchor it is
      // not, but its hash is in the headers walked.
      chain.entries.delete(100);
      pool.headers[100] = block.hash();

      assert.deepStrictEqual(await verifier.verify(proof), [true, 'valid']);
      assert.strictEqual(pool.walks, 1);
      // Kept, for the next run.
      assert.bufferEqual(chain.saved.get(100), block.hash());
    });

    it('should not take a walk that misses the anchor', async () => {
      anchored();
      const {proof} = setup();
      chain.entries.delete(100);
      // A peer that stops short.
      pool.fetchHeaders = async () => pool.headers.slice(51, 1000);

      assert.deepStrictEqual(await verifier.verify(proof),
        [false, 'utxo-missing-or-spent']);
    });

    it('should stop a walk where an earlier one started', async () => {
      anchored();
      chain.network.checkpoints.push({height: 1000, hash: pool.headers[1000]});

      // From the checkpoint at 1000 up to the anchor; then from 50, only
      // up to 1000.
      const high = await verifier.blockAt(1500);
      assert.bufferEqual(high.hash, pool.headers[1500]);
      assert.bufferEqual(pool.stops[0], pool.headers[2000]);

      const low = await verifier.blockAt(100);
      assert.bufferEqual(low.hash, pool.headers[100]);
      assert.strictEqual(pool.walks, 2);
      assert.bufferEqual(pool.stops[1], pool.headers[1000]);

      // Every height between is known, with no walk.
      assert.bufferEqual((await verifier.blockAt(1200)).hash,
        pool.headers[1200]);
      assert.strictEqual(pool.walks, 2);
    });

    it('should use a hash kept from an earlier run', async () => {
      anchored();
      const {block, proof} = setup();
      chain.entries.delete(100);
      chain.saved.set(100, block.hash());

      assert.deepStrictEqual(await verifier.verify(proof), [true, 'valid']);
      assert.strictEqual(pool.walks, 0);
    });
  });

  it('should see a spend in a connected block, and undo it', async () => {
    const {stake, proof} = setup();
    await verifier.verify(proof);

    const spend = new MTX();
    spend.addInput({prevout: stake.outpoint});
    spend.addOutput(new Script(), 1);

    const spending = {txs: [spend.toTX()]};
    chain.emit('connect', {height: 3001}, spending);

    assert.deepStrictEqual(await verifier.verify(proof),
      [false, 'utxo-missing-or-spent']);

    chain.emit('disconnect', {height: 3001});
    assert.deepStrictEqual(await verifier.verify(proof), [true, 'valid']);
  });
});
