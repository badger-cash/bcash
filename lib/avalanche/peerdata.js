/*!
 * peerdata.js - a staking node's own proof, delegation and session key
 * Copyright (c) 2026, Marianas Rai Corp (MIT License).
 * Ported from Bitcoin ABC's MakeProcessor in src/avalanche/processor.cpp.
 */

'use strict';

const assert = require('bsert');
const secp256k1 = require('bcrypto/lib/secp256k1');
const KeyRing = require('../primitives/keyring');
const Proof = require('./proof');
const Delegation = require('./delegation');

/*
 * Errors, as Bitcoin ABC words them.
 */

const proofErrors = {
  'no-stake': 'The avalanche proof has no stake.',
  'amount-below-dust-threshold': 'The avalanche proof stake is too low.',
  'duplicated-stake': 'The avalanche proof has duplicated stake.',
  'invalid-stake-signature':
    'The avalanche proof has invalid stake signatures.',
  'too-many-utxos': 'The avalanche proof has too many utxos '
    + `(max: ${Proof.MAX_PROOF_STAKES}).`
};

const delegationErrors = {
  'invalid-signature': 'The avalanche delegation has invalid signatures.',
  'too-many-levels':
    'The avalanche delegation has too many delegation levels.'
};

/**
 * A staking node's peer data: its proof, the delegation of it to the
 * session key, and the session key, which signs our hellos and responses.
 * Checked as Bitcoin ABC checks -avaproof, -avamasterkey, -avadelegation
 * and -avasessionkey; throws its errors. The proof's coins are checked
 * later, as it registers.
 * @param {Object} options
 * @param {String} options.proof - Hex.
 * @param {String} [options.masterKey] - WIF.
 * @param {String} [options.delegation] - Hex.
 * @param {String} [options.sessionKey] - WIF; random if omitted.
 * @param {Number} [options.dustThreshold] - Satoshis.
 * @param {Network|String} [options.network]
 * @returns {Object} {proof, delegation, sessionKey}
 */

function makePeerData(options) {
  assert(options && options.proof);

  const {network} = options;

  let sessionKey;
  if (options.sessionKey != null) {
    sessionKey = privateKey(options.sessionKey, network);
    if (!sessionKey)
      throw new Error('The avalanche session key is invalid.');
  } else {
    sessionKey = secp256k1.privateKeyGenerate();
  }

  if (options.masterKey == null) {
    throw new Error('The avalanche master key is missing for the '
      + 'avalanche proof.');
  }

  const masterKey = privateKey(options.masterKey, network);
  if (!masterKey)
    throw new Error('The avalanche master key is invalid.');

  let proof;
  try {
    proof = Proof.fromHex(options.proof);
  } catch (e) {
    throw new Error('The avalanche proof is invalid.');
  }

  const dust = options.dustThreshold != null
    ? options.dustThreshold
    : Proof.PROOF_DUST_THRESHOLD;

  const [valid, reason] = proof.verify(dust);
  if (!valid)
    throw new Error(proofErrors[reason] || 'The avalanche proof is invalid.');

  const masterPub = secp256k1.publicKeyCreate(masterKey, true);

  let delegation;
  if (options.delegation != null) {
    try {
      delegation = Delegation.fromHex(options.delegation);
    } catch (e) {
      throw new Error('The avalanche delegation is invalid.');
    }

    if (!delegation.proofId().equals(proof.id()))
      throw new Error('The delegation does not match the proof.');

    if (!masterPub.equals(delegation.getDelegatedPubkey())) {
      throw new Error('The master key does not match the delegation '
        + 'public key.');
    }
  } else {
    if (!masterPub.equals(proof.master))
      throw new Error('The master key does not match the proof public key.');

    delegation = Delegation.fromProof(proof);
  }

  // To the session key, if it is not the master key.
  const sessionPub = secp256k1.publicKeyCreate(sessionKey, true);
  if (!sessionPub.equals(masterPub)) {
    if (!delegation.addLevel(masterKey, sessionPub))
      throw new Error('Failed to generate a delegation for this session.');
  }

  const [ok, why, auth] = delegation.verify();
  if (!ok) {
    throw new Error(delegationErrors[why]
      || 'The avalanche delegation is invalid.');
  }

  if (!auth.equals(sessionPub)) {
    throw new Error('The avalanche delegation does not match '
      + 'the expected public key.');
  }

  return {proof, delegation, sessionKey};
}

/*
 * Helpers
 */

function privateKey(wif, network) {
  try {
    return KeyRing.fromSecret(wif, network).privateKey;
  } catch (e) {
    return null;
  }
}

/*
 * Expose
 */

exports.makePeerData = makePeerData;
