/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * Checks bcash's avalanche proofs and delegations against a Bitcoin ABC
 * regtest node, both ways: ABC verifies what bcash builds, and bcash
 * verifies what ABC builds. Runs only when BITCOIN_ABC_BITCOIND is set.
 */

const assert = require('bsert');
const {cashaddr} = require('bstring');
const hash160 = require('bcrypto/lib/hash160');
const secp256k1 = require('bcrypto/lib/secp256k1');
const KeyRing = require('../lib/primitives/keyring');
const Outpoint = require('../lib/primitives/outpoint');
const Script = require('../lib/script/script');
const util = require('../lib/utils/util');
const Proof = require('../lib/avalanche/proof');
const Delegation = require('../lib/avalanche/delegation');
const {Stake} = require('../lib/avalanche/stake');
const ABCRegtest = require('./util/abc-regtest');

// Satoshis; regtest coinbases are below the mainnet threshold.
const DUST_THRESHOLD = 1000000;

// ABC's regtest keys use testnet's prefix; bcash's regtest has bcoin's.
const wif = key => KeyRing.fromPrivate(key).toSecret('testnet');
const pub = key => secp256k1.publicKeyCreate(key, true);
const abcAddress = key => cashaddr.encode('ecregtest', 0,
  hash160.digest(pub(key)));

// Skipped, saying why, without a Bitcoin ABC node to check against.
const available = ABCRegtest.available();
const suite = available ? describe : describe.skip;
const title = 'Avalanche against Bitcoin ABC regtest'
  + (available ? '' : ' (skipped: BITCOIN_ABC_BITCOIND is not set)');

suite(title, function() {
  this.timeout(60000);

  const abc = available ? new ABCRegtest([
    `-avaproofstakeutxodustthreshold=${DUST_THRESHOLD}`,
    '-avaproofstakeutxoconfirmations=1'
  ]) : null;

  const masterKey = secp256k1.privateKeyGenerate();
  const stakeKey = secp256k1.privateKeyGenerate();
  const coins = [];

  before(async () => {
    await abc.open();

    // Coinbases paying the stake key.
    const desc = `pkh(${pub(stakeKey).toString('hex')})`;
    const {descriptor} = await abc.call('getdescriptorinfo', desc);
    const hashes = await abc.call('generatetodescriptor', 4, descriptor);

    for (const hash of hashes) {
      const block = await abc.call('getblock', hash, 2);
      const tx = block.tx[0];
      coins.push({
        txid: tx.txid,
        vout: 0,
        // RPC amounts are in XEC, 100 satoshis each.
        amount: Math.round(tx.vout[0].value * 100),
        height: block.height
      });
    }
  });

  after(async () => {
    await abc.close();
  });

  function stakeOf(coin) {
    return new Stake({
      outpoint: new Outpoint(util.fromRev(coin.txid), coin.vout),
      amount: coin.amount,
      height: coin.height,
      coinbase: true,
      pubkey: pub(stakeKey)
    });
  }

  function bcashProof(sequence, expiration) {
    return Proof.build({
      sequence: BigInt(sequence),
      expiration: BigInt(expiration),
      masterKey,
      payout: Script.fromPubkeyhash(hash160.digest(pub(masterKey))),
      stakes: coins.map(coin => ({stake: stakeOf(coin), key: stakeKey}))
    });
  }

  it('should build a proof Bitcoin ABC accepts', async () => {
    const proof = bcashProof(7, 0);
    assert.deepStrictEqual(proof.verify(DUST_THRESHOLD), [true, 'valid']);

    const decoded = await abc.call('decodeavalancheproof', proof.toHex());
    assert.strictEqual(decoded.proofid, proof.rid());
    assert.strictEqual(decoded.limitedid, util.revHex(proof.limitedId()));
    assert.strictEqual(decoded.score, proof.getScore());
    assert.strictEqual(decoded.stakes.length, coins.length);

    // Against its chain: the coins, their heights and amounts.
    assert.strictEqual(
      await abc.call('verifyavalancheproof', proof.toHex()), true);
  });

  it('should verify a proof Bitcoin ABC builds', async () => {
    const stakes = coins.map(coin => ({
      txid: coin.txid,
      vout: coin.vout,
      amount: coin.amount / 100,
      height: coin.height,
      iscoinbase: true,
      privatekey: wif(stakeKey)
    }));

    const hex = await abc.call('buildavalancheproof', 7, 0, wif(masterKey),
      stakes, abcAddress(masterKey));

    const proof = Proof.fromHex(hex);
    assert.strictEqual(proof.toHex(), hex);
    assert.deepStrictEqual(proof.verify(DUST_THRESHOLD), [true, 'valid']);

    // Signatures aside, it is the proof bcash builds.
    assert.strictEqual(proof.rid(), bcashProof(7, 0).rid());
  });

  it('should reject a stake Bitcoin ABC cannot find', async () => {
    const coin = {...coins[0], height: coins[0].height + 1};
    const bad = Proof.build({
      sequence: 8n,
      expiration: 0n,
      masterKey,
      payout: Script.fromPubkeyhash(hash160.digest(pub(masterKey))),
      stakes: [{stake: stakeOf(coin), key: stakeKey}]
    });

    // Fine without the chain; ABC's chain has the coin at another height.
    assert.deepStrictEqual(bad.verify(DUST_THRESHOLD), [true, 'valid']);
    await assert.rejects(abc.call('verifyavalancheproof', bad.toHex()),
      /height-mismatch/);
  });

  it('should delegate as Bitcoin ABC does', async () => {
    const proof = bcashProof(9, 0);
    const sessionKey = secp256k1.privateKeyGenerate();

    const dg = Delegation.fromProof(proof);
    assert(dg.addLevel(masterKey, pub(sessionKey)));

    const decoded = await abc.call('decodeavalanchedelegation', dg.toHex());
    assert.strictEqual(decoded.proofid, proof.rid());
    assert.strictEqual(decoded.delegationid, dg.rid());
    assert.strictEqual(decoded.pubkey, pub(sessionKey).toString('hex'));
    assert.strictEqual(
      await abc.call('verifyavalanchedelegation', dg.toHex()), true);

    // And ABC's own delegation of the same proof.
    const hex = await abc.call('delegateavalancheproof',
      util.revHex(proof.limitedId()), wif(masterKey),
      pub(sessionKey).toString('hex'));
    const theirs = Delegation.fromHex(hex);
    const [valid, , key] = theirs.verify();
    assert.strictEqual(valid, true);
    assert.bufferEqual(key, pub(sessionKey));
    assert.bufferEqual(theirs.id(), dg.id());
  });
});
