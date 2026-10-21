/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * Vectors are Bitcoin ABC's, from the deserialization test cases in
 * src/avalanche/test/proof_tests.cpp and delegation_tests.cpp.
 */

const assert = require('bsert');
const secp256k1 = require('bcrypto/lib/secp256k1');
const consensus = require('../lib/protocol/consensus');
const Outpoint = require('../lib/primitives/outpoint');
const Script = require('../lib/script/script');
const Proof = require('../lib/avalanche/proof');
const Delegation = require('../lib/avalanche/delegation');
const {Stake} = require('../lib/avalanche/stake');
const proofVectors = require('./data/avalanche/proof-vectors.json');
const delegationVectors = require('./data/avalanche/delegation-vectors.json');

// Bitcoin ABC's ProofValidationResult, as verify() reports it.
const proofReasons = {
  NONE: 'valid',
  NO_STAKE: 'no-stake',
  DUST_THRESHOLD: 'amount-below-dust-threshold',
  DUPLICATE_STAKE: 'duplicated-stake',
  INVALID_PAYOUT_SCRIPT: 'payout-script-non-standard',
  INVALID_PROOF_SIGNATURE: 'invalid-proof-signature',
  INVALID_STAKE_SIGNATURE: 'invalid-stake-signature'
};

const delegationReasons = {
  NONE: 'valid',
  INVALID_SIGNATURE: 'invalid-signature'
};

function randomStake(amount) {
  const key = secp256k1.privateKeyGenerate();
  const stake = new Stake({
    outpoint: new Outpoint(Buffer.from(secp256k1.privateKeyGenerate()), 0),
    amount,
    height: 100,
    coinbase: false,
    pubkey: secp256k1.publicKeyCreate(key, true)
  });
  return {stake, key};
}

function randomProof(count = 3) {
  const masterKey = secp256k1.privateKeyGenerate();
  const stakes = [];
  for (let i = 0; i < count; i++)
    stakes.push(randomStake(Proof.PROOF_DUST_THRESHOLD));
  const proof = Proof.build({
    sequence: 1n,
    expiration: 0n,
    masterKey,
    payout: Script.fromPubkey(secp256k1.publicKeyCreate(masterKey, true)),
    stakes
  });
  return [proof, masterKey];
}

describe('Avalanche Proof', function() {
  for (const v of proofVectors) {
    it(`should handle ABC vector: ${v.name}`, () => {
      const proof = Proof.fromHex(v.hex);

      assert.strictEqual(proof.toHex(), v.hex);
      assert.strictEqual(proof.rid(), v.proofid);
      assert.strictEqual(proof.getScore(), v.score);

      const [valid, reason] = proof.verify();
      assert(proofReasons[v.result], `unmapped result ${v.result}`);
      assert.strictEqual(reason, proofReasons[v.result]);
      assert.strictEqual(valid, v.result === 'NONE');
    });
  }

  it('should build a proof that verifies', () => {
    const [proof] = randomProof(5);
    assert.deepStrictEqual(proof.verify(), [true, 'valid']);

    const copy = Proof.fromRaw(proof.toRaw());
    assert.bufferEqual(copy.id(), proof.id());
    assert.deepStrictEqual(copy.verify(), [true, 'valid']);
  });

  it('should keep a full 64 bit sequence', () => {
    const [proof] = randomProof(1);
    proof.sequence = 0xfedcba9876543210n;
    const copy = Proof.fromRaw(proof.toRaw());
    assert.strictEqual(copy.sequence, 0xfedcba9876543210n);
  });

  it('should order stakes as numbers, from the last byte', () => {
    const a = Buffer.alloc(32, 0x00);
    const b = Buffer.alloc(32, 0x00);
    a[0] = 0xff;
    b[31] = 0x01;
    assert.strictEqual(Proof.compareIds(a, b), -1);
    assert.strictEqual(Proof.compareIds(b, a), 1);
    assert.strictEqual(Proof.compareIds(a, a), 0);

    // Re-signed, so only the order is wrong.
    const [proof, masterKey] = randomProof(3);
    proof.stakes.reverse();
    proof._limitedId = null;
    proof._id = null;
    proof.signature = secp256k1.schnorrSign(proof.limitedId(), masterKey);
    assert.deepStrictEqual(proof.verify(), [false, 'wrong-stake-ordering']);
  });

  it('should reject too many stakes', () => {
    const [proof] = randomProof(1);
    proof.stakes = new Array(Proof.MAX_PROOF_STAKES + 1)
      .fill(proof.stakes[0]);
    assert.deepStrictEqual(proof.verify(), [false, 'too-many-utxos']);
    assert.throws(() => Proof.fromRaw(proof.toRaw()), /Too many stakes/);
  });

  it('should score and clamp amounts as ABC does', () => {
    const MAX = consensus.MAX_MONEY;
    assert.strictEqual(Proof.amountToScore(consensus.COIN), 100);
    assert.strictEqual(Proof.amountToScore(MAX), 2100000000);
    assert.strictEqual(Proof.amountToScore(MAX + 1), 2100000000);
    assert.strictEqual(Proof.amountToScore(-1), 0);
  });
});

describe('Avalanche Delegation', function() {
  for (const v of delegationVectors) {
    it(`should handle ABC vector: ${v.name}`, () => {
      const dg = Delegation.fromHex(v.hex);

      assert.strictEqual(dg.toHex(), v.hex);
      assert.strictEqual(dg.rid(), v.dgid);

      const [valid, reason, pubkey] = dg.verify();
      assert.strictEqual(reason, delegationReasons[v.result]);
      assert.strictEqual(valid, v.result === 'NONE');
      assert.strictEqual(pubkey.toString('hex'), v.pubkey);
    });
  }

  it('should delegate through levels', () => {
    const [proof, masterKey] = randomProof(1);
    const dg = Delegation.fromProof(proof);

    assert.bufferEqual(dg.id(), proof.id());
    assert.bufferEqual(dg.proofId(), proof.id());

    const l1 = secp256k1.privateKeyGenerate();
    const l2 = secp256k1.privateKeyGenerate();
    const l1pub = secp256k1.publicKeyCreate(l1, true);
    const l2pub = secp256k1.publicKeyCreate(l2, true);

    // Only the current delegated key may delegate.
    assert.strictEqual(dg.addLevel(l1, l2pub), false);
    assert.strictEqual(dg.addLevel(masterKey, l1pub), true);
    assert.strictEqual(dg.addLevel(masterKey, l2pub), false);
    assert.strictEqual(dg.addLevel(l1, l2pub), true);

    const [valid, , pubkey] = Delegation.fromRaw(dg.toRaw()).verify();
    assert.strictEqual(valid, true);
    assert.bufferEqual(pubkey, l2pub);
  });

  it('should limit levels', () => {
    const [proof, masterKey] = randomProof(1);
    const dg = Delegation.fromProof(proof);

    let key = masterKey;
    for (let i = 0; i < Delegation.MAX_DELEGATION_LEVELS; i++) {
      const next = secp256k1.privateKeyGenerate();
      assert(dg.addLevel(key, secp256k1.publicKeyCreate(next, true)));
      key = next;
    }

    assert.strictEqual(dg.verify()[0], true);

    const next = secp256k1.privateKeyGenerate();
    assert(dg.addLevel(key, secp256k1.publicKeyCreate(next, true)));
    assert.strictEqual(dg.verify()[1], 'too-many-levels');
    assert.throws(() => Delegation.fromRaw(dg.toRaw()), /Too many/);
  });
});
