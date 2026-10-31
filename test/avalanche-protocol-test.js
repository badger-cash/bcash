/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * testnet-avahello.json is an exchange with a Bitcoin ABC testnet staking
 * node: its version and avahello, and its avaresponse to our avapoll.
 */

const assert = require('bsert');
const secp256k1 = require('bcrypto/lib/secp256k1');
const random = require('bcrypto/lib/random');
const packets = require('../lib/net/packets');
const InvItem = require('../lib/primitives/invitem');
const Outpoint = require('../lib/primitives/outpoint');
const Script = require('../lib/script/script');
const Proof = require('../lib/avalanche/proof');
const Delegation = require('../lib/avalanche/delegation');
const {Stake} = require('../lib/avalanche/stake');
const {
  Hello,
  Poll,
  Vote,
  Response,
  invTypes
} = require('../lib/avalanche/protocol');
const capture = require('./data/avalanche/testnet-avahello.json');

const hex = s => Buffer.from(s, 'hex');

function randomDelegation() {
  const masterKey = secp256k1.privateKeyGenerate();
  const key = secp256k1.privateKeyGenerate();
  const stake = new Stake({
    outpoint: new Outpoint(random.randomBytes(32), 0),
    amount: Proof.PROOF_DUST_THRESHOLD,
    height: 100,
    pubkey: secp256k1.publicKeyCreate(key, true)
  });
  const proof = Proof.build({
    sequence: 0n,
    expiration: 0n,
    masterKey,
    payout: Script.fromPubkey(secp256k1.publicKeyCreate(masterKey, true)),
    stakes: [{stake, key}]
  });
  const sessionKey = secp256k1.privateKeyGenerate();
  const dg = Delegation.fromProof(proof);
  dg.addLevel(masterKey, secp256k1.publicKeyCreate(sessionKey, true));
  return [dg, sessionKey];
}

describe('Avalanche protocol', function() {
  describe('Bitcoin ABC exchange', function() {
    const version = packets.VersionPacket.fromRaw(hex(capture.version));
    const ourNonce = hex(capture.ourNonce);
    const hello = Hello.fromRaw(hex(capture.avahello));
    const response = Response.fromRaw(hex(capture.avaresponse));

    it('should read the extra entropy in its version', () => {
      assert.strictEqual(typeof version.extraEntropy, 'bigint');
    });

    it('should verify its hello', () => {
      assert(hello.hasProof());
      assert.strictEqual(hello.toRaw().toString('hex'), capture.avahello);

      // We sent no extra entropy, which ABC reads as 1.
      const [valid, reason] = hello.verify(version.nonce, ourNonce,
        version.extraEntropy, 1n);
      assert.strictEqual(reason, 'valid');
      assert.strictEqual(valid, true);
    });

    it('should not verify its hello for another connection', () => {
      const other = Buffer.from(ourNonce);
      other[0] ^= 1;
      assert.strictEqual(hello.verify(version.nonce, other,
        version.extraEntropy, 1n)[1], 'invalid-avahello-signature');
      assert.strictEqual(hello.verify(version.nonce, ourNonce,
        version.extraEntropy, 0n)[1], 'invalid-avahello-signature');
    });

    it('should verify its response with the session key', () => {
      const pubkey = hello.delegation.verify()[2];
      const poll = Poll.fromRaw(hex(capture.avapoll));

      assert.strictEqual(response.toRaw().toString('hex'),
        capture.avaresponse);
      assert.strictEqual(response.round, poll.round);
      assert.strictEqual(response.votes.length, 1);
      assert.bufferEqual(response.votes[0].hash, poll.invs[0].hash);
      assert(response.verify(pubkey));

      const tampered = Response.fromRaw(hex(capture.avaresponse));
      tampered.votes[0].error ^= 1;
      assert(!tampered.verify(pubkey));
    });
  });

  it('should write a hello with no proof as ABC expects', () => {
    const raw = new Hello().toRaw();
    const expect = Buffer.concat([
      Buffer.alloc(32), // limited proof id
      Buffer.from([0, 0]), // master key, levels
      Buffer.alloc(64), // signature
      Buffer.from([0x00, 0x04, 0x00, 0x00]) // max elements: 1024
    ]);
    assert.bufferEqual(raw, expect);
    assert.strictEqual(Hello.fromRaw(raw).hasProof(), false);
  });

  it('should sign and verify a hello', () => {
    const [dg, sessionKey] = randomDelegation();
    const ours = random.randomBytes(8);
    const theirs = random.randomBytes(8);

    const hello = new Hello(dg).sign(sessionKey, ours, theirs, 5n, 7n);
    const copy = Hello.fromRaw(hello.toRaw());

    // The receiver sees our nonce and entropy as the signer's.
    const [valid, , pubkey] = copy.verify(ours, theirs, 5n, 7n);
    assert.strictEqual(valid, true);
    assert.bufferEqual(pubkey, secp256k1.publicKeyCreate(sessionKey, true));
    assert.strictEqual(copy.verify(theirs, ours, 7n, 5n)[0], false);
  });

  it('should not verify a hello with a bad delegation', () => {
    const [dg, sessionKey] = randomDelegation();
    const nonce = random.randomBytes(8);
    const hello = new Hello(dg).sign(sessionKey, nonce, nonce, 1n, 1n);
    hello.delegation.levels[0].signature[0] ^= 1;
    assert.strictEqual(hello.verify(nonce, nonce, 1n, 1n)[1],
      'invalid-signature');
  });

  it('should round trip a poll and a signed response', () => {
    const invs = [
      new InvItem(invTypes.BLOCK, random.randomBytes(32)),
      new InvItem(invTypes.AVA_PROOF, random.randomBytes(32))
    ];
    const poll = Poll.fromRaw(new Poll(0xfffffffffffffffen, invs).toRaw());
    assert.strictEqual(poll.round, 0xfffffffffffffffen);
    assert.strictEqual(poll.invs[1].type, invTypes.AVA_PROOF);
    assert.bufferEqual(poll.invs[1].hash, invs[1].hash);

    const key = secp256k1.privateKeyGenerate();
    const votes = invs.map(inv => new Vote(0, inv.hash));
    const response = new Response(poll.round, 100, votes).sign(key);
    const copy = Response.fromRaw(response.toRaw());
    assert.strictEqual(copy.cooldown, 100);
    assert(copy.verify(secp256k1.publicKeyCreate(key, true)));
  });
});

describe('Version packet extra entropy', function() {
  const options = {
    nonce: Buffer.alloc(8, 1),
    agent: '/test/',
    height: 1
  };

  it('should not send extra entropy unless set', () => {
    const packet = packets.VersionPacket.fromOptions(options);
    const copy = packets.VersionPacket.fromRaw(packet.toRaw());
    assert.strictEqual(packet.toRaw().length, packet.getSize());
    assert.strictEqual(copy.extraEntropy, null);
  });

  it('should round trip extra entropy', () => {
    const packet = packets.VersionPacket.fromOptions({
      ...options,
      extraEntropy: 0xfedcba9876543210n
    });
    const raw = packet.toRaw();
    assert.strictEqual(raw.length, packet.getSize());
    assert.strictEqual(packets.VersionPacket.fromRaw(raw).extraEntropy,
      0xfedcba9876543210n);
  });
});
