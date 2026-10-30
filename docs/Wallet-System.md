# Notes on the Wallet System
### Applies to: bcash v2.7.0-avalanche.18
### Date updated: October 31, 2026

## Authors
The bcoin and bcash contributors

# Table of Contents
[SECTION I: BACKGROUND](#section-i-background)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;[The Wallet Database](#the-wallet-database)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;[Key Derivation](#key-derivation)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;[Account Types](#account-types)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;[Locking](#locking)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;[Write locks](#write-locks)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;[Encrypted wallets](#encrypted-wallets)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;[The Wallet API](#the-wallet-api)<BR>

[Copyright](#copyright)


# SECTION I: BACKGROUND

## The Wallet Database

bcash keeps every wallet in one wallet database (`lib/wallet/walletdb.js`).
A wallet cannot be used without it. For testing, the database can live in
memory, but it must be there.

One database holds many wallets. Each wallet holds many accounts, and each
account holds many addresses. When the database opens, it creates a wallet
with the id `primary` if there is none yet. That wallet cannot be removed.

## Key Derivation

Wallets are hierarchical deterministic wallets that follow BIP44. Each
account's key is derived from the wallet's master key along the path
`m/44'/coin_type'/account'`, and addresses along `branch/index` below it,
where branch 0 is for receiving and branch 1 is for change.

Each wallet and each account records the coin type it was made with, and
derives its keys at that coin type from then on. A new one takes the
network's `keyPrefix.coinType` (`lib/protocol/networks.js`):

| Network | Coin type |
|---------|-----------|
| main    | 1899      |
| testnet | 1         |
| regtest | 1         |
| simnet  | 115       |

On mainnet, 1899 is the coin type Cashtab and bcash's own web wallet use, so
a phrase from a new wallet shows the same addresses in them.

Up to v2.7.0-avalanche.18, mainnet wallets used Bitcoin's 0 (`m/44'/0'`)
and recorded no coin type. A wallet or account saved without one keeps 0, for
its addresses, the private keys that sign for them, and any accounts added
to it later, so nothing already made changes. To use such a phrase in
another eCash wallet, that wallet must derive along `m/44'/0'`.

The record keeps the coin type after the fields earlier versions read, so
an earlier version can still open the database. It derives a 1899 wallet's
private keys at 0, though, so it can't sign for one.

bcoin once also supported BIP45 for multisig. That support was removed to
keep the code simpler; BIP44 accounts cover the same need.

## Account Types

eCash has no SegWit, so there are no witness accounts. An account is one of
two types (`Account.types` in `lib/wallet/account.js`):

- **pubkeyhash**: the default. Each address is a P2PKH address for one key.
- **multisig**: an m-of-n account, chosen when `n` is greater than 1. Each
  address is a P2SH address for a multisig script built from this wallet's
  key and the other cosigners' account keys at the same branch and index.
  The account cannot be used until all n - 1 cosigner keys are added. `m` must
  be between 1 and n, and n can be at most 15.

Accounts of both types can sit in the same wallet. An account can also be
watch-only, built from an account public key with no private key.

## Locking

### Write locks

Accounts have no locks of their own, so they should not be used directly
through the public API; concurrent writes could race. Go through the
`Wallet` object instead. It takes a write lock for changes to its keys and
accounts, and a separate fund lock while it selects coins and builds a
transaction, so two sends cannot spend the same coins. The wallet database
also locks each wallet while loading it, and has its own locks for creating
and renaming wallets and for handling transactions.

### Encrypted wallets

A wallet can encrypt its master key with a passphrase. Unlocking it decrypts
the key for a limited time, 60 seconds unless another timeout is given, after
which the decrypted key is wiped from memory. A timeout of -1 keeps it
unlocked until the wallet is locked again.

## The Wallet API

The wallet has its own HTTP server and websocket API (`lib/wallet/http.js`),
which listens by default on the network's wallet port: 8334 on mainnet,
18334 on testnet, 48334 on regtest and 18558 on simnet. There is no
separate reference for it in these docs yet. The `bwallet-cli` commands in
[CLI.md](CLI.md#bwallet-cli-commands) cover common use.

# Copyright

This document is published under the terms of the MIT license.
