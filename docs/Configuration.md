# Configuration
### Applies to: bcash v3.0.0
### Date updated: October 31, 2026

## Authors
The bcoin and bcash contributors

# Table of Contents
[SECTION I: BACKGROUND](#section-i-background)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;[Where Options Come From](#where-options-come-from)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;[Writing an Option Four Ways](#writing-an-option-four-ways)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;[Datadir and Prefix](#datadir-and-prefix)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;[Options That Only Work on the Command Line](#options-that-only-work-on-the-command-line)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;[Creating a Node in JavaScript](#creating-a-node-in-javascript)<BR>

[SECTION II: OPTIONS](#section-ii-options)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;[Common Options](#common-options)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;[Node Options](#node-options)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;[Logger Options](#logger-options)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;[Chain Options](#chain-options)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;[Index Options](#index-options)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;[Mempool Options](#mempool-options)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;[Pool Options](#pool-options)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;[Peers over TCP](#peers-over-tcp)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;[WebTransport and STUN](#webtransport-and-stun)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;[SPV Node and Page Options](#spv-node-and-page-options)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;[Avalanche Options](#avalanche-options)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;[Miner Options](#miner-options)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;[HTTP Options](#http-options)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;[Wallet Options](#wallet-options)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;[Wallet Database](#wallet-database)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;[Wallet HTTP Server](#wallet-http-server)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;[Standalone Wallet: Reaching the Node](#standalone-wallet-reaching-the-node)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;[Command-Line Clients](#command-line-clients)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;[Sample Config Files](#sample-config-files)<BR>

[Copyright](#copyright)


# SECTION I: BACKGROUND

## Where Options Come From

bcash reads its options from four places. From highest to lowest
precedence, they are:

1. Command-line arguments.
2. Environment variables.
3. The config file.
4. The options object, when you create a node in JavaScript.

An option given in a higher place wins over the same option given in a
lower one.

On mainnet, the config files are `~/.bcash/bcash.conf` for the node and
`~/.bcash/wallet.conf` for the wallet. On other networks they sit in a
directory named after the network, such as `~/.bcash/testnet/bcash.conf`.
The command-line clients, `bcash-cli` and `bwallet-cli`, read the same
files, so they find the server's API key and port without being told.

For example:

``` bash
bcash --network=regtest --api-key=menace --daemon
```

This reads the config file at `~/.bcash/regtest/bcash.conf`, and uses the
`network` and `api-key` given on the command line in place of any in that
file.

The `config` option points bcash at a config file somewhere else.

## Writing an Option Four Ways

Each place spells an option a little differently. Note the hyphens,
underscores and capital letters:

| config file | CLI parameter | environment variable | JS object constructor |
|---|---|---|---|
| `network: testnet` | `--network=testnet` | `BCASH_NETWORK=testnet` | `{network: 'testnet'}` |
| `log-level: debug` | `--log-level=debug` | `BCASH_LOG_LEVEL=debug` | `{logLevel: 'debug'}` |
| `max-outbound: 8` | `--max-outbound=8` | `BCASH_MAX_OUTBOUND=8` | `{maxOutbound: 8}`|

In a config file, each line is `name: value`, and lines starting with `#`
are comments. Lists, such as `nodes` or `seeds`, are comma-separated. A
boolean option given on the command line with no value, such as
`--index-tx`, is `true`.

In options that take a file path, such as `ssl-key`, a path starting with
`~` is under your home directory, and a path starting with `@` is under the
prefix (see below).

## Datadir and Prefix

The data directory is set by the `prefix` option. It defaults to
`~/.bcash` on mainnet, and `~/.bcash/<network>` on other networks. It holds
the chain database, the block files, the indexes, the wallet database, the
log file (`debug.log`) and the config files.

Example:

``` bash
$ bcash --prefix ~/.bcash_spv --spv
```

This uses `~/.bcash_spv` as the data directory, with a chain database,
wallet database and log file of its own.

## Options That Only Work on the Command Line

The `spv` and `daemon` options are read by the `bcash` launch script, not
by the node, so they have no effect in `bcash.conf` or the environment.
Pass them as arguments:

```
bcash --spv --daemon
```

`--spv` starts the SPV node (`bcash-spvnode`) in place of the full node
(`bcash-node`). `--daemon` runs it in the background and prints its process
ID.

## Creating a Node in JavaScript

When you create a `FullNode` or `SPVNode` in JavaScript, only the options
object is read unless you ask for more: pass `file: true` to read the config
file, `env: true` to read the environment, and `argv: true` to read the
command line.

The defaults also differ from the `bcash` command. The command sets
`memory: false`, `workers: true`, `listen: true`, `logFile: true`,
`logConsole: true` and `logLevel: 'debug'` for you. A node created in
JavaScript without them keeps everything in memory, verifies without
workers, takes no inbound connections and logs nothing.

Some options can only be given in JavaScript, because their values are
functions or objects. They are marked "(JavaScript only)" below.


# SECTION II: OPTIONS

## Common Options

- `config`: A config file to read in place of the one in the prefix
  directory.
- `network`: Which network to use: `main`, `testnet`, `regtest` or `simnet`
  (default: main).
- `workers`: Whether to verify transactions in a pool of worker processes
  (default: true).
- `workers-size`: Number of worker processes (default: the number of CPU
  cores).
- `workers-timeout`: Worker execution timeout in milliseconds (default:
  120000).
- `worker-file`: The script the worker processes run (default:
  `worker.js`, or the `BCASH_WORKER_FILE` environment variable).

## Node Options

- `prefix`: The data directory (default: `~/.bcash`).
- `memory`: Keep all databases in memory and write nothing to disk
  (default: false).
- `max-files`: Max open files for LevelDB. Higher generally means more disk
  page cache benefits, but also more memory usage (default: 64).
- `cache-size`: Size (in MB) of the LevelDB cache and write buffer
  (default: 32).
- `block-cache-size`: Size (in MB) of the cache of the block files' index
  database (default: 8).
- `spv`: Run an SPV node. Command line only, see
  [above](#options-that-only-work-on-the-command-line).
- `no-wallet`: Don't load the wallet (default: false).
- `plugins`: Plugins to load, comma-separated. On the command line each
  is a module name, loaded with `require`.

## Logger Options

- `log-level`: `none`, `error`, `warning`, `info`, `debug`, or `spam`
  (default: debug).
- `log-console`: Whether to write to stdout/stderr when running in the
  foreground (default: true).
- `log-file`: Whether to write a log file, `debug.log` in the prefix
  (default: true).
- `logger`: A logger object to use in place of bcash's own (JavaScript
  only).

## Chain Options

Some chain options change what the chain database stores, and must be
given the same way each time the node starts.

- `prune`: Delete old blocks, keeping the last 288 on mainnet and the last
  10000 on testnet and regtest (default: false). A pruned node can't run
  the transaction, address or SLP indexes.
- `force-flags`: Start even though `prune` is now on and the database was
  made without it (default: false).
- `checkpoints`: Use the network's checkpoints during the initial sync
  (default: true).
- `entry-cache`: Number of block headers kept in memory (default: 5000).
- `anchor`: For an SPV node, a trusted block to start the chain from in
  place of genesis (JavaScript only). See
  [Running in the browser](Running-in-the-browser.md).

## Index Options

- `index-tx`: Index transactions (enables the transaction endpoints in the
  REST API) (default: false). It also records where each output was spent:
  a transaction's outputs carry `spentBy` (`{txid, input, height}`, with
  height -1 while the spend is in the mempool, or `null` if unspent), and
  `/spent/:hash/:index` returns the spender of one output. A transaction
  index made by an earlier version fills in its spenders once, in the
  background, on its first start.
- `index-address`: Index transactions and coins by address, in the chain
  and in the mempool (default: false).
- `index-slp`: Index SLP token data (default: false). Needs `index-tx`.
- `index-prefix`: The directory the indexes are stored in (default: the
  prefix).
- `max-txs`: The most transactions one address query returns (default:
  100).

## Mempool Options

- `mempool-size`: Max mempool size in MB (default: 100).
- `persistent-mempool`: Save the mempool to disk and load it on startup
  (default: false).
- `limit-free`: Rate-limit free transactions (default: true).
- `limit-free-relay`: The rate limit for free transactions, in thousands of
  bytes per minute (default: 15).
- `require-standard`: Accept only standard transactions (default: true on
  mainnet, false on the other networks).
- `reject-absurd-fees`: Reject transactions that pay absurdly high fees
  (default: true).

## Pool Options

### Peers over TCP

- `listen`: Accept incoming connections (default: true). Turned off when
  `proxy` is set.
- `host`: Host to listen on (default: 0.0.0.0).
- `port`: Port to listen on (default: 8333 on mainnet, 18333 on testnet,
  48444 on regtest).
- `public-host`: Public host to advertise to peers (default: `host`, if it
  is a routable address).
- `public-port`: Public port to advertise to peers (default: `port`).
- `max-outbound`: Max number of outbound connections (default: 8).
- `max-inbound`: Max number of inbound connections over TCP (default: 8).
- `seeds`: Custom list of DNS seeds (comma-separated).
- `nodes`: Nodes to always try to connect to (comma-separated).
- `only`: Connect to these nodes only, and to no others (comma-separated).
- `selfish`: Enable "selfish" mode: relay no transactions or blocks, and
  serve no Bloom filters (default: false).
- `compact`: Enable compact block relay (default: true).
- `bip37`: Serve BIP 37 Bloom filters and merkle blocks to SPV clients,
  including pages (default: false).
- `services`: The service bits to advertise, as a number. This replaces
  the bits bcash would otherwise set from the other options, so it's rarely
  needed.
- `proxy`: A SOCKS5 proxy to make outbound connections through, as
  `host:port` or `user:pass@host:port`.
- `onion`: Connect to `.onion` addresses, and resolve names through the
  proxy. Needs `proxy` (default: false).
- `upnp`: Try to open the listening port on the router with UPnP (default:
  false).
- `create-socket`: A function to open outbound sockets with (JavaScript
  only).

### WebTransport and STUN

These let web pages connect to a full node. See
[Running in the browser](Running-in-the-browser.md) and
[SPV+](SPV-Plus.md) for how they fit together.

- `wt-port`: UDP port to serve P2P over WebTransport, so web pages can
  connect (default: off). The node makes its own self-signed certificate,
  which pages trust by its hash, and replaces it every 13 days. Needs the
  optional dependency `@fails-components/webtransport`. Turn on `bip37`
  too, since pages sync as SPV clients.
- `wt-host`: Public IP address for WebTransport. The node listens on it,
  advertises it to pages, and issues the certificate for it. If it isn't
  set, the node listens on `host`, and uses `public-host` for the
  certificate and adverts.
- `wt-max-inbound`: Max number of inbound WebTransport connections (pages),
  counted separately from `max-inbound` (default: 64).
- `wt-seed-port`: UDP port to serve WebTransport as a seed, using a normal
  certificate for the node's domain name (default: off). Pages that don't
  know any nodes yet dial a seed by name to find some.
- `wt-seed-cert`, `wt-seed-key`: The seed's certificate (full chain) and
  private key, as PEM files, such as those from Let's Encrypt. Both are
  needed with `wt-seed-port`. The node reloads them within an hour of a
  renewal.
- `stun-port`: UDP port to answer STUN requests on (default: off). WebRTC
  peers, such as web pages connecting to each other, ask a STUN server what
  public address their traffic comes from. The node answers Binding
  requests only, a few a second per address at most. The usual port is
  3478.
- `stun-host`: Address to listen for STUN on (default: `host`).

### SPV Node and Page Options

An SPV node reads `proxy`, `onion`, `upnp`, `seeds`, `nodes`, `only`,
`max-outbound` and `create-socket` from the list above. It never listens,
and it relays nothing. It also reads these:

- `request-mempool`: Once synced, ask peers for the transactions in their
  mempools that match our filter (default: true).
- `web-transport`: The `WebTransport` class, to connect to nodes over
  WebTransport alone, as a page does (JavaScript only).
- `wt-seeds`: The WebTransport seeds to start from, in place of the
  network's own, as `host:port`, comma-separated. In JavaScript an entry
  may also be an object with the certificate hashes to trust.
- `wt-store`: Where to keep the WebTransport nodes a page learns, between
  visits (JavaScript only).
- `web-rtc`: The `RTCPeerConnection` class, to connect to other pages over
  WebRTC (JavaScript only).
- `rtc-max-peers`: Max number of WebRTC peers (default: 4).
- `stun-servers`: STUN servers to fall back on, as `host:port`,
  comma-separated (default: the network's own).
- `window-blocks`: Number of recent whole blocks a page keeps, to serve to
  other pages (default: 288).
- `window-bytes`: The most bytes those blocks may take (default: 25000000
  with `web-rtc`, otherwise 0, which keeps none).

[Running in the browser](Running-in-the-browser.md) explains these with
examples.

## Avalanche Options

Avalanche is off unless you turn it on with `avalanche`. Its options are
explained in [Avalanche](Avalanche.md). They are:

- Avalanche: `avalanche`, `max-avalanche-outbound`, `ava-cooldown`,
  `ava-min-quorum-stake`, `ava-min-quorum-connected-stake-ratio`,
  `ava-min-quorum-unanimous-stake-ratio`, `ava-min-avaproofs-node-count`,
  `avalanche-conflicting-proof-cooldown`,
  `avaproof-stake-utxo-confirmations`,
  `avaproof-stake-utxo-dust-threshold`, `persist-avapeers`.
- Policies and pre-consensus (full nodes): `enable-miner-fund`,
  `avalanche-staking-rewards`, `avalanche-staking-preconsensus`,
  `avalanche-preconsensus`, `avalanche-preconsensus-mining`, `enable-rtt`,
  `persist-recent-headers-time`.
- Staking (full nodes): `ava-proof`, `ava-master-key`, `ava-delegation`,
  `ava-session-key`.

An SPV node reads the first group, except `ava-cooldown` and
`persist-avapeers`, and from the second only `avalanche-preconsensus` and
`avalanche-staking-rewards`.

## Miner Options

- `coinbase-flags`: Text to put in the coinbase (default: mined by bcash).
- `coinbase-address`: Payout addresses, one picked at random for each block
  (comma-separated).
- `preverify`: Verify each block template before handing it out (default:
  false).
- `max-size`: Max size of a mined block, in bytes (default: 32000000).
- `reserved-size`: Bytes reserved for the coinbase (default: 1000).
- `reserved-sigops`: Sigops reserved for the coinbase (default: 100).

## HTTP Options

These configure the node's HTTP and JSON-RPC server.

- `http-host`: HTTP host to listen on (default: 127.0.0.1).
- `http-port`: HTTP port to listen on (default: 8332 on mainnet, 18332 on
  testnet, 48332 on regtest).
- `ssl`: Serve HTTPS (default: false).
- `ssl-cert`: Path to the SSL certificate (default: `cert.pem` in the
  prefix).
- `ssl-key`: Path to the SSL key (default: `key.pem` in the prefix).
- `api-key`: API key for all node APIs. It may differ from the wallet's.
  If it isn't set, the node makes a random one at each start and doesn't
  show it, so on a host other than 127.0.0.1 or ::1 set either this or
  `no-auth`.
- `no-auth`: Disable API key authentication, to serve a fully public node
  (default: false, but true when no `api-key` is set and `http-host` is
  127.0.0.1 or ::1).
- `cors`: Enable "Cross-Origin Resource Sharing" HTTP headers (default:
  false).

Note: For security, `cors` should not be used with `no-auth`. If you enable
it, also set `api-key`, and turn on `wallet-auth` for the wallet.

## Wallet Options

The wallet that runs inside the node reads its options from `wallet.conf`.
On the command line and in the environment, the same options work with a
`wallet-` prefix: `--wallet-http-port=8334` or `BCASH_WALLET_HTTP_PORT=8334`.
Wallet options in `bcash.conf` are not read. (See the
[CHANGELOG](../CHANGELOG.md#configuration-changes).)

For example, to run a node and wallet on a remote server that you can reach
from a local machine:

```
bcash --network=testnet --http-host=0.0.0.0 --api-key=hunter2 \
  --wallet-http-host=0.0.0.0 --wallet-api-key=hunter2 --wallet-wallet-auth=true
```

`bwallet` runs the wallet as a process of its own (see
[Standalone Wallet: Reaching the Node](#standalone-wallet-reaching-the-node)).
It reads `wallet.conf`, and takes the same options without the prefix.

### Wallet Database

- `memory`: Keep the database in memory rather than write it to disk
  (default: the node's `memory`).
- `max-files`: Max open files for LevelDB (default: 64).
- `cache-size`: Size (in MB) of the LevelDB cache and write buffer
  (default: 16).
- `wipe-no-really`: Delete the wallet database's wallet data on startup
  (default: false). As the name says, only if you mean it.

### Wallet HTTP Server

- `http-host`: HTTP host to listen on (default: 127.0.0.1).
- `http-port`: HTTP port to listen on (default: 8334 on mainnet, 18334 on
  testnet, 48334 on regtest).
- `ssl`: Serve HTTPS (default: false).
- `ssl-key`: Path to the SSL key.
- `ssl-cert`: Path to the SSL certificate.
- `api-key`: API key for all wallet APIs (default: the node's `api-key`).
  It may differ from the node's. As for the node, without it or `no-auth`
  a random key is made and every request is refused.
- `no-auth`: Disable API key authentication (default: false, but true when
  no API key is set and `http-host` is 127.0.0.1 or ::1).
- `cors`: Enable "Cross-Origin Resource Sharing" HTTP headers (default:
  false).
- `wallet-auth`: Require each wallet's token to use it (default: false).
- `admin-token`: With `wallet-auth`, the token the admin routes require, as
  64 hex characters (32 bytes). If it isn't set, the wallet makes a random
  one at each start.

### Standalone Wallet: Reaching the Node

`bwallet` connects to a node's HTTP server with these options. The wallet
inside the node doesn't need them.

- `node-url`: The node's HTTP server as a URL, in place of the options
  below.
- `node-host`: The node's HTTP host (default: localhost).
- `node-port`: The node's HTTP port (default: the network's node HTTP port,
  8332 on mainnet).
- `node-ssl`: Whether to use SSL (default: false).
- `node-api-key`: The node's API key.
- `spv`: Set it when the node is an SPV node (default: false).

## Command-Line Clients

`bcash-cli` and `bwallet-cli` are bcash's own clients, built on bcash's
HTTP client classes in `lib/client`, not on the `bclient` package. See
[CLI](CLI.md) for their commands. They read these options:

- `network`: Which network's default port to use (default: main).
- `url`: The server as a URL, in place of the host and port options.
- `http-host`: The server's host (default: localhost).
- `http-port`: The server's port (default: the network's node or wallet
  HTTP port).
- `ssl`: Whether to use SSL (default: false).
- `api-key`: The server's API key.

`bcash-cli` reads `bcash.conf`, and `bwallet-cli` reads `wallet.conf`, so
both pick up the `http-port` and `api-key` you gave the server.
`bwallet-cli` also reads `id`, the wallet to use (default: primary), and
`token`, its token when `wallet-auth` is on.

## Sample Config Files

See the [sample node config][sample-conf] and the
[sample wallet config][sample-wallet-conf] in `etc/`. They show the format
and the common options, with their defaults or typical values; copy one to
the prefix directory and edit it.

[sample-conf]: ../etc/sample.conf
[sample-wallet-conf]: ../etc/sample.wallet.conf


# Copyright

This document is published under the terms of the MIT license.
