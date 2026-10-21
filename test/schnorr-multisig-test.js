/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

const assert = require('bsert');
const secp256k1 = require('bcrypto/lib/secp256k1');
const Script = require('../lib/script/script');
const MTX = require('../lib/primitives/mtx');
const Coin = require('../lib/primitives/coin');
const KeyRing = require('../lib/primitives/keyring');

// A 2-of-3 Schnorr CHECKMULTISIG must check every signature its bitfield
// names. Until this was fixed, only the first was checked: a spend with one
// valid signature and anything at all in the second verified.

const flags = Script.flags.STANDARD_VERIFY_FLAGS;
const type = Script.hashType.ALL | Script.hashType.SIGHASH_FORKID;

describe('Schnorr CHECKMULTISIG', function() {
  const generated = [0, 1, 2].map(() => KeyRing.generate());
  const pubs = generated.map(k => k.getPublicKey());
  const redeem = Script.fromMultisig(2, 3, pubs);
  // The keys in the order the script holds them, which the bitfield follows.
  const keys = [1, 2, 3].map((i) => {
    const pub = redeem.code[i].data;
    return generated.find(k => k.getPublicKey().equals(pub));
  });

  const prev = new MTX();
  prev.addInput({prevout: {hash: Buffer.alloc(32, 7), index: 0}});
  prev.addOutput(Script.fromScripthash(redeem.hash160()), 10000);
  const coin = Coin.fromTX(prev.toTX(), 0, -1);

  // Spend the multisig with the bitfield `bits` and the signatures `sigsFor`
  // returns; resolves with the script error's code, or null if it verified.
  const spend = (bits, sigsFor) => {
    const mtx = new MTX();
    mtx.addCoin(coin);
    mtx.addOutput(Script.fromAddress(keys[0].getAddress()), 9000);
    const hash = mtx.signatureHash(0, redeem, coin.value, type, flags);
    const sign = k => Buffer.concat([
      secp256k1.schnorrSign(hash, k.privateKey),
      Buffer.from([type])
    ]);

    const input = new Script();
    input.pushData(Buffer.from([bits]));
    for (const sig of sigsFor(sign))
      input.pushData(sig);
    input.pushData(redeem.toRaw());
    input.compile();
    mtx.inputs[0].script = input;

    const tx = mtx.toTX();
    try {
      Script.verify(tx.inputs[0].script, null, coin.script,
        tx, 0, coin.value, flags);
    } catch (e) {
      return e.code;
    }
    return null;
  };

  const garbage = Buffer.concat([Buffer.alloc(64, 0x42), Buffer.from([type])]);

  it('verifies with both named keys\' signatures', () => {
    assert.strictEqual(spend(0b011, s => [s(keys[0]), s(keys[1])]), null);
    assert.strictEqual(spend(0b101, s => [s(keys[0]), s(keys[2])]), null);
    assert.strictEqual(spend(0b110, s => [s(keys[1]), s(keys[2])]), null);
  });

  it('refuses a bad first signature', () => {
    assert.strictEqual(spend(0b011, s => [garbage, s(keys[1])]), 'NULLFAIL');
  });

  it('refuses a bad second signature', () => {
    assert.strictEqual(spend(0b011, s => [s(keys[0]), garbage]), 'NULLFAIL');
  });

  it('refuses a second signature by a key the bitfield does not name', () => {
    assert.strictEqual(spend(0b011, s => [s(keys[0]), s(keys[2])]), 'NULLFAIL');
  });

  it('refuses an empty second signature', () => {
    assert.strictEqual(
      spend(0b011, s => [s(keys[0]), Buffer.alloc(0)]), 'NULLFAIL');
  });

  it('refuses signatures in the wrong order', () => {
    assert.strictEqual(spend(0b011, s => [s(keys[1]), s(keys[0])]), 'NULLFAIL');
  });
});
