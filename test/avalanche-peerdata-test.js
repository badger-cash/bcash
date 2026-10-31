/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * A staking node's peer data, checked as Bitcoin ABC checks -avaproof,
 * -avamasterkey, -avadelegation and -avasessionkey
 * (abc_feature_avalanche_options.py).
 */

const assert = require('bsert');
const secp256k1 = require('bcrypto/lib/secp256k1');
const KeyRing = require('../lib/primitives/keyring');
const Delegation = require('../lib/avalanche/delegation');
const Proof = require('../lib/avalanche/proof');
const {makePeerData} = require('../lib/avalanche/peerdata');
const FullNode = require('../lib/node/fullnode');
const {FakeChain, MIN_VALID_PROOF_SCORE, buildRandomProof, pub} =
  require('./util/avalanche');

const wif = key => KeyRing.fromPrivate(key).toSecret('regtest');

describe('Avalanche peer data', function() {
  const masterKey = secp256k1.privateKeyGenerate();
  const proof = buildRandomProof(new FakeChain(100), MIN_VALID_PROOF_SCORE,
    100, masterKey);

  const make = options => makePeerData({
    proof: proof.toHex(),
    masterKey: wif(masterKey),
    network: 'regtest',
    ...options
  });

  const fails = (options, message) => {
    assert.throws(() => make(options), {message});
  };

  it('should delegate the proof to a random session key', () => {
    const data = make();
    assert.bufferEqual(data.proof.id(), proof.id());

    const [valid,, auth] = data.delegation.verify();
    assert(valid);
    assert.bufferEqual(auth,
      secp256k1.publicKeyCreate(data.sessionKey, true));
    assert.strictEqual(data.delegation.levels.length, 1);

    // Another run, another key.
    assert.notBufferEqual(make().sessionKey, data.sessionKey);
  });

  it('should take a session key, and none beyond the master', () => {
    const sessionKey = secp256k1.privateKeyGenerate();
    const data = make({sessionKey: wif(sessionKey)});
    assert.bufferEqual(data.sessionKey, sessionKey);

    const same = make({sessionKey: wif(masterKey)});
    assert.strictEqual(same.delegation.levels.length, 0);
  });

  it('should take a delegation, with its key', () => {
    const delegated = secp256k1.privateKeyGenerate();
    const dg = Delegation.fromProof(proof);
    assert(dg.addLevel(masterKey, pub(delegated)));

    const data = make({delegation: dg.toHex(), masterKey: wif(delegated)});
    assert.strictEqual(data.delegation.levels.length, 2);
    assert(data.delegation.verify()[0]);

    fails({delegation: dg.toHex()},
      'The master key does not match the delegation public key.');

    const other = buildRandomProof(new FakeChain(100),
      MIN_VALID_PROOF_SCORE, 100, masterKey);
    fails({delegation: Delegation.fromProof(other).toHex()},
      'The delegation does not match the proof.');
  });

  it('should refuse to stake without listening, as Bitcoin ABC', () => {
    const options = {
      network: 'regtest',
      memory: true,
      workers: false,
      avalanche: true,
      avaProof: proof.toHex(),
      avaMasterKey: wif(masterKey)
    };
    assert.throws(() => new FullNode({...options, listen: false}), {
      message: 'Running a staking node requires accepting inbound '
        + 'connections. Please enable --listen.'
    });
    assert.throws(() => new FullNode({...options, avalanche: false,
      listen: true}),
    {message: 'Running a staking node requires --avalanche.'});
  });

  it('should refuse bad keys and proofs, as Bitcoin ABC', () => {
    fails({masterKey: null},
      'The avalanche master key is missing for the avalanche proof.');
    fails({masterKey: 'nope'}, 'The avalanche master key is invalid.');
    fails({sessionKey: 'nope'}, 'The avalanche session key is invalid.');
    fails({masterKey: wif(secp256k1.privateKeyGenerate())},
      'The master key does not match the proof public key.');
    fails({proof: 'ff'}, 'The avalanche proof is invalid.');
    fails({dustThreshold: Proof.PROOF_DUST_THRESHOLD * 1000},
      'The avalanche proof stake is too low.');
  });
});
