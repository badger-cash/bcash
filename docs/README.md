# bcash Documentation
### Applies to: bcash v3.0.0
### Date updated: October 31, 2026

## Authors
The bcoin and bcash contributors

# Table of Contents
[SECTION I: BACKGROUND](#section-i-background)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;[About These Docs](#about-these-docs)<BR>

[SECTION II: DOCUMENTS](#section-ii-documents)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;[Getting Started](#getting-started)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;[Running](#running)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;[Specifications](#specifications)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;[Deployment](#deployment)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;[Code Examples](#code-examples)<BR>

[Copyright](#copyright)


# SECTION I: BACKGROUND

## About These Docs

These are the docs for bcash, the eCash Edition. bcash is a fork of bcoin
and keeps bcoin's HTTP and RPC API, with additions for eCash. Each document
states the release it was checked against. Where a document and the code
disagree, the code is right, and the document is a bug: please report it at
https://github.com/badger-cash/bcash/issues.

bcash has no API reference of its own yet. For the HTTP and RPC API it
shares with bcoin, see
[bcoin's API reference](https://github.com/bcoin-org/bcoin-org.github.io/tree/staging/api-docs-slate/source).
The [CLI](CLI.md) document lists every RPC method this release registers.

# SECTION II: DOCUMENTS

## Getting Started
- [Beginner's Guide](Beginner's-Guide.md): requirements, installing, and
  starting a first node.
- [Configuration](Configuration.md): every option, and where it can be set.
- [Wallet System](Wallet-System.md): wallets, accounts and key derivation.
- [Notes on Design](Design.md): how the parts of a node fit together.
- [Changelog](../CHANGELOG.md): what changed in each release.

## Running
- [Command-Line Clients](CLI.md): `bcash-cli`, `bwallet-cli`, and the RPC
  methods.
- [Running in the Browser](Running-in-the-browser.md): serving pages from a
  full node, the web wallet, and bcash in your own page.
- [Avalanche](Avalanche.md): finality, staking and pre-consensus.

## Specifications
- [SPV+ Protocol Suite](SPV-Plus.md): how light clients in web pages find,
  connect to, sync from and relay for one another.

## Deployment
- [Running a Public Node Behind nginx (Hardened)](Public-Node-Nginx-Hardening.md)

## Code Examples
- [Simple Full Node](Examples/fullnode.js)
- [Connect to a Peer](Examples/connect-to-peer.js)
- [Connecting to the P2P Network](Examples/connect-to-the-p2p-network.js)
- [Creating a Blockchain and Mempool](Examples/create-a-blockchain-and-mempool.js)
- [Wallet with a Dummy TX](Examples/wallet.js)
- [Full Node and Wallet](Examples/fullnode-and-wallet.js)
- [SPV Sync](Examples/spv-sync-wallet.js)
- [Plugin Example](Examples/peers-plugin.js)
- [Client API Usage](Examples/client-api.js)
- [Miner with a Worker Pool](Examples/miner-configs.js)
- [Create and Sign a TX](Examples/create-sign-tx.js)
- [Get a Transaction from the Chain](Examples/get-tx-from-chain.js)

The examples run from a checkout, with `node docs/Examples/<name>.js`. Those
that dial the network connect to testnet or mainnet peers.

# Copyright

This document is published under the terms of the MIT license.
