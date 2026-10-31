/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * Avalanche messages mutated at random, from a fixed seed: whatever a
 * peer sends, handling it throws nothing, and what does not decode counts
 * against the peer.
 */

const assert = require('bsert');
const secp256k1 = require('bcrypto/lib/secp256k1');
const NetAddress = require('../lib/net/netaddress');
const packets = require('../lib/net/packets');
const InvItem = require('../lib/primitives/invitem');
const Delegation = require('../lib/avalanche/delegation');
const PeerManager = require('../lib/avalanche/peermanager');
const Processor = require('../lib/avalanche/processor');
const ChainStakeVerifier = require('../lib/avalanche/stakeverifier');
const {CompactProofs} = require('../lib/avalanche/compactproofs');
const {Hello, Poll, Response, Vote, invTypes} =
  require('../lib/avalanche/protocol');
const {FakeChain, MIN_VALID_PROOF_SCORE, buildRandomProof, pub} =
  require('./util/avalanche');

// xorshift32: the same inputs every run.
function prng(seed) {
  let x = seed >>> 0;
  return (max) => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x % max;
  };
}

function mutate(rand, sample) {
  const b = Buffer.from(sample);
  switch (rand(5)) {
    case 0:
      for (let i = 0; i <= rand(4); i++) {
        if (b.length)
          b[rand(b.length)] ^= 1 << rand(8);
      }
      return b;
    case 1:
      return b.slice(0, rand(b.length + 1));
    case 2: {
      const junk = Buffer.alloc(1 + rand(64));
      for (let i = 0; i < junk.length; i++)
        junk[i] = rand(256);
      return Buffer.concat([b, junk]);
    }
    case 3: {
      const at = rand(b.length + 1);
      const big = Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
        0xff, 0x7f]);
      return Buffer.concat([b.slice(0, at), big, b.slice(at)]);
    }
    default:
      return Buffer.alloc(b.length);
  }
}

class FakePeer {
  constructor(id) {
    this.id = id;
    this.outbound = true;
    this.address = NetAddress.fromHostname(
      `10.9.${(id >> 8) & 255}.${id & 255}:8333`, 'main');
    this.localNonce = Buffer.alloc(8, 1);
    this.remoteNonce = Buffer.alloc(8, 2);
    this.remoteEntropy = 1n;
    this.ban = 0;
  }

  hostname() {
    return this.address.hostname;
  }

  send() {}

  increaseBan(score) {
    this.ban += score;
  }
}

describe('Avalanche message fuzzing', function() {
  this.timeout(120000);

  const chain = new FakeChain(100);
  const masterKey = secp256k1.privateKeyGenerate();
  const proof = buildRandomProof(chain, MIN_VALID_PROOF_SCORE, 100,
    masterKey);
  const dg = Delegation.fromProof(proof);
  dg.addLevel(masterKey, pub(secp256k1.privateKeyGenerate()));

  const samples = {
    avahello: new Hello(dg, Buffer.alloc(64, 1), 1024).toRaw(),
    avapoll: new Poll(5n, [new InvItem(invTypes.BLOCK, Buffer.alloc(32, 3))])
      .toRaw(),
    avaresponse: new Response(5n, 100, [new Vote(0, Buffer.alloc(32, 4))])
      .toRaw(),
    avaproof: proof.toRaw(),
    avaproofs: CompactProofs.fromProofs([proof]).toRaw(),
    avaproofsreq: Buffer.from([2, 0, 1])
  };

  it('should throw nothing, and hold what does not decode against the peer',
    async () => {
      const rand = prng(0x5eed);
      let id = 0;
      let malformed = 0;

      for (const [cmd, sample] of Object.entries(samples)) {
        for (let i = 0; i < 300; i++) {
          const pm = new PeerManager({
            verifier: new ChainStakeVerifier({chain, confirmations: 1})
          });
          const processor = new Processor({
            peerManager: pm,
            isIBD: () => false,
            minQuorumStake: 0,
            minAvaproofsNodeCount: 0,
            answerPolls: true
          });

          const peer = new FakePeer(id++);
          processor.addPeer(peer);
          const state = processor.peers.get(peer.id);
          state.compactProofsRequested = true;
          state.sharedProofs = [proof];

          let bad = null;
          processor.misbehaving = (s, reason) => {
            bad = reason;
          };

          const data = mutate(rand, sample);
          await processor.handlePacket(peer,
            new packets.UnknownPacket(cmd, data));

          if (bad && bad.startsWith('malformed-'))
            malformed += 1;
        }
      }

      // Some of each kind did not decode, and counted.
      assert(malformed > 100);
    });

  it('should hold an absurd length against the peer', async () => {
    const pm = new PeerManager({
      verifier: new ChainStakeVerifier({chain, confirmations: 1})
    });
    const processor = new Processor({
      peerManager: pm,
      isIBD: () => false,
      minQuorumStake: 0,
      minAvaproofsNodeCount: 0
    });
    const peer = new FakePeer(9999);
    processor.addPeer(peer);

    let bad = null;
    processor.misbehaving = (s, reason) => {
      bad = reason;
    };

    // A proof whose master key claims 2^63 bytes: bufio refuses the size
    // with a TypeError, still the peer's doing.
    const raw = Buffer.concat([Buffer.alloc(16),
      Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f])]);
    await processor.handlePacket(peer,
      new packets.UnknownPacket('avaproof', raw));
    assert.strictEqual(bad, 'malformed-avaproof');
  });
});
