# Running bcash in the browser

bcash can run as an SPV node inside an ordinary web page. The page connects
straight to bcash full nodes, checks the chain itself, and keeps its data in
the browser. There is no proxy server, no proxy node, and no backend: the page
is a handful of static files.

This makes two things possible:

- **A web wallet** that trusts no server with its keys or addresses. bcash
  ships one, in `browser/`. It is live at <https://webnode.badger.cash>.
- **Your own pages** built on bcash's SPV node, using `browser/bcash-spv.js`.

This guide covers how it works, how to run a node that pages can connect to,
and how to build and host the wallet.

## How it works

Browsers can't open raw TCP connections, so a page can't speak the normal
peer-to-peer protocol. Browsers do support **WebTransport**, a fast,
encrypted connection over HTTP/3 (UDP). A bcash full node started with
`--wt-port` serves the usual P2P protocol over WebTransport as well as TCP,
and the page connects to it with that.

### Finding nodes

A page has to find nodes without a server telling it where they are. It does
this in three ways:

1. **Seeds.** Each network has a short list of WebTransport seeds in
   `lib/protocol/networks.js` (`wtSeeds`), much like DNS seeds for TCP nodes.
   A seed is a node with a domain name and a normal certificate for it, such
   as one from Let's Encrypt, so the browser can check it like any website.
   The page asks a seed which nodes it knows about, then disconnects.

   | Network | Seed |
   |---|---|
   | Mainnet | `ecash.badger.cash:8336` |
   | Testnet | `webnode.badger.cash:18336` |

2. **Nodes.** Ordinary WebTransport nodes don't need a domain. Each one makes
   its own self-signed certificate, and the page trusts it by its hash
   (*certificate pinning*). Nodes share their address, port and certificate
   hashes with each other in `wtaddr` messages, and answer `getwtaddr` with
   the nodes they know, so a seed can pass them on to pages.

   Browsers accept a pinned certificate only if it lasts 14 days or less, so
   the node makes a new one every 13 days. It announces the next certificate
   before switching, so pages that already know the node keep working.

3. **Memory.** The page stores the nodes it has learned in `localStorage`.
   On the next visit it dials them directly and doesn't need a seed.

### Where the chain starts

A page doesn't download the whole chain. It starts at the newest checkpoint
built into bcash and downloads block headers from there. That is a few
thousand headers on testnet and tens of thousands on mainnet. It happens
once per browser, because the page keeps its chain in IndexedDB.

Starting from a checkpoint is what makes the page trustworthy. The page
knows that block in advance, and checks every header after it against the
one before. A page can't safely start from "the tip", because a peer could
hand it a fake one.

## Running a node for pages

A node that pages can use needs three things:

- **The WebTransport library.** This is the optional dependency
  `@fails-components/webtransport`, which `yarn install` adds wherever a
  build for your platform exists. x86-64 and ARM64 Linux both work.
- **Bloom filters** turned on (`--bip37`), because pages sync as SPV clients.
- **An open UDP port** in the firewall. WebTransport runs over UDP, so a TCP
  rule isn't enough.

```
bcash --bip37 --wt-port=18335 --wt-host=203.0.113.7
```

`--wt-host` must be the public IP address that pages will dial. The
certificate is issued for it.

To help pages connect to each other over WebRTC (see below), also give the
node a STUN port, and open it for UDP too:

```
bcash --bip37 --wt-port=18335 --wt-host=203.0.113.7 --stun-port=3478
```

Any node that serves pages introduces them to each other; the STUN port is
optional, but pages behind home routers need some STUN server to find a
path to each other.

### Running a seed

A seed is a WebTransport node that also has a domain name and a certificate
for it, served on a second UDP port:

```
bcash --bip37 --wt-port=18335 --wt-host=203.0.113.7 \
  --wt-seed-port=18336 \
  --wt-seed-cert=/path/to/fullchain.pem \
  --wt-seed-key=/path/to/privkey.pem
```

The node checks the certificate files every hour and reloads them when they
change, so renewing the certificate doesn't need a restart. With certbot, a
deploy hook can copy the renewed files to where the node can read them, for
example `/etc/letsencrypt/renewal-hooks/deploy/bcash-wt-seed`:

```sh
#!/bin/sh
set -eu
SRC=/etc/letsencrypt/live/seed.example.com
DST=/var/lib/bcash/wt-seed
install -o bcash -g bcash -m 600 "$SRC/fullchain.pem" "$DST/fullchain.pem"
install -o bcash -g bcash -m 600 "$SRC/privkey.pem" "$DST/privkey.pem"
```

To make your seed a default for everyone, add it to `wtSeeds` for its
network in `lib/protocol/networks.js`.

### Connection limits

Pages get their own inbound slots, separate from TCP peers, so a busy TCP
node never turns pages away:

