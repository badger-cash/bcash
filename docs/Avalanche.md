# Avalanche

bcash speaks eCash's avalanche protocol, as Bitcoin ABC does: it polls
stakers to finalize blocks, choose staking reward winners and finalize
transactions before they are mined, and, with a stake of its own, answers
others' polls. It is off unless `--avalanche` is given; without it, bcash
behaves as before.

The port follows Bitcoin ABC v0.34.2. Where bcash differs, it says so below.

## What a node does

| | Full node | SPV node |
|---|---|---|
| Finalize blocks by polls | yes | yes |
| Park blocks (RTT, miner fund, staking reward, pre-consensus) | yes | no |
| Staking reward winners, staking pre-consensus | yes | yes |
| Transaction pre-consensus (mempool) | yes | its own transactions |
| Answer polls | yes | no |
| Stake its own proof | yes, with `--ava-proof` | no |

An SPV node checks proofs' stakes by fetching their transactions as
merkleblocks, below its anchor through a walk of the headers.

## Options

All take the `--flag=value` form on the command line, `flag: value` in
`bcash.conf`, or `BCASH_FLAG` in the environment.

### Avalanche

| Option | Default | Meaning |
|---|---|---|
| `avalanche` | false | Speak avalanche. |
| `max-avalanche-outbound` | 150 | Avalanche outbound connections, apart from the others. An SPV node keeps 17 once they hold the connected stake ratio (see below). |
| `ava-cooldown` | 100 | Milliseconds a peer must wait between polls to us (ABC's `-avacooldown`). |
| `ava-min-quorum-stake` | 10,000,000,000 XEC | Stake known before polling (in satoshis). |
| `ava-min-quorum-connected-stake-ratio` | 0.8 | Share of that stake we must have nodes for. |
| `ava-min-quorum-unanimous-stake-ratio` | 0.5 on SPV, else as above | Share for which a unanimous vote is final (bcash only, see below). |
| `ava-min-avaproofs-node-count` | 8 | Nodes that must have sent us their proofs. |
| `avalanche-conflicting-proof-cooldown` | 60 | Seconds before a conflicting proof may replace one. |
| `avaproof-stake-utxo-confirmations` | 2016 | Confirmations a stake's coin needs. |
| `avaproof-stake-utxo-dust-threshold` | 100,000,000 XEC | Least a stake may be (in satoshis); test chains only. |
| `persist-avapeers` | true | Save avalanche peers to `avapeers.dat` at a stop, load them at a start (ABC's `-persistavapeers`). |

### Policies and pre-consensus (full node)

| Option | Default | Meaning |
|---|---|---|
| `enable-miner-fund` | as the network | Park blocks not paying the miner fund. |
| `avalanche-staking-rewards` | as the network | Park blocks not paying the staking reward winner. |
| `avalanche-staking-preconsensus` | true | Poll stake contenders for each block's winner. |
| `avalanche-preconsensus` | true | Poll mempool transactions; refuse what conflicts with a final one. |
| `avalanche-preconsensus-mining` | true | Mine only final transactions once pre-consensus is active. |
| `enable-rtt` | true | Real time targeting: park blocks mined too fast. |
| `persist-recent-headers-time` | false | Keep when the last blocks arrived (`headerstime.dat`), for RTT across restarts. |

### Staking (full node)

| Option | Meaning |
|---|---|
| `ava-proof` | Our proof, hex. |
| `ava-master-key` | The proof's master key, WIF; or, with a delegation, the delegated key. |
| `ava-delegation` | A delegation of the proof, hex, if the master key is kept elsewhere. |
| `ava-session-key` | The key our hellos and votes are signed with, WIF; random if not given. |

A staking node must accept inbound connections (`listen`), and cannot use
a proxy. As in ABC, it says `NODE_AVALANCHE`, and shares its proof only once
a node has connected in to it.

## RPCs

| RPC | |
|---|---|
| `getavalancheinfo` | Quorum, the network's stake, and our own proof's state (`local`). |
| `getavalanchepeerinfo ( "proofid" )` | Stakers and their nodes. |
| `getavalanchekey` | Our session public key. |
| `buildavalancheproof sequence expiration "master" [stakes] "payoutAddress"` | Build and sign a proof. |
| `decodeavalancheproof "proof"` | A proof's fields. |
| `delegateavalancheproof "limitedproofid" "privatekey" "publickey" ( "delegation" )` | Delegate a proof, or a delegation, to a key. |
| `decodeavalanchedelegation "delegation"` | A delegation's fields. |
| `verifyavalancheproof "proof"` | Check a proof, its coins too. |
| `verifyavalanchedelegation "delegation"` | Check a delegation's signatures. |
| `sendavalancheproof "proof"` | Register a proof and relay it. |
| `isfinalblock "blockhash"` | Whether polls finalized a block. |
| `parkblock "blockhash"`, `unparkblock "blockhash"` | Park a block, or undo it. |
| `getstakingreward "blockhash"` | The staking reward winners for the block after one. |
| `isfinaltransaction "txid"` | Whether polls finalized a transaction. |
| `finalizetransaction "txid"`, `removetransaction "txid"` | Finalize, or remove, a mempool transaction by hand. |
| `getfinaltransactions` | The mempool's final transactions. |

Their arguments and results are ABC's: proofs and delegations decode the
same in bcash and ABC, whichever built them.

## SPV: our own transactions

An SPV client polls its own transactions: watch one, and the pool says what
avalanche decided.

```js
await pool.avalanche.watchTransaction(tx);
await pool.broadcast(tx);

pool.on('tx final', tx => {});    // final: as good as mined
pool.on('tx rejected', tx => {}); // voted down; may come back
pool.on('tx invalid', tx => {});  // final, against it
pool.on('tx stale', tx => {});    // no decision: announced and polled again

pool.avalanche.getTransactionStatus(tx.hash());
// 'final', 'rejected', 'invalid', 'pending' or 'unknown'
```

On mainnet, a transaction we broadcast is final in 7 to 10 seconds once the
client has its avalanche nodes: about 3 for it to reach other mempools, and
4 to 5 for the votes.

## Where bcash differs from ABC

- **Unanimous votes on SPV.** An SPV node does not listen, and may never
  have nodes for 80% of the stake. A vote is final for it with nodes for 50%
  (`ava-min-quorum-unanimous-stake-ratio`) if every staker it has a node for
  voted that way and none the other; with any dissent, it waits for 80%.
- **Filter-aware polling on SPV.** ABC drops a node's vote on an item if it
  was one of the item's last 7 voters, so with few nodes most votes are
  wasted. An SPV node polls, by stake, only nodes whose vote would count.
- **Few avalanche connections on SPV.** An SPV node takes slots and serves
  nothing back, so once its nodes hold the connected stake ratio it keeps 17
  (more poll no faster) and closes the rest, not to dial them again.
- **Avalanche nodes kept apart.** Addresses of avalanche nodes, and how many
  peers listed each, are kept apart from the host list, and those most
  listed are dialed first: early addr messages can fill the host list before
  a `getavaaddr` answer comes.
- **Stakes checked per proof.** An SPV node fetches all of a proof's stakes
  in one scan, and checks first the proofs of nodes waiting on theirs.

## Files

In the network's data directory, as ABC:

- `avapeers.dat`: avalanche peers between runs, in ABC's format.
- `headerstime.dat`: when the last blocks arrived, with
  `persist-recent-headers-time`.

## Testing against Bitcoin ABC

Tests that run a Bitcoin ABC regtest node next to bcash run when
`BITCOIN_ABC_BITCOIND` names its `bitcoind`:

```
BITCOIN_ABC_BITCOIND=~/bitcoin-abc/build/src/bitcoind npx bmocha test/avalanche-abc-*.js
```

Among them, eight bcash nodes stake a proof and an ABC node finalizes
blocks on their votes alone.
