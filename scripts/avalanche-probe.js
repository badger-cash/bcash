#!/usr/bin/env node

'use strict';

/*
 * Survey the Avalanche network a bcash node would join, using only Bitcoin
 * ABC's P2P messages and bcash's own Peer. For each node reached it:
 *   - exchanges avahello (ours carries no proof) and reads whether the node
 *     has a stake proof;
 *   - downloads every proof it knows (getavaproofs, avaproofsreq, avaproof)
 *     and sums their stakes;
 *   - asks for Avalanche peer addresses (getavaaddr);
 *   - polls the genesis block: 0 means the node has quorum, -1 that it has
 *     not (ABC answers -1 to every poll until its quorum is established).
 *
 * Usage: node scripts/avalanche-probe.js <main|testnet> [host:port ...]
 *        [--visit=N] [--out=file.json]
 */

const dns = require('dns').promises;
const fs = require('fs');
const Network = require('../lib/protocol/network');
const Peer = require('../lib/net/peer');
const NetAddress = require('../lib/net/netaddress');
const packets = require('../lib/net/packets');
const util = require('../lib/utils/util');
const Proof = require('../lib/avalanche/proof');
const random = require('bcrypto/lib/random');
const InvItem = require('../lib/primitives/invitem');
const {Hello, Poll, Response, invTypes} = require('../lib/avalanche/protocol');
const {
  CompactProofs,
  ProofsRequest
} = require('../lib/avalanche/compactproofs');

const NODE_AVALANCHE = 1 << 24;
const VOTE_UNKNOWN = 0xffffffff;
const TIMEOUT = 30000;

const args = process.argv.slice(2);
const opt = (name, def) => {
  const a = args.find(x => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : def;
};
const networkName = args[0];
const network = Network.get(networkName);
const startHosts = args.slice(1).filter(a => !a.startsWith('--'));
const visitLimit = Number(opt('visit', 40));
const outFile = opt('out', null);

/*
 * Wire formats (Bitcoin ABC src/avalanche/*.h, src/serialize.h).
 */

// A proof, checked as far as it can be without the chain.
function summarizeProof(proof) {
  const [valid, reason] = proof.verify();
  return {proofid: proof.rid(), sequence: proof.sequence.toString(16),
    expiration: Number(proof.expiration), stakes: proof.stakes.length,
    amount: proof.getStakedAmount(), valid, reason};
}

// A node's hello: its delegation, and the signature that binds it to
// this connection. We send no extra entropy, which ABC reads as 1.
function readHello(data, version, ourNonce) {
  const hello = Hello.fromRaw(data);
  const dg = hello.delegation;
  if (!hello.hasProof())
    return {hello, hasProof: false, proofid: null, levels: dg.levels.length};
  const entropy = version && version.extraEntropy != null
    ? version.extraEntropy : 1n;
  const [valid, reason] = hello.verify(version.nonce, ourNonce, entropy, 1n);
  return {hello, hasProof: true, proofid: util.revHex(dg.proofId()),
    levels: dg.levels.length, valid, reason};
}

/*
 * One node.
 */

// Resolve with test(packet) for the first packet it accepts, or null.
function waitFor(peer, test, ms = TIMEOUT) {
  return new Promise((resolve) => {
    let timer = null;
    let on = null;
    const done = (v) => {
      clearTimeout(timer);
      peer.removeListener('packet', on);
      resolve(v);
    };
    on = (p) => {
      const v = test(p);
      if (v !== undefined)
        done(v);
    };
    timer = setTimeout(() => done(null), ms);
    peer.on('packet', on);
  });
}

const payloadOf = cmd => p => p.cmd === cmd ? p.data : undefined;

// Staking nodes often run without NODE_NETWORK; Avalanche does not need it.
function createPeer(onNonce = () => {}) {
  const peer = Peer.fromOptions({
    network,
    agent: '/bcash-avalanche-probe:0.0.1/',
    hasNonce: () => false,
    createNonce: () => {
      const nonce = random.randomBytes(8);
      onNonce(nonce);
      return nonce;
    },
    requireNetwork: false
  });
  peer.on('error', () => {});
  return peer;
}

function timeout(ms) {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error('timeout')), ms);
  });
}

