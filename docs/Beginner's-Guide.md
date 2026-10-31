# Beginner's Guide
### Applies to: bcash v2.7.0-avalanche.18
### Date updated: October 31, 2026

## Authors
The bcoin and bcash contributors

# Table of Contents
[SECTION I: BACKGROUND](#section-i-background)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;[Introduction](#introduction)<BR>

[SECTION II: SETUP](#section-ii-setup)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;[Requirements](#requirements)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;[Native modules](#native-modules)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;[Other operating systems](#other-operating-systems)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;[Installing](#installing)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;[Troubleshooting](#troubleshooting)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;[Starting Your First Node](#starting-your-first-node)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;[Default ports](#default-ports)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;[The HTTP Server](#the-http-server)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;[Listening externally](#listening-externally)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;[Using an API key](#using-an-api-key)<BR>

[SECTION III: NETWORK OPTIONS](#section-iii-network-options)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;[Using Tor and SOCKS](#using-tor-and-socks)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;[Running bcash as a Tor hidden service](#running-bcash-as-a-tor-hidden-service)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;[Target Nodes](#target-nodes)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;[Disabling Listening](#disabling-listening)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;[Selfish mode](#selfish-mode)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;[Further Configuration](#further-configuration)<BR>

[Copyright](#copyright)


# SECTION I: BACKGROUND

## Introduction

bcash is an alternative implementation of the eCash (XEC) protocol, written
in JavaScript for Node.js. It is a fork of bcoin. A bcash full node validates
the whole blockchain and follows eCash's consensus rules, and it can also take
part in Avalanche (see [Avalanche](Avalanche.md)).

This guide covers installing bcash, starting a node, and the options most
people need first.

# SECTION II: SETUP

## Requirements

- Linux. bcash is developed and run on Linux.
- Node.js 18, 20 or 24 (`package.json` asks for 18 or later).
- Yarn 1. The repository has a `yarn.lock` and no `package-lock.json`, so
  install with `yarn`, not `npm`.
- git. Most dependencies are fetched straight from their git repositories.
- Python 3, `make` and a C/C++ compiler (gcc/g++ or clang), for
  `node-gyp`, which builds the native modules.

### Native modules

Five dependencies are native modules that `node-gyp` compiles for your
Node.js during `yarn install`:

| Module  | What it does                          | If the build fails       |
|---------|---------------------------------------|--------------------------|
| bcrypto | Hashing, secp256k1 and other crypto   | `yarn install` fails     |
| bdb     | LevelDB, the node's database          | `yarn install` fails     |
| mrmr    | Murmur3 hashing, for bloom filters    | `yarn install` fails     |
| n64     | 64-bit integers                       | `yarn install` fails     |
| bstring | Base58, bech32 and cashaddr encoding  | Falls back to JavaScript |

`node-gyp` itself is partly written in Python, so Python 3 must be on your
`PATH` even though none of these modules contains Python code.

There is also one optional dependency, `@fails-components/webtransport`. It
lets a full node serve WebTransport to browser pages (`--wt-port`; see
[Running in the browser](Running-in-the-browser.md)). Its install first tries
to download a prebuilt binary, and builds from source with `cmake-js` only if
none is available, which can take more than twenty minutes. If it fails, the
install carries on without it, and only WebTransport is unavailable.

### Other operating systems

macOS and Windows have not been tested with this release.

- On macOS, the `bin/bcash` launcher needs `perl`.
- On Windows, `bin/bcash` is a bash script, so it needs a shell such as Git
  Bash. You can also start the node directly with `node bin/node`.
  `node-gyp` needs Python 3 and Visual Studio's C++ build tools there.

## Installing

bcash is installed from its GitHub repository. (The `bcash` package on npm is
an old release of bcoin-org's bcash, not this one.)

``` bash
$ git clone https://github.com/badger-cash/bcash.git
$ cd bcash
$ git checkout v2.7.0-avalanche.18
$ yarn install
```

Releases are tagged; the list is at
https://github.com/badger-cash/bcash/releases.

The commands live in `bin/`: `bcash`, `bcash-cli` and `bwallet-cli`, among
others. To run them by name, add that directory to your `PATH`:

``` bash
$ export PATH="$PWD/bin:$PATH"
```

### Troubleshooting

If `yarn install` stops while building bcrypto, bdb, mrmr or n64, check that
Python 3, `make` and a C++ compiler are installed and that you are on Node.js
18, 20 or 24.

The native modules are built for one Node.js version. If you switch versions
later, rebuild them: delete `node_modules` and run `yarn install` again.

If bstring fails to build, the install still succeeds and bcash uses the
JavaScript version, which is slower.

If the problem persists, open an issue at
https://github.com/badger-cash/bcash/issues.

## Starting Your First Node

With `bin/` in your `PATH`, start a node with:

``` bash
$ bcash
```

(Otherwise, run `./bin/bcash` from the checkout.) This runs a full node in the
foreground and prints its logs, at the `debug` level, to the console. To run
it in the background instead:

``` bash
$ bcash --daemon
```

The launcher prints the process ID and exits. The node starts with a
blockchain, a mempool, a miner, a P2P server, a wallet, and an HTTP server for
the REST and JSON-RPC APIs. `--no-wallet` leaves the wallet out, and `--spv`
starts an SPV node instead of a full node.

Data and logs live in `~/.bcash` by default (`--prefix` changes this). The log
file is `~/.bcash/debug.log` on mainnet; other networks keep theirs in a
subdirectory, such as `~/.bcash/testnet/debug.log`.

### Default ports

| Network | P2P   | Node HTTP (REST and RPC) | Wallet HTTP |
|---------|-------|--------------------------|-------------|
| main    | 8333  | 8332                     | 8334        |
| testnet | 18333 | 18332                    | 18334       |
| regtest | 48444 | 48332                    | 48334       |

Choose the network with `--network`, for example `--network testnet`.
`--port` changes the P2P port and `--http-port` the node's HTTP port.

## The HTTP Server

By default, the node's HTTP server listens only on `127.0.0.1`, at the
network's HTTP port (8332 on mainnet). On `127.0.0.1` or `::1`, with no API
key set, no authentication is required.

On any other host, choose one of two ways to serve:

- With `--api-key`, every request must carry the key.
- With `--no-auth`, anyone can use the node's HTTP API without a key.

If you set neither, bcash makes up a random key and does not show it
anywhere, so every request is refused.

A fully public node can also stay on `127.0.0.1`, where no key is needed, with
a reverse proxy such as nginx serving it to the internet. That is how
`ecash.badger.cash:8332` is run.

The wallet's HTTP server follows the same rules on its own port. Its options
take a `wallet-` prefix (for example `--wallet-http-host`), and it uses the
node's `--api-key` unless you give it `--wallet-api-key`.

### Listening externally

To serve HTTP on every interface, pass `--http-host=0.0.0.0` (IPv4) or
`--http-host=::` (IPv4 and IPv6), together with an API key.

To advertise your node on the P2P network, pass `--public-host` with your
public IP address, and `--public-port` if it differs from the P2P port.

### Using an API key

Choose a key with `--api-key`:

``` bash
$ bcash --http-host=0.0.0.0 --api-key hunter2 --daemon
```

The API uses HTTP Basic authentication. The key is the password, and the user
name can be anything:

``` bash
$ curl http://x:hunter2@localhost:8332/
```

`bcash-cli` talks to the node's REST and RPC APIs, and `bwallet-cli` to the
wallet's:

``` bash
$ bcash-cli info --api-key hunter2
$ bcash-cli rpc getblockchaininfo --api-key hunter2
```

(The older `bcash cli ...`, `bcash rpc ...` and `bcash wallet ...` forms no
longer do anything: they print a warning that they are deprecated, and exit.
See [CLI](CLI.md#the-old-bcash-cli-form).)

# SECTION III: NETWORK OPTIONS

## Using Tor and SOCKS

bcash can make its outbound P2P connections through a SOCKS5 proxy. Pass
`--proxy` in the form `[user:pass@]host:port`.

Add `--onion` when the proxy is Tor. bcash then resolves DNS names through
Tor, and also connects to `.onion` addresses it learns from the network.

``` bash
$ bcash --proxy joe:hunter2@127.0.0.1:9050 --onion
```

With `--proxy` set, bcash does not listen for inbound P2P connections, and it
does not look up its own public address. A staking Avalanche node refuses to
start with `--proxy`.

### Running bcash as a Tor hidden service

First configure the hidden service in `tor`, pointing it at bcash's P2P port.
Then pass the `.onion` address to bcash with `--public-host foo.onion`, so
that bcash advertises it to its peers.

Because `--proxy` turns off listening, a node serving as a hidden service
cannot also send its outbound connections through the proxy.

## Target Nodes

You may want to run behind one or more nodes you trust. `--nodes` lists nodes
that bcash always tries to connect to as outbound peers:

``` bash
$ bcash --nodes foo.example.com:8333,1.2.3.4:8333,5.6.7.8:8333
```

bcash dials these nodes before any others and keeps redialing them, even
after a ban. They are never dropped for syncing slowly or for being on another
chain.

To connect to these nodes and no others, use `--only` instead. It sets the
number of outbound peers to the number of nodes listed and turns off peer
discovery:

``` bash
$ bcash --only foo.example.com,1.2.3.4,5.6.7.8
```

## Disabling Listening

To accept no inbound P2P connections at all, pass `--listen=false`.

### Selfish mode

In selfish mode, bcash still validates the blockchain and mempool fully, but
gives nothing back to the network: it does not relay transactions, serve
blocks, or answer requests for addresses.

``` bash
$ bcash --selfish --listen=false
```

Selfish mode is not recommended. Relaying transactions and blocks helps the
network. It can make sense if you have no bandwidth to spare, or you are
worried about denial-of-service attacks.

## Further Configuration

See [Configuration](Configuration.md) for the full list of options and the
`bcash.conf` file.

# Copyright

This document is published under the terms of the MIT license.
