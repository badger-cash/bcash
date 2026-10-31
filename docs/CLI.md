# Command-Line Clients
### Applies to: bcash v3.0.0
### Date updated: October 31, 2026

## Authors
The bcoin and bcash contributors

# Table of Contents
[SECTION I: BACKGROUND](#section-i-background)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;[Introduction](#introduction)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;[The two clients](#the-two-clients)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;[The old bcash cli form](#the-old-bcash-cli-form)<BR>

[SECTION II: USAGE](#section-ii-usage)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;[Connecting to a node](#connecting-to-a-node)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;[Options](#options)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;[Environment variables](#environment-variables)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;[Config files](#config-files)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;[Amounts](#amounts)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;[Examples](#examples)<BR>

[SECTION III: REFERENCE](#section-iii-reference)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;[bcash-cli commands](#bcash-cli-commands)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;[bwallet-cli commands](#bwallet-cli-commands)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;[Admin commands](#admin-commands)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;[Wallet commands](#wallet-commands)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;[Send and transaction options](#send-and-transaction-options)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;[RPC methods](#rpc-methods)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;[Node RPC](#node-rpc)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;[Wallet RPC](#wallet-rpc)<BR>

[Copyright](#copyright)


# SECTION I: BACKGROUND

## Introduction

bcash ships two command-line clients. They talk to a running node over its
HTTP API, so the node must already be running. Neither one needs a node to
print its list of commands: run either with no command, or with one it does
not know, and it prints the list.

## The two clients

`bcash-cli` talks to the node's HTTP server. It looks up blocks,
transactions, coins and the mempool, broadcasts transactions, and sends
JSON-RPC calls to the node.

`bwallet-cli` talks to the wallet's HTTP server, which listens on its own
port. It manages wallets, accounts, keys and addresses, builds and sends
transactions, and sends JSON-RPC calls to the wallet.

Both are listed in `package.json` under `bin`, so a global install of bcash
puts them on your `PATH`. From a checkout, run them as `./bin/bcash-cli` and
`./bin/bwallet-cli`.

The node and the wallet each have their own RPC methods. Node methods go
through `bcash-cli rpc`, and wallet methods go through `bwallet-cli rpc`.
Sending a wallet method such as `getbalance` to the node fails, because the
node does not know it.

### The old bcash cli form

Older bcoin documentation used `bcash cli`, `bcash wallet` and `bcash rpc`.
In this release the `bcash` script still accepts these, but it hands them to
`bin/cli`, which only prints a deprecation warning and exits:

```
Warning: The `bcash cli` interface is deprecated.
Please use `bcash-cli` and `bwallet-cli` instead.
```

Nothing is sent to the node. Use `bcash-cli` and `bwallet-cli`.


# SECTION II: USAGE

## Connecting to a node

By default both clients connect to `localhost` on the default port for the
network. The defaults are:

| Network   | `bcash-cli` (node) | `bwallet-cli` (wallet) |
|-----------|--------------------|------------------------|
| `main`    | 8332               | 8334                   |
| `testnet` | 18332              | 18334                  |
| `regtest` | 48332              | 48334                  |
| `simnet`  | 18556              | 18558                  |

### Options

Both clients read the same connection options. Each can be given as a
command-line flag, an environment variable, or a line in a config file.

| Option            | Short | What it does |
|-------------------|-------|--------------|
| `--network`       | `-n`  | `main`, `testnet`, `regtest` or `simnet`. Picks the default port and the config directory. Default `main`. |
| `--url`, `--uri`  | `-u`  | Full URL of the server, such as `http://localhost:8332`. |
| `--http-host`     | `-h`  | Host to connect to. |
| `--http-port`     | `-p`  | Port to connect to. Overrides the network's default. |
| `--ssl`           | `-s`  | Connect with HTTPS. |
| `--api-key`       | `-k`  | The server's API key. |
| `--config`        |       | Path of a config file to read instead of the default one. |

`bwallet-cli` also reads two wallet options:

| Option     | What it does |
|------------|--------------|
| `--id`     | The wallet to use. Default `primary`. |
| `--token`  | A token, needed only when the wallet server runs with `wallet-auth`. For wallet commands it is the wallet's token. For admin commands and wallet RPC it is the server's `admin-token`. |

Note that `-h` means `--http-host`, not help.

### Environment variables

Any option can be set as an environment variable. Write it in upper case
with the prefix `BCASH_`, using underscores for dashes:

```bash
$ export BCASH_NETWORK=testnet
$ export BCASH_API_KEY=hunter2
$ export BCASH_URI=http://localhost:18332
$ bcash-cli info
```

A flag on the command line wins over the environment, and the environment
wins over a config file.

### Config files

`bcash-cli` reads `bcash.conf` and `bwallet-cli` reads `wallet.conf`, from
the bcash data directory. That directory is `~/.bcash` on mainnet and
`~/.bcash/<network>` on other networks, so a testnet client reads
`~/.bcash/testnet/bcash.conf`. These are the same files the node and the
wallet read, so a client picks up the node's `api-key` without being told.
A missing file is not an error.

To read a different file, pass `--config`:

```bash
$ echo 'api-key: hunter2' > ~/cli.conf
$ bcash-cli info --config=/home/me/cli.conf
```

## Amounts

The clients do not take amounts in XEC. They read an amount as a decimal
number with eight places and multiply it by 100,000,000 to get satoshis.
That is the old Bitcoin unit, not XEC: one XEC is 100 satoshis.

So to send 100 XEC (10,000 satoshis), you write `0.0001`. Writing `0.01`
sends 1,000,000 satoshis, which is 10,000 XEC.

| You want to send | Satoshis      | Write    |
|------------------|---------------|----------|
| 1 XEC            | 100           | `0.000001` |
| 100 XEC          | 10,000        | `0.0001` |
| 10,000 XEC       | 1,000,000     | `0.01`   |
| 1,000,000 XEC    | 100,000,000   | `1`      |

The same unit applies to `--rate` (a fee rate per kilobyte), to the output
of `bcash-cli fee`, and to the amounts that RPC methods like `getbalance`,
`sendtoaddress` and `listunspent` take and return. The Avalanche RPCs are
the exception: they report stake and rewards in XEC, as Bitcoin ABC does.

The wallet's HTTP API itself takes and returns plain satoshis. The
conversion happens in the client.

## Examples

```bash
$ export BCASH_API_KEY=your-api-key

# Server info
$ bcash-cli info

# The genesis block
$ bcash-cli block 0

# The mempool
$ bcash-cli mempool

# The primary wallet
$ bwallet-cli get

# Transaction history
$ bwallet-cli history

# Balance, in satoshis
$ bwallet-cli balance

# A new receiving address
$ bwallet-cli address

# Send 100 XEC
$ bwallet-cli send [address] 0.0001

# Create an account, then send 100 XEC from it
$ bwallet-cli account create foo
$ bwallet-cli send [address] 0.0001 --account=foo

# Use a wallet other than primary
$ bwallet-cli balance --id=mywallet
```

RPC examples. Node methods go through `bcash-cli`, wallet methods through
`bwallet-cli`:

```bash
$ bcash-cli rpc getblockchaininfo
$ bcash-cli rpc getpeerinfo
$ bcash-cli rpc getavalancheinfo
$ bwallet-cli rpc getwalletinfo
$ bwallet-cli rpc getbalance
$ bwallet-cli rpc listtransactions
$ bwallet-cli rpc sendtoaddress [address] 0.0001
```

Each RPC argument is parsed as JSON if it can be, and passed as a string if
not. `bcash-cli rpc help` and `bwallet-cli rpc help` list the methods.


# SECTION III: REFERENCE

## bcash-cli commands

| Command | What it does |
|---------|--------------|
| `info` | Server info: network, chain tip, sync progress, connections, memory. |
| `broadcast [tx-hex]` | Broadcast a raw transaction. |
| `mempool` | List the hashes in the mempool. |
| `tx [hash]` | Show a transaction. Needs `index-tx` for confirmed transactions. |
| `tx [address]` | Show an address's transactions. Needs `index-tx` and `index-address`. |
| `tx slp [hash or address]` | The same, with SLP token data added to the coins. Needs `index-slp`. |
| `coin [hash] [index]` | Show an unspent output. |
| `coin [address]` | Show an address's unspent outputs. Needs `index-address`. |
| `coin slp [hash] [index]` | The same, with SLP token data. Needs `index-slp`. |
| `slp [hash]` | Show the SLP records of a transaction's outputs. |
| `token [token-id]` | Show an SLP token's record. |
| `block [hash or height]` | Show a block. |
| `header [hash or height]` | Show a block header, and whether it is final. Works on an SPV node too. |
| `fee [target]` | Estimate the fee rate for confirming within `target` blocks (default 1). |
| `rpc [method] [args...]` | Call a node RPC method. |

None of the lookups work on an SPV node, which keeps no blocks or coins.

The node's HTTP server also serves `GET /spent/:hash/:index`, which returns
the transaction that spent an output (it needs `index-tx`). `bcash-cli` has
no command for it.

## bwallet-cli commands

### Admin commands

These act on the wallet server as a whole, not on one wallet. They can be
written with or without the word `admin` in front: `bwallet-cli wallets` and
`bwallet-cli admin wallets` do the same thing.

| Command | What it does |
|---------|--------------|
| `wallets` | List all wallet ids. |
| `create [id]` (or `mkwallet`) | Create a wallet. |
| `resend` | Rebroadcast every wallet's pending transactions. |
| `backup [path]` | Back up the wallet database to `path` on the server. |
| `rpc [method] [args...]` | Call a wallet RPC method. |

`create` takes these options: `--type` (`pubkeyhash` or `multisig`), `--m`
and `--n` for multisig, `--mnemonic` or `--master` to restore from a phrase
or key, `--passphrase` to encrypt it, `--watch-only`, and `--account-key` to
create a watch-only wallet from an account public key.

### Wallet commands

These act on the wallet named by `--id` (default `primary`).

| Command | What it does |
|---------|--------------|
| `get` | Show the wallet. |
| `master` | Show the wallet's master key. |
| `listen` | Stay connected and print wallet events as they happen. |
| `balance` | Show the balance, in satoshis. |
| `history` | List the wallet's transactions. |
| `pending` | List unconfirmed transactions. |
| `coins` | List unspent coins. |
| `account list` | List account names. |
| `account create [name]` | Create an account. Takes `--type`, `--m`, `--n`, `--account-key`, `--passphrase`. |
| `account get [name]` (or `account [name]`) | Show an account. |
| `address` | Derive a new receiving address. |
| `change` | Derive a new change address. |
| `shared list [account]` (or `shared [account]`) | List an account's shared (multisig) keys. |
| `shared add [xpubkey]` | Add a shared key to a multisig account. |
| `shared remove [xpubkey]` | Remove a shared key. |
| `send [address] [value]` | Build, sign and broadcast a transaction. |
| `mktx [address] [value]` | Build a transaction without broadcasting it. |
| `sign [tx-hex]` | Sign a transaction. |
| `zap [age]` | Remove pending transactions older than `age` seconds (default 259200, three days). |
| `abandon [hash]` | Abandon a pending transaction. |
| `tx [hash]` | Show a wallet transaction. |
| `blocks` | List the heights of blocks that hold wallet transactions. |
| `block [height]` | Show the wallet transactions in a block. |
| `view [tx-hex]` | Decode a raw transaction and show it. Done in the client, with no request to the server. |
| `import [wif or hex]` | Import a private key (WIF) or a public key (hex). |
| `watch [address]` | Import an address to watch. |
| `key [address]` | Show the wallet key for an address. |
| `dump [address]` | Show the private key (WIF) for an address. |
| `lock` | Lock the wallet. |
| `unlock [passphrase] [timeout]` | Unlock the wallet, for `timeout` seconds. |
| `resend` | Rebroadcast this wallet's pending transactions. |
| `retoken` | Make a new wallet token. |
| `rescan [height]` | Rescan the chain for wallet transactions from `height`. The server treats this as an admin action. |

Most commands that act on one account take `--account`. Commands that need
the private keys of an encrypted wallet take `--passphrase`.

### Send and transaction options

`send` and `mktx` take these options. Values use the unit described in
[Amounts](#amounts).

| Option | What it does |
|--------|--------------|
| `--account` | Spend from this account. |
| `--passphrase` | The wallet passphrase, if it is encrypted. |
| `--rate` | Fee rate per kilobyte. |
| `--smart` | Use smart fee estimation. |
| `--subtract-fee` | Take the fee out of the output's value. |
| `--script [hex]` | Pay to this output script instead of an address. The value is then the first argument. |
| `--sign` | `mktx` only: sign the transaction it builds. |

## RPC methods

bcash implements most of the bitcoind JSON-RPC calls, plus its own. This is
the full set registered in this release.

### Node RPC

Called through `bcash-cli rpc`.

**Control:** `stop`, `help`, `getinfo`, `getmemoryinfo`, `setloglevel`

**Chain:** `getblockchaininfo`, `getbestblockhash`, `getblockcount`,
`getblock`, `getblockbyheight`, `getblockhash`, `getblockheader`,
`getchaintips`, `getdifficulty`, `gettxout`, `gettxoutsetinfo`,
`pruneblockchain`, `verifychain`, `invalidateblock`, `reconsiderblock`

**Mempool:** `getmempoolancestors`, `getmempooldescendants`,
`getmempoolentry`, `getmempoolinfo`, `getrawmempool`,
`prioritisetransaction`

**Mining:** `getnetworkhashps`, `getmininginfo`, `getwork`, `getworklp`,
`getblocktemplate`, `submitblock`, `verifyblock`, `setgenerate`,
`getgenerate`, `generate`, `generatetoaddress`

**Fees:** `estimatefee`, `estimatepriority`, `estimatesmartfee`,
`estimatesmartpriority`

**Network:** `getconnectioncount`, `ping`, `getpeerinfo`, `addnode`,
`disconnectnode`, `getaddednodeinfo`, `getnettotals`, `getnetworkinfo`,
`setban`, `listbanned`, `clearbanned`

**Raw transactions:** `getrawtransaction`, `createrawtransaction`,
`decoderawtransaction`, `decodescript`, `sendrawtransaction`,
`signrawtransaction`, `gettxoutproof`, `verifytxoutproof`

**Utility:** `validateaddress`, `createmultisig`, `verifymessage`,
`signmessagewithprivkey`, `setmocktime`

**Avalanche:** `getavalancheinfo`, `getavalanchepeerinfo`,
`getavalanchekey`, `buildavalancheproof`, `decodeavalancheproof`,
`verifyavalancheproof`, `delegateavalancheproof`,
`decodeavalanchedelegation`, `verifyavalanchedelegation`,
`sendavalancheproof`, `isfinalblock`, `isfinaltransaction`,
`getfinaltransactions`, `parkblock`, `unparkblock`, `finalizetransaction`,
`removetransaction`, `getstakingreward`

The Avalanche methods need a node started with Avalanche turned on. See
[Avalanche.md](Avalanche.md) for what each one does.

### Wallet RPC

Called through `bwallet-cli rpc`.

**Control:** `stop`, `help`, `getmemoryinfo`, `setloglevel`, `selectwallet`

**Wallet:** `getwalletinfo`, `backupwallet`, `dumpwallet`, `importwallet`,
`encryptwallet`, `walletlock`, `walletpassphrase`,
`walletpassphrasechange`, `keypoolrefill`, `settxfee`

**Keys and addresses:** `getnewaddress`, `getrawchangeaddress`,
`addmultisigaddress`, `dumpprivkey`, `importprivkey`, `importpubkey`,
`importaddress`, `importprunedfunds`, `removeprunedfunds`,
`listaddressgroupings`, `signmessage`

**Accounts:** `getaccount`, `getaccountaddress`, `getaddressesbyaccount`,
`setaccount`, `listaccounts`, `getreceivedbyaccount`,
`listreceivedbyaccount`, `move`

**Balances and history:** `getbalance`, `getunconfirmedbalance`,
`getreceivedbyaddress`, `listreceivedbyaddress`, `gettransaction`,
`listtransactions`, `listsinceblock`, `listunspent`, `lockunspent`,
`listlockunspent`

**Sending:** `sendtoaddress`, `sendfrom`, `sendmany`,
`fundrawtransaction`, `resendwallettransactions`, `abandontransaction`

`selectwallet` chooses which wallet the following wallet RPC calls act on.


# Copyright

This document is published under the terms of the MIT license.