async function probe(host) {
  const result = {host, reached: false};
  let ourNonce = null;
  const peer = createPeer((nonce) => {
    ourNonce = nonce;
  });

  let version = null;
  peer.on('packet', (p) => {
    if (p.cmd === 'version')
      version = p;
  });

  // The node sends its avahello right after the handshake.
  const hello = waitFor(peer, payloadOf('avahello'));

  try {
    peer.connect(NetAddress.fromHostname(host, network));
    await Promise.race([peer.open(), timeout(TIMEOUT)]);
  } catch (e) {
    result.error = e.message;
    peer.destroy();
    return result;
  }

  result.reached = true;
  result.agent = peer.agent;
  result.height = peer.height;
  result.services = peer.services;
  result.avalancheService = Boolean(peer.services & NODE_AVALANCHE);

  // Ours has no proof, so the node does not check its signature.
  peer.send(new packets.UnknownPacket('avahello', new Hello().toRaw()));

  const theirs = await hello;
  if (theirs) {
    try {
      result.delegation = readHello(theirs, version, ourNonce);
    } catch (e) {
      result.delegationError = e.message;
    }
  }
  result.avalanche = Boolean(theirs);

  if (result.avalanche) {
    // Quorum: genesis is active on every node, so a node with quorum
    // answers 0; one without answers -1.
    const genesis = Buffer.from(network.genesis.hash);
    const poll = new Poll(1n, [new InvItem(invTypes.BLOCK, genesis)]);
    const resp = waitFor(peer, payloadOf('avaresponse'));
    peer.send(new packets.UnknownPacket('avapoll', poll.toRaw()));
    const raw = await resp;
    if (raw) {
      const r = Response.fromRaw(raw);
      const v = r.votes[0] ? r.votes[0].error : null;
      result.genesisVote = v === VOTE_UNKNOWN ? -1 : v;
      result.quorum = v === 0;
      // Signed by the session key the node's hello delegated to.
      const d = result.delegation;
      if (d && d.hasProof && d.valid) {
        const key = d.hello.delegation.verify()[2];
        result.responseSigned = r.verify(key);
      }
    }

    // Avalanche peers it knows (ABC sends only Avalanche-enabled ones).
    const addrs = waitFor(peer, p => p.cmd === 'addr' ? p.items : undefined);
    peer.send(new packets.UnknownPacket('getavaaddr', Buffer.alloc(0)));
    const items = (await addrs) || [];
    result.avaAddrs = items.map(a => a.hostname);
  }

  peer.destroy();
  return result;
}

// Download every proof one node knows.
async function fetchProofs(host) {
  const peer = createPeer();
  const proofs = new Map();
  try {
    peer.connect(NetAddress.fromHostname(host, network));
    await peer.open();
    peer.send(new packets.UnknownPacket('avahello', new Hello().toRaw()));

    const compact = waitFor(peer, payloadOf('avaproofs'));
    peer.send(new packets.UnknownPacket('getavaproofs', Buffer.alloc(0)));
    const raw = await compact;
    if (!raw)
      return {host, error: 'no avaproofs'};

    const cp = CompactProofs.fromRaw(raw);
    const sids = new Set(cp.shortIds);
    const count = cp.size;

    // A proof the node sends us should be one it announced.
    const add = (proof) => {
      const summary = summarizeProof(proof);
      summary.announced = sids.has(cp.sid(proof.id()));
      proofs.set(summary.proofid, summary);
    };

    for (const {proof} of cp.prefilled)
      add(proof);

    let last = Date.now();
    peer.on('packet', (p) => {
      if (p.cmd !== 'avaproof')
        return;
      try {
        add(Proof.fromRaw(p.data));
        last = Date.now();
      } catch (e) {
        // Count it but keep going.
      }
    });
    const all = [...Array(count).keys()];
    const request = new ProofsRequest(all).toRaw();
    peer.send(new packets.UnknownPacket('avaproofsreq', request));

    // Proofs stream in; stop once we have them all or they stop coming.
    while (proofs.size < count && Date.now() - last < 15000)
      await new Promise(r => setTimeout(r, 500));

    return {host, announced: count, proofs: [...proofs.values()]};
  } catch (e) {
    return {host, error: e.message};
  } finally {
    peer.destroy();
  }
}