| Option | Default | Limits |
|---|---|---|
| `max-inbound` | 8 | inbound TCP peers |
| `wt-max-inbound` | 64 | inbound WebTransport peers (pages) |

See [Configuration](Configuration.md) for every WebTransport option.

## The web wallet

### Building

```
yarn install
yarn build-browser
```

This writes three bundles to `browser/`, each with a Brotli (`.br`) and a
gzip (`.gz`) copy beside it:

| File | What it is | Size with Brotli |
|---|---|---|
| `bcash-wallet.js` | The web wallet that `index.html` loads | about 310 KB |
| `bcash-scan.js` | The QR code reader, loaded the first time you scan | about 27 KB |
| `bcash-spv.js` | The SPV node on its own, for your own pages | about 275 KB |

The wallet bundle includes only the English BIP39 word list. `bcash-spv.js`
includes every language.

### Hosting

Copy `index.html`, `bcash-wallet.js` and `bcash-scan.js`, with their `.br`
and `.gz` copies, to any static web server, along with the icons
(`favicon.ico`, `apple-touch-icon.png`) and the link preview image
(`share-card.jpg`). It must serve the page over **HTTPS**, because browsers
allow WebTransport only on secure pages.

Social sites need the preview image's full URL, so `index.html` names it at
`https://webnode.badger.cash/share-card.jpg`. If you host the page
elsewhere, change the `og:image` tag to your own address.

No special server is required:

- A server that sends the stored compressed files delivers about 310 KB.
  For nginx, turn on `brotli_static` and `gzip_static`; for Caddy, use
  `precompressed`.
- Most hosts and CDNs compress files on their own, with much the same
  result.
- With no compression at all, the wallet is 1.5 MB. It loads more slowly
  but works the same.

The page opens on mainnet the first time, and after that on whichever
network you last used in that browser. The network menu beside the name
switches between mainnet and testnet without reloading the page, and
`?network=testnet` (or `?network=main`) in the URL opens it on that network.

### What the wallet does

**Keys.** Make a new 12-word recovery phrase, or import a phrase or a WIF
private key. A phrase gives one address, at Cashtab's path
(`m/44'/1899'/0'/0/0`), so a Cashtab phrase opens the same address here. A
key works on every network: it is an `ecash:` address on mainnet and an
`ectest:` address on testnet.

**Encryption.** Keys, coins and history are encrypted in the browser with
your password (PBKDF2 and AES-GCM). Showing a phrase or private key asks for
the password again. The password can't be recovered, so back up your phrase
or wallet file.

**The wallet file.** Export every key and phrase, encrypted with your
password, to restore the wallet in another browser. The file records the
block each key was made at, so a restored wallet scans only from there and
syncs quickly.

**Receiving and sending XEC.** Payments show up as soon as peers relay them,
then confirm in blocks. You can spend coins before they confirm. Send to an
address that you type, paste, or scan from a QR code with the camera. If the
code includes an amount (`?amount=12.34`), it's filled in too. The fee is 1
satoshi per byte.

**eTokens (SLP Types 1 and 2).** The wallet checks every token coin itself
before you can spend it. It walks back through the coin's history, fetching
any unconfirmed parents from peers' mempools, until it reaches a point it can
trust:

- the token's genesis transaction, for coins from its initial supply;
- for Type 1, a MINT whose baton traces back to the genesis;
- for Type 2, a MINT drawing on the token's vault.

Until that check passes, a newly received token coin is locked. Unconfirmed
coins descended from coins that already passed aren't locked, so tokens can
be spent unconfirmed, just like XEC.

