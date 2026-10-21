/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * Cases follow Bitcoin ABC's src/avalanche/test/compactproofs_tests.cpp.
 * testnet-avaproofs.json is an avaproofs message a Bitcoin ABC testnet
 * node sent, with the proofs it then sent for it.
 */

const assert = require('bsert');
const secp256k1 = require('bcrypto/lib/secp256k1');
const Outpoint = require('../lib/primitives/outpoint');
const Script = require('../lib/script/script');
const Proof = require('../lib/avalanche/proof');
const {Stake} = require('../lib/avalanche/stake');
const {
  CompactProofs,
  ProofsRequest
} = require('../lib/avalanche/compactproofs');
const capture = require('./data/avalanche/testnet-avaproofs.json');

function randomProof() {
  const masterKey = secp256k1.privateKeyGenerate();
  const key = secp256k1.privateKeyGenerate();
  const stake = new Stake({
    outpoint: new Outpoint(Buffer.from(secp256k1.privateKeyGenerate()), 0),
    amount: Proof.PROOF_DUST_THRESHOLD,
    height: 100,
    pubkey: secp256k1.publicKeyCreate(key, true)
  });
  return Proof.build({
    sequence: 0n,
    expiration: 0n,
    masterKey,
    payout: Script.fromPubkey(secp256k1.publicKeyCreate(masterKey, true)),
    stakes: [{stake, key}]
  });
}

describe('Avalanche CompactProofs', function() {
  it('should match short ids a Bitcoin ABC node announced', () => {
    const cp = CompactProofs.fromRaw(Buffer.from(capture.avaproofs, 'hex'));
    const proofs = capture.proofs.map(hex => Proof.fromHex(hex));

    assert.strictEqual(cp.toRaw().toString('hex'), capture.avaproofs);
    assert.strictEqual(cp.size, proofs.length);
    assert.strictEqual(cp.prefilled.length, 0);

    const sids = proofs.map(p => cp.sid(p.id())).sort((a, b) => a - b);
    const announced = cp.shortIds.slice().sort((a, b) => a - b);
    assert.deepStrictEqual(sids, announced);

    for (const proof of proofs)
      assert.deepStrictEqual(proof.verify(), [true, 'valid']);
  });

  it('should round trip an empty set', () => {
    const cp = new CompactProofs();
    const copy = CompactProofs.fromRaw(cp.toRaw());
    assert.strictEqual(copy.size, 0);
    assert.bufferEqual(copy.key, cp.key);
  });

  it('should round trip short ids and prefilled proofs', () => {
    const proofs = [];
    for (let i = 0; i < 50; i++)
      proofs.push(randomProof());

    for (const [ids, prefilled] of [[0, 0], [50, 0], [0, 50], [50, 50]]) {
      const cp = CompactProofs.fromProofs(proofs.slice(0, ids));
      for (let i = 0; i < prefilled; i++)
        cp.prefilled.push({index: i, proof: proofs[i]});

      const raw = cp.toRaw();
      assert.strictEqual(raw.length, cp.getSize());

      const copy = CompactProofs.fromRaw(raw);
      assert.strictEqual(copy.size, ids + prefilled);
      assert.bufferEqual(copy.key, cp.key);
      assert.deepStrictEqual(copy.shortIds, cp.shortIds);

      for (let i = 0; i < ids; i++)
        assert.strictEqual(copy.sid(proofs[i].id()), copy.shortIds[i]);

      for (let i = 0; i < prefilled; i++) {
        assert.strictEqual(copy.prefilled[i].index, i);
        assert.bufferEqual(copy.prefilled[i].proof.id(), proofs[i].id());
      }
    }
  });

  it('should write the index boundaries', () => {
    const cp = new CompactProofs();
    cp.prefilled.push({index: 0, proof: randomProof()});
    cp.prefilled.push({index: 0xffffffff, proof: randomProof()});
    assert.strictEqual(cp.toRaw().length, cp.getSize());
  });

  it('should not write indexes out of order', () => {
    for (const indexes of [[0, 0], [1, 0]]) {
      const cp = new CompactProofs();
      for (const index of indexes)
        cp.prefilled.push({index, proof: randomProof()});
      assert.throws(() => cp.toRaw(), /Differential value overflow/);
    }
  });

  it('should reject indexes that leave a gap', () => {
    // Prefilled at 0 and 2, no short ids: index 1 cannot be found.
    const cp = new CompactProofs();
    cp.prefilled.push({index: 0, proof: randomProof()});
    cp.prefilled.push({index: 2, proof: randomProof()});
    assert.throws(() => CompactProofs.fromRaw(cp.toRaw()),
      /Non contiguous indexes/);
  });

  it('should reject indexes past 32 bits', () => {
    const cp = new CompactProofs();
    cp.prefilled.push({index: 0, proof: randomProof()});
    const raw = cp.toRaw();

    // A first delta of 2^32 instead of 0.
    const big = Buffer.from([0xff, 0x00, 0x00, 0x00, 0x00, 0x01, 0, 0, 0]);
    const head = raw.slice(0, 16 + 1 + 1);
    const tail = raw.slice(16 + 1 + 1 + 1);
    const bad = Buffer.concat([head, big, tail]);
    assert.throws(() => CompactProofs.fromRaw(bad),
      /Differential value overflow/);
  });
});

describe('Avalanche ProofsRequest', function() {
  it('should encode indexes as differences', () => {
    const req = new ProofsRequest([0, 1, 2, 10, 11]);
    assert.strictEqual(req.toRaw().toString('hex'), '050000000700');
    assert.deepStrictEqual(ProofsRequest.fromRaw(req.toRaw()).indexes,
      [0, 1, 2, 10, 11]);
  });

  it('should not write indexes out of order', () => {
    assert.throws(() => new ProofsRequest([3, 3]).toRaw(),
      /Differential value overflow/);
  });
});
