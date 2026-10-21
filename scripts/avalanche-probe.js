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
const bio = require('bufio');
const hash256 = require('bcrypto/lib/hash256');
const Network = require('../lib/protocol/network');
const Peer = require('../lib/net/peer');
const NetAddress = require('../lib/net/netaddress');
const packets = require('../lib/net/packets');

const NODE_AVALANCHE = 1 << 24;
const MSG_BLOCK = 2;
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

function readPubkey(br) {
  return br.readBytes(br.readVarint());
}

function readStake(br) {
  const start = br.offset;
  const txid = br.readHash('hex');
  const index = br.readU32();
  const amount = br.readI64();
  const height = br.readU32();
  readPubkey(br);
  const raw = br.data.slice(start, br.offset);
  const sig = br.readBytes(64);
  return {txid, index, amount, height: height >>> 1,
    coinbase: Boolean(height & 1), raw, sig};
}

// Proof: sequence, expiration, master, stakes, payout script, signature.
// ProofId = H(LimitedProofId, master); LimitedProofId = H(sequence,
// expiration, payout script, stakes).
function readProof(br) {
  // Sequence numbers and keys are full 64-bit values: keep them as bytes.
  const sequence = br.readBytes(8);
  const expiration = br.readI64();
  const master = readPubkey(br);
  const count = br.readVarint();
  const stakes = [];
  for (let i = 0; i < count; i++)
    stakes.push(readStake(br));
  const payout = br.readVarBytes();
  br.readBytes(64);

  const bw = bio.write(16 + 9 + payout.length + 9
    + stakes.reduce((n, s) => n + s.raw.length, 0));
  bw.writeBytes(sequence);
  bw.writeI64(expiration);
  bw.writeVarBytes(payout);
  bw.writeVarint(stakes.length);
  for (const s of stakes)
    bw.writeBytes(s.raw);
  const limited = hash256.digest(bw.slice());
  const proofid = hash256.digest(Buffer.concat([
    limited, Buffer.from([master.length]), master]));

  const amount = stakes.reduce((n, s) => n + s.amount, 0);
  return {proofid: Buffer.from(proofid).reverse().toString('hex'),
    sequence: sequence.toString('hex'), expiration, stakes: stakes.length,
    amount};
}

// Delegation: limited proof id, proof master, levels (pubkey, sig).
function readDelegation(br) {
  const limited = br.readBytes(32);
  const master = readPubkey(br);
  const levels = br.readVarint();
  for (let i = 0; i < levels; i++) {
    readPubkey(br);
    br.readBytes(64);
  }
  const zero = limited.equals(Buffer.alloc(32));
  let proofid = null;
  if (!zero) {
    const id = hash256.digest(Buffer.concat([
      limited, Buffer.from([master.length]), master]));
    proofid = Buffer.from(id).reverse().toString('hex');
  }
  return {hasProof: !zero, proofid, levels};
}

// Our hello: an all-zero delegation (no proof), which makes the receiver
// skip the signature; a zero signature and our max poll size follow, as
// in ABC's Hello.
function helloPayload() {
  const bw = bio.write(32 + 1 + 1 + 64 + 4);
  bw.writeBytes(Buffer.alloc(32));
  bw.writeVarint(0);
  bw.writeVarint(0);
  bw.writeBytes(Buffer.alloc(64));
  bw.writeU32(1024);
  return bw.render();
}

function readCompactProofs(data) {
  const br = bio.read(data);
  br.seek(16); // two SipHash keys
  const shortids = br.readVarint();
  br.seek(shortids * 6);
  const prefilled = [];
  const n = br.readVarint();
  for (let i = 0; i < n; i++) {
    br.readVarint();
    prefilled.push(readProof(br));
  }
  return {count: shortids + n, prefilled};
}

// Ask for indices 0..n-1, difference encoded: each is 0 after the last.
function proofsRequest(n) {
  const bw = bio.write(9 + n * 9);
  bw.writeVarint(n);
  for (let i = 0; i < n; i++)
    bw.writeVarint(0);
  return bw.slice();
}

function pollPayload(round, hashes) {
  const bw = bio.write(8 + 9 + hashes.length * 36);
  bw.writeU64(round);
  bw.writeVarint(hashes.length);
  for (const h of hashes) {
    bw.writeU32(MSG_BLOCK);
    bw.writeBytes(h);
  }
  return bw.slice();
}

function readResponse(data) {
  const br = bio.read(data);
  const round = br.readBytes(8).toString('hex');
  const cooldown = br.readU32();
  const votes = [];
  const n = br.readVarint();
  for (let i = 0; i < n; i++)
    votes.push({error: br.readU32(), hash: br.readHash('hex')});
  return {round, cooldown, votes};
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
function createPeer() {
  const peer = Peer.fromOptions({
    network,
    agent: '/bcash-avalanche-probe:0.0.1/',
    hasNonce: () => false,
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
  const peer = createPeer();

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

  peer.send(new packets.UnknownPacket('avahello', helloPayload()));

  const theirs = await hello;
  if (theirs) {
    try {
      result.delegation = readDelegation(bio.read(theirs));
    } catch (e) {
      result.delegationError = e.message;
    }
  }
  result.avalanche = Boolean(theirs);

  if (result.avalanche) {
    // Quorum: genesis is active on every node, so a node with quorum
    // answers 0; one without answers -1.
    const genesis = Buffer.from(network.genesis.hash);
    const resp = waitFor(peer, payloadOf('avaresponse'));
    peer.send(new packets.UnknownPacket('avapoll', pollPayload(1, [genesis])));
    const raw = await resp;
    if (raw) {
      const r = readResponse(raw);
      const v = r.votes[0] ? r.votes[0].error : null;
      result.genesisVote = v === VOTE_UNKNOWN ? -1 : v;
      result.quorum = v === 0;
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
    peer.send(new packets.UnknownPacket('avahello', helloPayload()));

    const compact = waitFor(peer, payloadOf('avaproofs'));
    peer.send(new packets.UnknownPacket('getavaproofs', Buffer.alloc(0)));
    const raw = await compact;
    if (!raw)
      return {host, error: 'no avaproofs'};

    const cp = readCompactProofs(raw);
    for (const p of cp.prefilled)
      proofs.set(p.proofid, p);

    let last = Date.now();
    peer.on('packet', (p) => {
      if (p.cmd !== 'avaproof')
        return;
      try {
        const proof = readProof(bio.read(p.data));
        proofs.set(proof.proofid, proof);
        last = Date.now();
      } catch (e) {
        // Count it but keep going.
      }
    });
    const request = proofsRequest(cp.count);
    peer.send(new packets.UnknownPacket('avaproofsreq', request));

    // Proofs stream in; stop once we have them all or they stop coming.
    while (proofs.size < cp.count && Date.now() - last < 15000)
      await new Promise(r => setTimeout(r, 500));

    return {host, announced: cp.count, proofs: [...proofs.values()]};
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
      totalStakeXEC: stake / 100,
      quorumThresholdXEC: 10e9
    },
    perNode: all.map(r => ({host: r.host, reached: r.reached, agent: r.agent,
      height: r.height, avalanche: r.avalanche,
      ownProof: r.delegation ? r.delegation.hasProof : undefined,
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