A token you receive is added on its own. To find its genesis transaction,
the wallet asks Chronik (the explorers' indexer) which block it's in, then
fetches that block from its own peers and checks it there. Chronik's answer
is only a hint: a wrong answer makes the check fail, but it can't make the
wallet trust anything. If Chronik can't be reached, add the token by hand,
with its token ID and the height of its genesis block.

Coins in transactions that carry SLP data are kept apart and never spent as
plain XEC, so a payment can't accidentally burn a token.

**History from before the checkpoint.** An imported key may hold coins from
before the checkpoint where the page's chain starts. The wallet still finds
them. It fetches the headers between the checkpoints built into bcash, checks
that they link up, and scans those blocks by their hashes
(`browser/wallet/history.js`). An imported key scans from the block it was
made at. If you don't know that block, it scans from the newest checkpoint,
and **Keys → Scan earlier** reaches further back.

The wallet's code is in `browser/app.js` (the interface) and
`browser/wallet/` (keys, coins, tokens, sending and history).

## Using the SPV node in your own page

Load `bcash-spv.js`, which exposes `bcash`, and start a node with the
browser's own `WebTransport`:

```js
const node = new bcash.SPVNode({
  network: 'main',
  prefix: '/bcash',
  memory: false,
  workers: false,
  webTransport: WebTransport,
  wtStore: bcash.localStore('bcash-wthosts-main')
});
```

- `prefix` names the IndexedDB database the chain is kept in, and
  `memory: false` keeps it between visits.
- `wtStore` is where the node remembers the WebTransport nodes it learns.
- `wtSeeds` replaces the network's seeds. Each entry is either
  `"host:port"`, for a seed reached by its domain, or `{host, port, hashes}`,
  for a node reached by its certificate hashes.

### Pages connecting to each other (WebRTC)

Pass the browser's `RTCPeerConnection` as `webRTC`, and the page can also
connect directly to other pages, as peers:

```js
const node = new bcash.SPVNode({
  // ...as above
  webTransport: WebTransport,
  webRTC: RTCPeerConnection
});
```

A page can't be dialed, so the full nodes introduce pages to each other:

1. **The page announces itself.** It makes a key of its own and tells the
   first full node it connects to (its *home node*) that it accepts
   connections. It does that with a short record it signs, naming its key
   and its home node. The home node adds its certificate hashes, so any
   page can reach it.
2. **The nodes spread the record.** bcash full nodes pass records to each
   other, the way they pass addresses, so a page's record reaches nodes
   far from its own.
3. **Another page dials it.** A page that hears of the record dials the
   other page's home node over WebTransport, if it isn't connected to it
   already, and sends its WebRTC offer through it, addressed to the other
   page's key. The node passes it on, and the answer back. Each message
   crosses one node, however far apart the two pages' home nodes are, and
   each is signed by its sender, so no one else can speak for a page.
4. **The pages are peers.** The data channel carries the usual P2P
   messages, and pages sync from each other (see below).

Pages also introduce pages. When two pages connect, each tells the other
who it is with a signed record; asked, a page shares the records of its
other page peers, and passes a signal on to the page peer it's addressed
to, one hop, as a node does. So a page that has lost every full node can
still meet new pages through the pages it knows, and each new link brings
it more. It keeps the STUN servers its nodes told it of, too, and goes on
using them: STUN needs no connection to the node.

A page still needs some reachable go-between on each visit, to be
introduced at all: a page can't be dialed, and STUN only tells a page its
own address. That's a full node, such as one a DApp's creator runs for its
pages.

The data channel is encrypted between the two pages (WebRTC always is),
so the introducing node can't read it. It does see the offer and answer,
and could, in principle, put itself in the middle when the connection is
made. That gives it no more power than any peer has: what it sends can
be checked like anything else from a peer.

A page keeps up to 4 WebRTC peers (`rtcMaxPeers`), counted apart from its
connections to full nodes. Some networks, such as some mobile carriers,
block the direct path WebRTC needs; pages on them still work, just
without page peers.

### Pages syncing from each other

A page with WebRTC keeps its newest blocks whole, so it can serve them to
other pages. That lets a page stay synced through its page peers when it
loses every full node.

- **The window.** A page keeps the newest 288 blocks (about 2 days, as
  BIP 159's limited nodes do), and at most 25 MB, whichever is fewer
  (`windowBlocks` and `windowBytes`). On mainnet that's about 8 MB today.
- **Getting it.** While catching up, a page fetches filtered blocks, as
  before. Blocks within 288 of the best height its nodes report, it fetches
  whole and filters itself; it checks each one against its header before
  keeping it. So nothing is downloaded twice. After a reload, the window
  is empty (it lives in memory for now), and the page fetches it again
  from its full node, newest first.
- **Serving it.** A page answers its page peers' requests for headers and
  for blocks, whole or filtered for them, from what it holds, and tells
  them each new block. It also tells them the range of heights it holds
  (`blockrange`).
- **Syncing from a page.** A page with no full node to sync from syncs from
  a page peer that holds blocks, and keeps the blocks it gets, in turn, for
  its own page peers.

- **Unconfirmed transactions.** Once synced, a page asks its peers for
  every unconfirmed transaction, with a filter that matches anything, and
  keeps them (up to 5 MB, for an hour, or until a block confirms them) to
  pass on: to its page peers whose filters match them, and to its full
  nodes. So a page with no full node still hears of payments to it, and
  its own payments still reach a full node, through another page. A page
  has no coins to check a transaction against, so it checks only that one
  is well formed; full nodes check the rest, and the wallet shows a
  payment as pending until a block confirms it.
- **Privacy.** A page's own filter stays in the page once it is synced:
  its peers see a filter matching everything, so they can't tell which
  addresses are its. While catching up, it still uses its own filter.

Blocks still come from full nodes: at least one page in a group of
connected pages needs a full node, or none of them see new blocks. A page
can only catch up through pages as far back as their windows reach.

On mainnet, syncing two weeks of blocks this way took about 8 seconds and
9 MB, against about 6.5 seconds and 0.4 MB with filtered blocks alone; the
difference is the window the page ends up holding.
