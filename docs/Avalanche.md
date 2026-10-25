# Avalanche

eCash uses **Avalanche** on top of proof of work. Nodes holding staked coins
("stakers") vote on blocks and transactions, and once enough stake agrees, the
result is final:

- A **finalized block** can't be reorganized away.
- A **finalized transaction** is as good as mined, usually within seconds.
- Votes also choose each block's **staking reward winner**, and let nodes
  **park** (refuse to build on) blocks that break eCash's policies.

bcash speaks Avalanche the way Bitcoin ABC does. The port follows Bitcoin ABC
v0.34.2. The few places where bcash behaves differently are listed in
[Where bcash differs from Bitcoin ABC](#where-bcash-differs-from-bitcoin-abc).

## Turning it on

Avalanche is off by default. Start bcash with `--avalanche` to turn it on:

```
bcash --avalanche
```

Without it, bcash behaves exactly as it did before Avalanche.

## What a node does

| | Full node | SPV node |
|---|---|---|
| Finalizes blocks by polling stakers | yes | yes |
| Parks blocks that break a policy (real time targeting, miner fund, staking reward, pre-consensus) | yes | no |
| Learns each block's staking reward winner | yes | yes |
| Finalizes transactions before they're mined (pre-consensus) | its mempool | only its own transactions |
| Answers other nodes' polls | yes | no |
| Stakes a proof of its own | yes, with `--ava-proof` | no |

A full node checks a staker's coins against its own UTXO set. An SPV node has
no UTXO set, so it fetches each stake's transaction as a merkle block and
checks it there. For stakes older than the SPV node's chain, it first walks
the headers back from the nearest checkpoint.

## Running a staking node

A staking node votes with your stake and earns staking rewards. You need:

- coins to stake (at least 100,000,000 XEC per stake on mainnet), with 2,016
  confirmations;
- a node that accepts **inbound** connections. Other nodes only learn your
  proof from a node that has connected in to you, so a node behind a firewall
  with no open port can't stake.

The steps:

1. **Build a proof** of your stake with the `buildavalancheproof` RPC. This
   signs it with the proof's *master key*.
2. **Optionally delegate it**, with `delegateavalancheproof`, so the node holds
   a delegated key instead of the master key. Keep the master key somewhere
   safer.
3. **Give the node the proof and its key**, in `bcash.conf` rather than on the
   command line, so they don't show up in the process list:

   ```
   avalanche: true
   listen: true
   ava-proof: <proof, hex>
   ava-master-key: <the master key, or the delegated key, WIF>
   ava-delegation: <delegation, hex, if you made one>
   ```

4. **Check it** with `getavalancheinfo`. Its `local` section shows the state
   of your own proof.

A staking node can't run through a proxy. Like Bitcoin ABC, it advertises
`NODE_AVALANCHE` and shares its proof only once another node has connected
in to it.

## Options

Every option works as `--flag=value` on the command line, as `flag: value` in
`bcash.conf`, or as `BCASH_FLAG` in the environment.

### Avalanche

| Option | Default | What it does |
|---|---|---|
| `avalanche` | false | Turns Avalanche on. |
| `max-avalanche-outbound` | 150 | Outbound connections to Avalanche nodes, on top of the usual ones. An SPV node cuts back to 17 once it has enough stake connected (see below). |
| `ava-cooldown` | 100 | Milliseconds a peer must wait between polls to us (Bitcoin ABC's `-avacooldown`). |
| `ava-min-quorum-stake` | 10,000,000,000 XEC | Total stake the node must know about before it starts polling. Given in satoshis. |
| `ava-min-quorum-connected-stake-ratio` | 0.8 | Share of that stake the node must be connected to. |
| `ava-min-quorum-unanimous-stake-ratio` | 0.5 on SPV, otherwise the same as above | Share of the stake at which a unanimous vote counts as final. bcash only; see below. |
| `ava-min-avaproofs-node-count` | 8 | Nodes that must have sent us their proofs. |
| `avalanche-conflicting-proof-cooldown` | 60 | Seconds before a conflicting proof may replace an existing one. |
| `avaproof-stake-utxo-confirmations` | 2016 | Confirmations a stake's coin needs. |
| `avaproof-stake-utxo-dust-threshold` | 100,000,000 XEC | Smallest allowed stake, in satoshis. Change it only on test chains. |
| `persist-avapeers` | true | Saves Avalanche peers to `avapeers.dat` on shutdown and loads them on startup (Bitcoin ABC's `-persistavapeers`). |

### Policies and pre-consensus (full nodes)

| Option | Default | What it does |
|---|---|---|
| `enable-miner-fund` | depends on the network | Parks blocks that don't pay the miner fund. |
| `avalanche-staking-rewards` | depends on the network | Parks blocks that don't pay the staking reward winner. |
| `avalanche-staking-preconsensus` | true | Polls stakers on each block's staking reward winner. |
| `avalanche-preconsensus` | true | Polls stakers on mempool transactions, and refuses transactions that conflict with a finalized one. |
| `avalanche-preconsensus-mining` | true | Once pre-consensus is active, mines only finalized transactions. |
| `enable-rtt` | true | Real time targeting: parks blocks that were mined too fast. |
| `persist-recent-headers-time` | false | Saves when recent blocks arrived (`headerstime.dat`), so real time targeting carries over a restart. |

### Staking (full nodes)

| Option | What it is |
|---|---|
| `ava-proof` | Our proof, in hex. |
| `ava-master-key` | The proof's master key, as a WIF. With a delegation, the delegated key instead. |
| `ava-delegation` | A delegation of the proof, in hex, if the master key is kept elsewhere. |
| `ava-session-key` | The key our hellos and votes are signed with, as a WIF. Random if not given. |

## RPCs

Arguments and results match Bitcoin ABC's. Proofs and delegations decode the
same in bcash and Bitcoin ABC, whichever one built them.

**Status**

| RPC | Returns |
|---|---|
| `getavalancheinfo` | Quorum status, the network's stake, and our own proof's state (`local`). |
| `getavalanchepeerinfo ( "proofid" )` | Stakers and their nodes. |
| `getavalanchekey` | Our session public key. |

**Proofs and delegations**

| RPC | Does |
|---|---|
| `buildavalancheproof sequence expiration "master" [stakes] "payoutAddress"` | Builds and signs a proof. |
| `decodeavalancheproof "proof"` | Shows a proof's fields. |
| `verifyavalancheproof "proof"` | Checks a proof, including its coins. |
| `sendavalancheproof "proof"` | Registers a proof and relays it. |
| `delegateavalancheproof "limitedproofid" "privatekey" "publickey" ( "delegation" )` | Delegates a proof, or an existing delegation, to another key. |
| `decodeavalanchedelegation "delegation"` | Shows a delegation's fields. |
| `verifyavalanchedelegation "delegation"` | Checks a delegation's signatures. |

**Blocks**

| RPC | Does |
|---|---|
| `isfinalblock "blockhash"` | Says whether a block is finalized. |
| `parkblock "blockhash"`, `unparkblock "blockhash"` | Parks a block by hand, or unparks it. |
| `getstakingreward "blockhash"` | Shows the staking reward winners for the block after this one. |

**Transactions**

| RPC | Does |
|---|---|
| `isfinaltransaction "txid"` | Says whether a transaction is finalized. |
| `getfinaltransactions` | Lists the mempool's finalized transactions. |
| `finalizetransaction "txid"`, `removetransaction "txid"` | Finalizes, or removes, a mempool transaction by hand. |

## SPV clients: finality for your own transactions

An SPV client can learn when its own transactions are finalized. Watch the
transaction before broadcasting it, then listen for the outcome:

```js
await pool.avalanche.watchTransaction(tx);
await pool.broadcast(tx);

pool.on('tx final', tx => {});    // finalized: as good as mined
pool.on('tx rejected', tx => {}); // voted down for now; it may come back
pool.on('tx invalid', tx => {});  // finalized as invalid
pool.on('tx stale', tx => {});    // no decision yet: announced and polled again

pool.avalanche.getTransactionStatus(tx.hash());
// 'final', 'rejected', 'invalid', 'pending' or 'unknown'
```

On mainnet, once the client is connected to its Avalanche nodes, a
transaction it broadcasts is final in about 7 to 10 seconds. About 3 seconds
of that is the transaction reaching other nodes' mempools, and 4 to 5 seconds
is the voting.

## Where bcash differs from Bitcoin ABC

Most differences are for SPV nodes. An SPV node doesn't accept inbound
connections, so it reaches fewer stakers than a full node does.

- **Unanimous votes count early on SPV.** An SPV node may never connect to
  80% of the stake. So when it's connected to at least 50%
  (`ava-min-quorum-unanimous-stake-ratio`), it treats a vote as final if every
  staker it can hear voted the same way. If any staker disagrees, it waits
  for the usual 80%.
- **SPV nodes don't waste polls.** Bitcoin ABC ignores a node's vote on an
  item if that node was one of the item's last 7 voters. With only a few
  nodes, most votes would be thrown away. An SPV node therefore polls only
  nodes whose vote will count, chosen by stake.
- **SPV nodes keep few Avalanche connections.** An SPV node takes up other
  nodes' connection slots and serves nothing back. Once its connections hold
  enough stake, it keeps 17 (more wouldn't make polling faster) and closes
  the rest, without dialing them again.
- **Avalanche node addresses are kept separately.** bcash keeps the addresses
  of Avalanche nodes apart from its main address list, along with how many
  peers listed each one, and dials the most-listed first. Otherwise ordinary
  address messages, which arrive early, could fill the list before a peer's
  answer to `getavaaddr` came in.
- **Stakes are checked a proof at a time.** An SPV node fetches all of a
  proof's stakes in one scan. It checks first the proofs of nodes that are
  waiting on them.

## Files

These live in the network's data directory, as in Bitcoin ABC:

| File | Holds |
|---|---|
| `avapeers.dat` | Avalanche peers, kept between runs, in Bitcoin ABC's format. |
| `headerstime.dat` | When recent blocks arrived, if `persist-recent-headers-time` is on. |

## Testing against Bitcoin ABC

Some tests run a Bitcoin ABC regtest node alongside bcash. They run only when
`BITCOIN_ABC_BITCOIND` points to ABC's `bitcoind`, and are skipped otherwise:

```
BITCOIN_ABC_BITCOIND=~/bitcoin-abc/build/src/bitcoind npx bmocha test/avalanche-abc-*.js
```

In one of them, eight bcash nodes stake proofs and a Bitcoin ABC node
finalizes blocks on their votes alone.