async function seeds() {
  const hosts = [];
  for (const seed of network.seeds) {
    try {
      const ips = await dns.resolve4(seed);
      for (const ip of ips)
        hosts.push(`${ip}:${network.port}`);
    } catch (e) {
      // Unreachable seeder.
    }
  }
  return hosts;
}

async function pool(items, size, fn) {
  const out = [];
  let i = 0;
  const workers = Array.from({length: size}, async () => {
    while (i < items.length) {
      const item = items[i++];
      out.push(await fn(item));
    }
  });
  await Promise.all(workers);
  return out;
}

(async () => {
  const start = startHosts.length ? startHosts : (await seeds()).slice(0, 12);
  console.error(`${networkName}: probing ${start.length} start hosts`);

  // First pass: start hosts. Then follow getavaaddr results.
  const seen = new Set(start);
  const results = await pool(start, 6, probe);
  const queue = [];
  for (const r of results) {
    for (const a of r.avaAddrs || []) {
      if (!seen.has(a)) {
        seen.add(a);
        queue.push(a);
      }
    }
  }
  const second = await pool(queue.slice(0, visitLimit), 8, probe);
  const all = results.concat(second);

  const ava = all.filter(r => r.avalanche);
  const withQuorum = ava.filter(r => r.quorum);
  const withProof = ava.filter(r => r.delegation && r.delegation.hasProof);
  const reached = all.filter(r => r.reached).length;
  console.error(`${networkName}: reached ${reached}/${all.length},`
    + ` avalanche ${ava.length}, with own proof ${withProof.length},`
    + ` with quorum ${withQuorum.length}`);

  // Proofs from up to three Avalanche nodes, merged by proof id.
  const merged = new Map();
  const fetched = [];
  for (const r of ava.slice(0, 3)) {
    const f = await fetchProofs(r.host);
    fetched.push({host: f.host, announced: f.announced,
      received: f.proofs ? f.proofs.length : 0, error: f.error});
    for (const p of f.proofs || [])
      merged.set(p.proofid, p);
  }
  const proofs = [...merged.values()];
  const stake = proofs.reduce((n, p) => n + p.amount, 0);

  const summary = {
    network: networkName,
    at: new Date().toISOString(),
    nodes: {
      contacted: all.length,
      reached: all.filter(r => r.reached).length,
      avalanche: ava.length,
      withOwnProof: withProof.length,
      withQuorum: withQuorum.length,
      knownAvalancheAddrs: seen.size
    },
    proofs: {
      sources: fetched,
      count: proofs.length,
      stakes: proofs.reduce((n, p) => n + p.stakes, 0),
      unannounced: proofs.filter(p => !p.announced).length,
      invalid: proofs.filter(p => !p.valid)
        .map(p => ({proofid: p.proofid, reason: p.reason})),
      totalStakeXEC: stake / 100,
      quorumThresholdXEC: 10e9
    },
    perNode: all.map(r => ({host: r.host, reached: r.reached, agent: r.agent,
      height: r.height, avalanche: r.avalanche,
      ownProof: r.delegation ? r.delegation.hasProof : undefined,
      hello: r.delegation && r.delegation.hasProof
        ? r.delegation.reason : undefined,
      responseSigned: r.responseSigned,
      genesisVote: r.genesisVote,
      avaAddrs: r.avaAddrs ? r.avaAddrs.length : undefined,
      error: r.error}))
  };

  const json = JSON.stringify(summary, null, 2);
  if (outFile)
    fs.writeFileSync(outFile, json);
  console.log(json);
  process.exit(0);
})().catch((e) => {
  console.error(e.stack);
  process.exit(1);
});
