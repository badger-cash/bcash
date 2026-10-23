/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * The avalanche proof and key RPCs, as Bitcoin ABC's (rpc/avalanche.cpp,
 * abc_rpc_avalancheproof.py, abc_rpc_buildavalancheproof.py): built and
 * decoded by bcash, and, with BITCOIN_ABC_BITCOIND set, decoded alike by
 * Bitcoin ABC.
 */

const assert = require('bsert');
const random = require('bcrypto/lib/random');
const secp256k1 = require('bcrypto/lib/secp256k1');
const KeyRing = require('../lib/primitives/keyring');
const FullNode = require('../lib/node/fullnode');
const ABCRegtest = require('./util/abc-regtest');

// Satoshis; regtest coins are below the mainnet threshold.
const DUST_THRESHOLD = 1000000;

const wif = key => KeyRing.fromPrivate(key).toSecret('regtest');
const pub = key => secp256k1.publicKeyCreate(key, true).toString('hex');

function node(options = {}) {
  return new FullNode({
    network: 'regtest',
    memory: true,
    workers: false,
    avalanche: true,
    avaproofStakeUtxoDustThreshold: DUST_THRESHOLD,
    ...options
  });
}

function caller(n) {
  return async (method, ...params) => {
    const json = await n.rpc.call({method, params}, {});
    if (json.error)
      throw new Error(json.error.message);
    return json.result;
  };
}

describe('Avalanche RPCs', function() {
  const masterKey = secp256k1.privateKeyGenerate();
  const stakeKey = secp256k1.privateKeyGenerate();
  const payout = KeyRing.fromPrivate(masterKey).getAddress()
    .toString('regtest');
  const stakes = [{
    txid: random.randomBytes(32).toString('hex'),
    vout: 0,
    amount: 25000,
    height: 10,
    iscoinbase: true,
    privatekey: wif(stakeKey)
  }];

  const plain = node();
  const rpc = caller(plain);

  before(() => plain.open());
  after(() => plain.close());

  it('should build a proof, and decode it', async () => {
    const hex = await rpc('buildavalancheproof', 3, 0, wif(masterKey),
      stakes, payout);
    const proof = await rpc('decodeavalancheproof', hex);

    assert.strictEqual(proof.sequence, 3);
    assert.strictEqual(proof.expiration, 0);
    assert.strictEqual(proof.master, pub(masterKey));
    assert.deepStrictEqual(proof.payoutscript.addresses, [payout]);
    assert.strictEqual(proof.staked_amount, 25000);
    assert.strictEqual(proof.stakes.length, 1);

    const [stake] = proof.stakes;
    assert.strictEqual(stake.txid, stakes[0].txid);
    assert.strictEqual(stake.vout, 0);
    assert.strictEqual(stake.amount, 25000);
    assert.strictEqual(stake.height, 10);
    assert.strictEqual(stake.iscoinbase, true);
    assert.strictEqual(stake.pubkey, pub(stakeKey));
  });

  it('should refuse a bad master key or payout address', async () => {
    await assert.rejects(rpc('buildavalancheproof', 0, 0, 'nope', stakes,
      payout), {message: 'Invalid master key'});
    await assert.rejects(rpc('buildavalancheproof', 0, 0, wif(masterKey),
      stakes, 'nope'), {message: 'Invalid payout address'});
  });

  it('should not verify a proof of coins it does not have', async () => {
    const hex = await rpc('buildavalancheproof', 0, 0, wif(masterKey),
      stakes, payout);
    await assert.rejects(rpc('verifyavalancheproof', hex),
      {message: 'The proof is invalid: utxo-missing-or-spent'});
  });

  it('should delegate a proof, and decode the delegation', async () => {
    const hex = await rpc('buildavalancheproof', 0, 0, wif(masterKey),
      stakes, payout);
    const proof = await rpc('decodeavalancheproof', hex);

    const next = secp256k1.privateKeyGenerate();
    const dg = await rpc('delegateavalancheproof', proof.limitedid,
      wif(masterKey), pub(next));

    const decoded = await rpc('decodeavalanchedelegation', dg);
    assert.strictEqual(decoded.pubkey, pub(next));
    assert.strictEqual(decoded.proofmaster, pub(masterKey));
    assert.strictEqual(decoded.proofid, proof.proofid);
    assert.strictEqual(decoded.limitedid, proof.limitedid);
    assert.strictEqual(decoded.depth, 1);
    assert(await rpc('verifyavalanchedelegation', dg));

    // On from it: only by its key.
    const last = secp256k1.privateKeyGenerate();
    const dg2 = await rpc('delegateavalancheproof', proof.limitedid,
      wif(next), pub(last), dg);
    assert.strictEqual((await rpc('decodeavalanchedelegation', dg2)).depth, 2);
    await assert.rejects(rpc('delegateavalancheproof', proof.limitedid,
      wif(masterKey), pub(last), dg),
    {message: 'The private key does not match the delegation'});

    // A broken signature.
    const bad = Buffer.from(dg, 'hex');
    bad[bad.length - 1] ^= 1;
    await assert.rejects(rpc('verifyavalanchedelegation', bad.toString('hex')),
      /The delegation is invalid/);
  });

  it('should give the session key, and our proof\'s state', async () => {
    const hex = await rpc('buildavalancheproof', 0, 0, wif(masterKey),
      stakes, payout);
    const sessionKey = secp256k1.privateKeyGenerate();
    const staking = node({
      listen: true,
      avaProof: hex,
      avaMasterKey: wif(masterKey),
      avaSessionKey: wif(sessionKey)
    });
    const call = caller(staking);

    assert.strictEqual(await call('getavalanchekey'), pub(sessionKey));

    const {local} = await call('getavalancheinfo');
    assert.strictEqual(local.verified, false);
    assert.strictEqual(local.verification_status,
      'pending inbound connections');
    assert.strictEqual(local.proofid,
      (await rpc('decodeavalancheproof', hex)).proofid);
    assert.strictEqual(local.master, pub(masterKey));
    assert.strictEqual(local.payout_address, payout);
    assert.strictEqual(local.stake_amount, 25000);

    // A node without a proof has no local section.
    assert.strictEqual((await rpc('getavalancheinfo')).local, undefined);
  });
});

