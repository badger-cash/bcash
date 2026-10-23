/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * bcash as a participant: eight bcash full nodes stake one proof, and a
 * Bitcoin ABC regtest node polls them. ABC's only voters are bcash's, so
 * when ABC finalizes a block, bcash's hellos, proof, and signed votes
 * were all taken. Runs only when BITCOIN_ABC_BITCOIND is set.
 */

const assert = require('bsert');
const random = require('bcrypto/lib/random');
const secp256k1 = require('bcrypto/lib/secp256k1');
const hash160 = require('bcrypto/lib/hash160');
const FullNode = require('../lib/node/fullnode');
const KeyRing = require('../lib/primitives/keyring');
const Outpoint = require('../lib/primitives/outpoint');
const Script = require('../lib/script/script');
const Proof = require('../lib/avalanche/proof');
const {Stake} = require('../lib/avalanche/stake');
const util = require('../lib/utils/util');
const ABCRegtest = require('./util/abc-regtest');

const {until} = ABCRegtest;

// Satoshis; regtest coinbases are below the mainnet threshold.
const DUST_THRESHOLD = 1000000;
const NODES = 8;

const available = ABCRegtest.available();
const suite = available ? describe : describe.skip;
const title = 'Avalanche participants against Bitcoin ABC regtest'
  + (available ? '' : ' (skipped: BITCOIN_ABC_BITCOIND is not set)');

suite(title, function() {
  this.timeout(300000);

  const abc = available ? new ABCRegtest([
    `-avaproofstakeutxodustthreshold=${DUST_THRESHOLD}`,
    '-avaproofstakeutxoconfirmations=1',
    '-avaminquorumstake=0',
    '-avaminavaproofsnodecount=0',
    '-whitelist=noban@127.0.0.1'
  ], {p2p: true}) : null;

  const nodes = [];
  const opened = [];
  let descriptor = null;
  let abcProof = null;

  const pub = key => secp256k1.publicKeyCreate(key, true);
  const wif = key => KeyRing.fromPrivate(key).toSecret('regtest');

  // A proof of two of ABC's coinbases, paid to a bcash stake key.
  async function bcashProof() {
    const masterKey = secp256k1.privateKeyGenerate();
    const stakeKey = secp256k1.privateKeyGenerate();
    const desc = `pkh(${pub(stakeKey).toString('hex')})`;
    const info = await abc.call('getdescriptorinfo', desc);
    const hashes = await abc.call('generatetodescriptor', 2, info.descriptor);

    const stakes = [];
    for (const hash of hashes) {
      const block = await abc.call('getblock', hash, 2);
      const tx = block.tx[0];
      stakes.push({
        stake: new Stake({
          outpoint: new Outpoint(util.fromRev(tx.txid), 0),
          amount: Math.round(tx.vout[0].value * 100),
          height: block.height,
          coinbase: true,
          pubkey: pub(stakeKey)
        }),
        key: stakeKey
      });
    }

    const proof = Proof.build({
      sequence: 1n,
      expiration: 0n,
      masterKey,
      payout: Script.fromPubkeyhash(hash160.digest(pub(masterKey))),
      stakes
    });

    return {proof, masterKey};
  }

  before(async () => {
    await abc.open();
    ({descriptor, proof: abcProof} = await abc.stake());

    const {proof, masterKey} = await bcashProof();
    await abc.call('generatetodescriptor', 1, descriptor);

    // Below the ports the ABC harness picks (20000 to 40001) and the
    // ephemeral ports outgoing connections take (32768 up, on Linux).
    const base = 10000 + (random.randomInt() % 9000);
    const hosts = [];
    for (let i = 0; i < NODES; i++)
      hosts.push(`127.0.0.1:${base + i}`);

    // Each stakes the same proof, with its own session key, and connects
    // to ABC and to every other.
    for (let i = 0; i < NODES; i++) {
      const node = new FullNode({
        network: 'regtest',
        memory: true,
        workers: false,
        listen: true,
        host: '127.0.0.1',
        port: base + i,
        httpPort: base + NODES + i,
        only: [abc.p2pHost, ...hosts.filter((_, j) => j !== i)],
        maxOutbound: NODES,
        avalanche: true,
        avaproofStakeUtxoDustThreshold: DUST_THRESHOLD,
        avaproofStakeUtxoConfirmations: 1,
        avaMinQuorumStake: 0,
        avaMinAvaproofsNodeCount: 0,
        avaProof: proof.toHex(),
        avaMasterKey: wif(masterKey)
      });
      nodes.push(node);
    }

    for (const node of nodes) {
      await node.open();
      opened.push(node);
    }
    for (const node of nodes) {
      await node.connect();
      node.startSync();
    }

    // ABC dials each: a node connected in, so each may share its proof.
    for (const host of hosts)
      await abc.call('addnode', host, 'onetry');

    const {blocks} = await abc.call('getblockchaininfo');
    await until(() => nodes.every(n => n.chain.height === blocks), 60000);

    // bcash's regtest counts as synced from genesis, so ABC's hello came
    // before its coins, and its proof was dropped; each would fetch it in
    // 2 to 5 minutes. Hand it to each, as an operator can.
    for (const node of nodes) {
      const json = await node.rpc.call({method: 'sendavalancheproof',
        params: [abcProof.toHex()]}, {});
      assert.strictEqual(json.error, null);
    }
  });

  after(async () => {
    for (const node of opened) {
      await node.disconnect();
      await node.close();
    }
    await abc.close();
  });

  it('should have each share and register its proof', async () => {
    // A new tip: each registers its proof, now that it may share it.
    await abc.call('generatetodescriptor', 1, descriptor);

    await until(() => nodes.every((n) => {
      const ava = n.pool.avalanche;
      return ava.canShareProof && ava.getLocalProofState().verified;
    }), 60000);
  });

  it('should have Bitcoin ABC take the proof, with the nodes', async () => {
    const proofid = nodes[0].pool.avalanche.getLocalProof().rid();

    await until(async () => {
      const peers = await abc.call('getavalanchepeerinfo', proofid);
      return peers.length === 1 && peers[0].nodecount >= NODES;
    }, 120000);
  });

  it('should have Bitcoin ABC finalize a block on bcash\'s votes',
    async () => {
      await until(async () => {
        const info = await abc.call('getavalancheinfo');
        return info.ready_to_poll;
      }, 120000);

      try {
        await until(() => nodes.every(n => n.pool.avalanche
          .isQuorumEstablished()), 120000);
      } catch (e) {
        // What each saw, to tell why.
        for (const n of nodes) {
          const ava = n.pool.avalanche;
          const pm = ava.peerManager;
          console.log(JSON.stringify({
            quorum: ava.isQuorumEstablished(),
            peers: n.pool.peers.size(),
            nodes: pm.getNodeCount(),
            pending: pm.getPendingNodeCount(),
            proofs: pm.peers.size,
            avaproofs: ava.avaproofsNodeCounter,
            connected: pm.getConnectedPeersScore(),
            total: pm.getTotalPeersScore(),
            synced: n.chain.synced,
            canShare: ava.canShareProof
          }));
        }
        throw e;
      }

      const [hash] = await abc.call('generatetodescriptor', 1, descriptor);

      await until(() => abc.call('isfinalblock', hash), 120000);
      assert(await abc.call('isfinalblock', hash));
    });
});
