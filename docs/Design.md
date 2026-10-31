# Notes on Design
### Applies to: bcash v3.0.0
### Date updated: October 31, 2026

## Authors
The bcoin and bcash contributors

# Table of Contents
[SECTION I: BACKGROUND](#section-i-background)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;[Loose Coupling](#loose-coupling)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;[Event Flow](#event-flow)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;[Full node](#full-node)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;[SPV node](#spv-node)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;[Avalanche](#avalanche)<BR>

[SECTION II: PERFORMANCE](#section-ii-performance)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;[JavaScript](#javascript)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;[Signature Verification](#signature-verification)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;[Worker Processes](#worker-processes)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;[In the Browser](#in-the-browser)<BR>

[Copyright](#copyright)


# SECTION I: BACKGROUND

## Loose Coupling

bcash is a fork of bcoin, and like bcoin it is event driven. The chain, the
mempool, the peer pool, the miner and the wallet database are separate
objects, and each can be used on its own. The full node and SPV node objects
(`lib/node/fullnode.js` and `lib/node/spvnode.js`) only create these objects
and tie them together, mostly by passing events from one to the next.

The loose coupling makes the parts easier to test, and it lets people use
bcash for many purposes besides running a node.

## Event Flow

Some links are events, and some are direct method calls. Both are shown
below, because together they are how data moves through the node.

### Full node

```
pool     -> chain.add(block)    (call)
pool     -> mempool.addTX(tx)   (call)
miner    -> chain.add(block)    (call)

chain    -> connect / disconnect / reorganize / reset -> fullnode -> mempool
chain    -> tip event   -> miner
chain    -> block event -> pool (announce to peers)
mempool  -> tx event    -> fullnode -> miner, node "tx" event
mempool  -> tx event    -> pool (announce to peers)

fullnode -> connect / disconnect / tx / reset -> wallet node client -> walletdb
walletdb -> tx / confirmed / unconfirmed / conflict / balance / address
         -> wallet HTTP server -> websocket clients

chain    -> connect / disconnect / reset -> node HTTP server -> websocket clients
mempool  -> tx event                     -> node HTTP server -> websocket clients
```

### SPV node

An SPV node has no mempool and no miner. Transactions that match its filter
come from the pool instead:

```
pool    -> tx event -> spvnode -> node "tx" event
chain   -> block / connect / disconnect / reorganize / reset -> spvnode
        -> node events of the same names
spvnode -> connect / disconnect / tx / reset -> wallet node client -> walletdb
```

While a rescan is running, the SPV node holds back `tx` and `connect` events
and handles connected blocks itself.

### Avalanche

When the node runs with Avalanche, the pool owns the Avalanche processor and
applies its votes:

```
mempool   -> tx event   -> processor (poll the transaction)
processor -> block vote -> pool -> chain.park / unpark / finalize
chain     -> finalized event (the new finalized tip)
processor -> tx vote    -> pool -> mempool.setAvalancheFinalized
mempool   -> finalized event -> RPC (refresh the block template)
processor -> tx vote    -> pool -> tx final / tx rejected / tx invalid events
```

The pool's `tx final`, `tx rejected` and `tx invalid` events tell an SPV
client what Avalanche decided about a transaction. Nothing inside bcash
listens to them or to the chain's `finalized` event; they are there for
applications. See [Avalanche.md](Avalanche.md) for the rest.

# SECTION II: PERFORMANCE

## JavaScript

JavaScript is dynamic, and dynamic languages are slow to run naively.
Modern JIT compilers such as V8 close most of that gap for well-written code.
The work that stays heavy is cryptography, and bcash leaves that to native
code where it can.

## Signature Verification

bcash gets secp256k1 (ECDSA and Schnorr) from
[bcrypto](https://github.com/bcoin-org/bcrypto). Under Node.js, bcrypto uses
its native addon, which is built with Pieter Wuille's
[libsecp256k1](https://github.com/bitcoin-core/secp256k1), or with
libtorsion if the addon was built without it. Setting the environment
variable `NODE_BACKEND=js` makes bcrypto use its pure JavaScript
implementation instead.

## Worker Processes

JavaScript runs on one thread, so bcash can move script verification and
signing into a pool of worker processes (`lib/workers`). This keeps the
chain and the mempool from blocking the main process for long, and it lets
transaction checks run in parallel. A worker can also die without taking the
main process with it; the pool starts a new one the next time it needs one.

Under Node.js each worker is a child process running `lib/workers/worker.js`,
and data is sent to it over pipes. The pool starts workers as jobs arrive, up
to one per CPU core, and hands jobs to them in turn. Each job times out after
120 seconds by default.

The `bcash` command (with or without `--spv`) and the standalone wallet turn
the pool on by default. The options are `workers`, `workers-size` and
`workers-timeout` (see [Configuration.md](Configuration.md)). When the pool
is off, the same jobs run in the main process.

## In the Browser

In a browser bundle, bcrypto uses its pure JavaScript secp256k1. It is slower
than libsecp256k1, but fast enough for an SPV node. The worker pool can use
Web Workers there, but the browser wallet (`browser/app.js`) starts its SPV
node with `workers: false`. See
[Running-in-the-browser.md](Running-in-the-browser.md).

# Copyright

This document is published under the terms of the MIT license.