const available = ABCRegtest.available();
const suite = available ? describe : describe.skip;

suite('Avalanche RPCs against Bitcoin ABC'
  + (available ? '' : ' (skipped: BITCOIN_ABC_BITCOIND is not set)'),
function() {
  this.timeout(60000);

  const abc = available ? new ABCRegtest([
    `-avaproofstakeutxodustthreshold=${DUST_THRESHOLD}`
  ]) : null;
  const rpc = caller(node());

  before(() => abc.open());
  after(() => abc.close());

  const masterKey = secp256k1.privateKeyGenerate();
  const stakeKey = secp256k1.privateKeyGenerate();
  const payout = KeyRing.fromPrivate(masterKey).getAddress()
    .toString('regtest');
  const stakes = [{
    txid: random.randomBytes(32).toString('hex'),
    vout: 1,
    amount: 25000,
    height: 10,
    iscoinbase: false,
    privatekey: wif(stakeKey)
  }];

  it('should decode proofs as Bitcoin ABC, each built by either', async () => {
    const ours = await rpc('buildavalancheproof', 5, 1700000000,
      wif(masterKey), stakes, payout);
    const theirs = await abc.call('buildavalancheproof', 5, 1700000000,
      wif(masterKey), stakes, payout);

    for (const hex of [ours, theirs]) {
      const a = await rpc('decodeavalancheproof', hex);
      const b = await abc.call('decodeavalancheproof', hex);
      assert.deepStrictEqual(a, b);
    }
  });

  it('should decode delegations as Bitcoin ABC', async () => {
    const hex = await rpc('buildavalancheproof', 0, 0, wif(masterKey),
      stakes, payout);
    const {limitedid} = await rpc('decodeavalancheproof', hex);
    const next = secp256k1.privateKeyGenerate();

    const ours = await rpc('delegateavalancheproof', limitedid,
      wif(masterKey), pub(next));
    const theirs = await abc.call('delegateavalancheproof', limitedid,
      wif(masterKey), pub(next));

    for (const dg of [ours, theirs]) {
      assert.deepStrictEqual(await rpc('decodeavalanchedelegation', dg),
        await abc.call('decodeavalanchedelegation', dg));
      assert(await abc.call('verifyavalanchedelegation', dg));
    }
  });
});
