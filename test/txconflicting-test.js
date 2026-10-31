/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * Bitcoin ABC's TxConflicting (src/txconflicting.h, src/txpool.cpp):
 * transactions spending what the mempool's spend, kept for avalanche.
 */

const assert = require('bsert');
const random = require('bcrypto/lib/random');
const MTX = require('../lib/primitives/mtx');
const Outpoint = require('../lib/primitives/outpoint');
const Script = require('../lib/script/script');
const TxConflicting = require('../lib/mempool/txconflicting');

function spending(...outpoints) {
  const mtx = new MTX();
  for (const outpoint of outpoints)
    mtx.addInput({prevout: outpoint});
  mtx.addOutput(Script.fromPubkeyhash(random.randomBytes(20)), 1000);
  return mtx.toTX();
}

const outpoint = () => new Outpoint(random.randomBytes(32), 0);

describe('TxConflicting', function() {
  let now, pool;

  beforeEach(() => {
    now = 1700000000;
    pool = new TxConflicting({now: () => now, maxTxs: 3});
  });

  it('should keep transactions, once, by what they spend', () => {
    const a = outpoint();
    const b = outpoint();
    const tx1 = spending(a);
    const tx2 = spending(a, b);

    assert(pool.add(tx1));
    assert(!pool.add(tx1));
    assert(pool.add(tx2));
    assert(pool.has(tx1.hash()));
    assert.strictEqual(pool.getTX(tx2.hash()), tx2);

    // Those spending what another does: each once.
    const hashes = pool.getConflicts(spending(a, b)).map(tx => tx.txid());
    assert.deepStrictEqual(hashes.sort(), [tx1.txid(), tx2.txid()].sort());
    assert.strictEqual(pool.getConflicts(spending(outpoint())).length, 0);

    assert(pool.remove(tx1.hash()));
    assert(!pool.remove(tx1.hash()));
    assert.deepStrictEqual(pool.getConflicts(spending(a)).map(t => t.txid()),
      [tx2.txid()]);
  });

  it('should forget them after 20 minutes', () => {
    const tx = spending(outpoint());
    pool.add(tx);

    now += TxConflicting.EXPIRE_TIME - 1;
    pool.limit();
    assert(pool.has(tx.hash()));

    now += TxConflicting.EXPIRE_INTERVAL + 1;
    assert.strictEqual(pool.limit(), 1);
    assert(!pool.has(tx.hash()));
  });

  it('should evict at random down to its limit', () => {
    for (let i = 0; i < 5; i++)
      pool.add(spending(outpoint()));
    assert.strictEqual(pool.limit(), 2);
    assert.strictEqual(pool.size, 3);
  });
});
