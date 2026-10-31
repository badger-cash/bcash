/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * Cases follow Bitcoin ABC's src/avalanche/test/proofpool_tests.cpp.
 */

const assert = require('bsert');
const random = require('bcrypto/lib/random');
const secp256k1 = require('bcrypto/lib/secp256k1');
const consensus = require('../lib/protocol/consensus');
const ProofPool = require('../lib/avalanche/proofpool');
const {buildProof, randomOutpoint} = require('./util/avalanche');

const {REJECTED, SUCCEED, DUPLICATED} = ProofPool.status;

const ids = proofs => proofs.map(p => p.rid());

describe('Avalanche ProofPool', function() {
  const key = secp256k1.privateKeyGenerate();

  const build = (sequence, outpoints) =>
    buildProof({key, sequence, outpoints});

  it('should find conflicts', () => {
    const pool = new ProofPool();
    const a = randomOutpoint();
    const b = randomOutpoint();

    const proofA = build(1, [a]);
    const proofB = build(1, [b]);
    const proofAB = build(2, [a, b]);
    const proofOther = build(1, [randomOutpoint()]);

    assert.strictEqual(pool.getConflicts(proofA).length, 0);
    assert.strictEqual(pool.addIfNoConflict(proofA)[0], SUCCEED);

    // A proof does not conflict with itself.
    assert.strictEqual(pool.getConflicts(proofA).length, 0);
    assert.deepStrictEqual(ids(pool.getConflicts(proofAB)), ids([proofA]));
    assert.strictEqual(pool.getConflicts(proofOther).length, 0);

    assert.strictEqual(pool.addIfNoConflict(proofB)[0], SUCCEED);
    assert.deepStrictEqual(ids(pool.getConflicts(proofAB)).sort(),
      ids([proofA, proofB]).sort());
  });

  it('should add and remove proofs without conflicts', () => {
    const pool = new ProofPool();
    const proofs = [];

    for (let i = 0; i < 10; i++) {
      const proof = buildProof();
      assert.strictEqual(pool.addIfNoConflict(proof)[0], SUCCEED);
      assert.strictEqual(pool.addIfNoConflict(proof)[0], DUPLICATED);
      assert.strictEqual(pool.size, i + 1);
      proofs.push(proof);
    }

    const outpoint = randomOutpoint();
    const seq10 = build(10, [outpoint]);
    assert.strictEqual(pool.addIfNoConflict(seq10)[0], SUCCEED);
    proofs.push(seq10);

    const seq20 = build(20, [outpoint]);
    assert.strictEqual(pool.addIfNoConflict(seq20)[0], REJECTED);
    assert.strictEqual(pool.size, 11);

    for (let i = 0; i < 10; i++)
      assert.strictEqual(pool.remove(random.randomBytes(32)), false);

    for (const proof of proofs)
      assert.strictEqual(pool.remove(proof.id()), true);

    assert.strictEqual(pool.size, 0);
    assert.strictEqual(pool.byOutpoint.size, 0);
  });

  it('should override conflicting proofs with a better one', () => {
    const pool = new ProofPool();
    const o1 = randomOutpoint();
    const o2 = randomOutpoint();
    const o3 = randomOutpoint();

    const seq10 = build(10, [o1]);
    const seq20 = build(20, [o2]);
    const seq30 = build(30, [o3]);

    for (const proof of [seq10, seq20, seq30])
      assert.strictEqual(pool.addIfPreferred(proof)[0], SUCCEED);

    const seq123 = build(123, [o1, o2, o3]);
    // Same master: highest sequence first.
    const expected = ids([seq30, seq20, seq10]);

    let [result, conflicts] = pool.addIfNoConflict(seq123);
    assert.strictEqual(result, REJECTED);
    assert.deepStrictEqual(ids(conflicts), expected);
    assert.strictEqual(pool.size, 3);
    assert(!pool.has(seq123.id()));

    [result, conflicts] = pool.addIfPreferred(seq123);
    assert.strictEqual(result, SUCCEED);
    assert.deepStrictEqual(ids(conflicts), expected);
    assert.strictEqual(pool.size, 1);
    assert(pool.has(seq123.id()));
    assert(!pool.has(seq10.id()));
    assert.strictEqual(pool.getByOutpoint(o2), seq123);
  });

  it('should report conflicts as ABC does', () => {
    const pool = new ProofPool();
    const outpoint = randomOutpoint();
    const seq10 = build(10, [outpoint]);
    const seq20 = build(20, [outpoint]);
    const seq30 = build(30, [outpoint]);

    assert.strictEqual(pool.addIfNoConflict(seq20)[0], SUCCEED);

    assert.deepStrictEqual(pool.addIfNoConflict(seq20), [DUPLICATED, []]);
    assert.deepStrictEqual(pool.addIfPreferred(seq20), [DUPLICATED, []]);

    let [result, conflicts] = pool.addIfNoConflict(seq10);
    assert.strictEqual(result, REJECTED);
    assert.deepStrictEqual(ids(conflicts), ids([seq20]));

    [result, conflicts] = pool.addIfNoConflict(seq30);
    assert.strictEqual(result, REJECTED);
    assert.deepStrictEqual(ids(conflicts), ids([seq20]));

    [result, conflicts] = pool.addIfPreferred(seq10);
    assert.strictEqual(result, REJECTED);
    assert.deepStrictEqual(ids(conflicts), ids([seq20]));

    [result, conflicts] = pool.addIfPreferred(seq30);
    assert.strictEqual(result, SUCCEED);
    assert.deepStrictEqual(ids(conflicts), ids([seq20]));
    assert(pool.has(seq30.id()));
  });

  it('should prefer by score, then fewer stakes, across masters', () => {
    const {compareConflicting} = ProofPool;
    const outpoint = randomOutpoint();
    const COIN = consensus.COIN;

    const small = buildProof({outpoints: [outpoint], amount: 10 * COIN});
    const big = buildProof({outpoints: [outpoint], amount: 20 * COIN,
      sequence: 0});
    assert(compareConflicting(big, small) < 0);
    assert(compareConflicting(small, big) > 0);

    // A different master's higher sequence does not count.
    const highSeq = buildProof({outpoints: [outpoint], amount: 10 * COIN,
      sequence: 99});
    assert(compareConflicting(big, highSeq) < 0);

    // Same score: fewer stakes wins.
    const one = buildProof({outpoints: [outpoint], amount: 20 * COIN});
    const two = buildProof({outpoints: [outpoint, randomOutpoint()],
      amount: 10 * COIN});
    assert.strictEqual(one.getScore(), two.getScore());
    assert(compareConflicting(one, two) < 0);
  });

  it('should find the lowest score proof', () => {
    const pool = new ProofPool();
    assert.strictEqual(pool.getLowestScoreProof(), null);

    const COIN = consensus.COIN;
    for (let i = 9; i >= 0; i--) {
      const proof = buildProof({amount: (100 + i) * COIN});
      pool.addIfNoConflict(proof);
      assert.strictEqual(pool.getLowestScoreProof(), proof);
    }
  });
});
