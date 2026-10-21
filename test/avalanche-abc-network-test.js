/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * A bcash full node with avalanche on, connected to a Bitcoin ABC regtest
 * node that stakes a proof. bcash syncs from it, checks its hello, fetches
 * its proof and registers it against bcash's own coins. Runs only when
 * BITCOIN_ABC_BITCOIND is set.
 */

const assert = require('bsert');
const hash160 = require('bcrypto/lib/hash160');
const secp256k1 = require('bcrypto/lib/secp256k1');
const FullNode = require('../lib/node/fullnode');
const KeyRing = require('../lib/primitives/keyring');
const Outpoint = require('../lib/primitives/outpoint');
const Script = require('../lib/script/script');
const util = require('../lib/utils/util');
const Proof = require('../lib/avalanche/proof');
const Processor = require('../lib/avalanche/processor');
const {Stake} = require('../lib/avalanche/stake');
const ABCRegtest = require('./util/abc-regtest');

// Satoshis; regtest coinbases are below the mainnet threshold.
const DUST_THRESHOLD = 1000000;

// ABC's regtest keys use testnet's prefix; bcash's regtest has bcoin's.
const wif = key => KeyRing.fromPrivate(key).toSecret('testnet');
const pub = key => secp256k1.publicKeyCreate(key, true);

async function until(test, ms = 30000) {
  const start = Date.now();
  while (!await test()) {
    if (Date.now() - start > ms)
      throw new Error('Timed out.');
    await new Promise(r => setTimeout(r, 100));
  }
}

const available = ABCRegtest.available();
const suite = available ? describe : describe.skip;
const title = 'Avalanche network against Bitcoin ABC regtest'
  + (available ? '' : ' (skipped: BITCOIN_ABC_BITCOIND is not set)');

suite(title, function() {
  this.timeout(120000);

  const abc = available ? new ABCRegtest([
    `-avaproofstakeutxodustthreshold=${DUST_THRESHOLD}`,
    '-avaproofstakeutxoconfirmations=1'
  ], {p2p: true}) : null;

  const masterKey = secp256k1.privateKeyGenerate();
  const stakeKey = secp256k1.privateKeyGenerate();

  let node = null;
  let proof = null;

  before(async () => {
    await abc.open();

    const desc = `pkh(${pub(stakeKey).toString('hex')})`;
    const {descriptor} = await abc.call('getdescriptorinfo', desc);
    const hashes = await abc.call('generatetodescriptor', 10, descriptor);

    const stakes = [];
    for (const hash of hashes.slice(0, 2)) {
      const block = await abc.call('getblock', hash, 2);
      const tx = block.tx[0];
      const stake = new Stake({
        outpoint: new Outpoint(util.fromRev(tx.txid), 0),
        amount: Math.round(tx.vout[0].value * 100),
        height: block.height,
        coinbase: true,
        pubkey: pub(stakeKey)
      });
      stakes.push({stake, key: stakeKey});
    }

    proof = Proof.build({
      sequence: 1n,
      expiration: 0n,
      masterKey,
      payout: Script.fromPubkeyhash(hash160.digest(pub(masterKey))),
      stakes
    });

    // ABC stakes the proof bcash built.
    await abc.restart([
      `-avaproof=${proof.toHex()}`,
      `-avamasterkey=${wif(masterKey)}`
    ]);

    // Its proof registers at a new tip.
    await abc.call('generatetodescriptor', 1, descriptor);

    node = new FullNode({
      network: 'regtest',
      memory: true,
      workers: false,
      listen: false,
      only: [abc.p2pHost],
      avalanche: true,
      avaproofStakeUtxoDustThreshold: DUST_THRESHOLD,
      avaproofStakeUtxoConfirmations: 1
    });

    await node.open();
    await node.connect();
    node.startSync();
  });

  after(async () => {
    if (node) {
      await node.disconnect();
      await node.close();
    }
    await abc.close();
  });

  it('should sync from it', async () => {
    const {blocks} = await abc.call('getblockchaininfo');
    await until(() => node.chain.height === blocks);
    await until(() => node.chain.synced);
  });

  it('should register its proof, with it as the proof\'s node', async () => {
    const processor = node.pool.avalanche;
    const pm = processor.peerManager;

    // Its hello came before bcash had the blocks (bcash counts a regtest
    // chain as synced at genesis), so the coins were missing and the
    // proof was dropped, as ABC drops it. ABC's periodic requests for
    // proofs bring it back.

    // ABC shares its own proof once it is registered: at a new tip, with
    // a node connected...
    const {descriptor} = await abc.call('getdescriptorinfo',
      `pkh(${pub(stakeKey).toString('hex')})`);
    await abc.call('generatetodescriptor', 1, descriptor);
    await until(async () => {
      const info = await abc.call('getavalancheinfo');
      return info.local.verified;
    });

    // ...and answers getavaproofs once a minute.
    let time = Math.floor(Date.now() / 1000);
    const nextMinute = async () => {
      time += Processor.GETAVAPROOFS_INTERVAL + 1;
      await abc.call('setmocktime', time);
      processor.periodicNetworking();
    };

    await nextMinute();
    await until(() => pm.isBoundToPeer(proof.id()) && pm.getNodeCount() === 1);

    assert(pm.verify());
    assert.strictEqual(pm.getTotalPeersScore(), proof.getScore());
    assert.strictEqual(pm.getConnectedPeersScore(), proof.getScore());

    // Its hello verified: it is a node, and was not banned.
    const [state] = processor.peers.values();
    assert(state.pubkey);
    assert.strictEqual(state.peer.banScore, 0);

    // Proofs from a node count once it is bound to a proof, as in ABC.
    assert.strictEqual(processor.avaproofsNodeCounter, 0);
    await nextMinute();
    await until(() => processor.avaproofsNodeCounter === 1);
  });

  it('should report it as ABC\'s RPC does', async () => {
    const rpc = async (method, params = []) => {
      const json = await node.rpc.call({method, params}, {});
      if (json.error)
        throw new Error(`${method}: ${json.error.message}`);
      return json.result;
    };

    const info = await rpc('getavalancheinfo');
    // Quorum needs 8 nodes.
    assert.strictEqual(info.ready_to_poll, false);
    assert.strictEqual(info.network.proof_count, 1);
    assert.strictEqual(info.network.connected_proof_count, 1);
    assert.strictEqual(info.network.connected_node_count, 1);
    assert.strictEqual(info.network.total_stake_amount,
      proof.getStakedAmount() / 100);

    // Matches what ABC says of its own proof.
    const abcInfo = await abc.call('getavalancheinfo');
    assert.strictEqual(info.network.total_stake_amount,
      abcInfo.local.stake_amount);

    const [peer] = await rpc('getavalanchepeerinfo', [proof.rid()]);
    assert.strictEqual(peer.proof, proof.toHex());
    assert.strictEqual(peer.nodecount, 1);
  });

  it('should still be connected to it', async () => {
    const peers = await abc.call('getpeerinfo');
    assert.strictEqual(peers.length, 1);
    assert.strictEqual(node.pool.peers.size(), 1);
  });
});
