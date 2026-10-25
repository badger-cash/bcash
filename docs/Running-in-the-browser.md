# Running in the browser

bcash's SPV node runs in a web page with no proxy. The page keeps its chain
in IndexedDB and peers with bcash full nodes over the browser's own
WebTransport. The page and the nodes are independent: serve the page from
any web server, and it finds the nodes itself.

## Finding nodes

- **Seeds.** Each network lists WebTransport seeds (`wtSeeds` in
  `lib/protocol/networks.js`), by domain name and port, as it lists DNS
  seeds. A seed serves WebTransport with a certificate for its domain,
  which the browser checks as for any site. The page asks a seed for the
  nodes it knows, and leaves it.
- **Nodes.** A full node with `--wt-port` serves WebTransport with its own
  certificate, which a page pins by hash, so it needs no domain. It tells
  its peers its address, port and certificate hashes in `wtaddr`, and
  answers `getwtaddr` with the nodes it has heard of. The certificate
  lasts 13 days: the node announces the next one ahead, so a page that
  knows the node keeps up.
- **Memory.** The page keeps the nodes it learned (in localStorage), and on
  the next visit dials them first, with no seed.

## Running a node for pages

A node for pages needs the optional dependency
`@fails-components/webtransport`, and a UDP port open:

```
$ bcash --wt-port=18335 --wt-host=203.0.113.7 --bip37
```

A seed also has a domain and a certificate for it, as from Let's Encrypt,
on a second UDP port:

```
$ bcash --wt-port=18335 --wt-host=203.0.113.7 --bip37 \
  --wt-seed-port=18336 \
  --wt-seed-cert=/path/to/fullchain.pem \
  --wt-seed-key=/path/to/privkey.pem
```

See [Configuration](Configuration.md).

## The wallet

```
$ yarn install
$ yarn build-browser
```

This builds `browser/bcash-wallet.js`, the web wallet that
`browser/index.html` loads, and `browser/bcash-spv.js`, the SPV node alone,
a script exposing `bcash`, for pages of your own. Serve `index.html` and
`bcash-wallet.js` from any static web server, over HTTPS (browsers offer
WebTransport only to secure pages). The network menu beside the name
switches between mainnet and testnet in place; `?network=` picks the first
(testnet by default).

The wallet (`browser/app.js`, on `browser/wallet/`):

- **Keys**, each with a name: new recovery phrases (BIP39, 12 words; the one
  address at Cashtab's path, m/44'/1899'/0'/0/0, so a Cashtab phrase opens
  the same address) or WIF keys, and imports of either. A key belongs to no
  network: it is an ecash: address on mainnet and an ectest: one on
  testnet. Each keeps when it was made, and the block it was born at on
  each network: its scan there starts at that block, or, on a network it
  is new to, at the block made when it was.
- **Encrypted** with a password in the browser (PBKDF2 and AES-GCM), keys
  and the coins and history alike. Secrets show only with the password
  again.
- **The wallet file**: every key, phrase and birth height, encrypted with
  the password. Imported in another browser, it restores the wallet with a
  fast sync.
- **eTokens**: SLP Token Types 1 and 2, added by their genesis (its txid,
  the token id, and the height of its block, which the wallet checks it
  is in). Each token coin is checked as bcash's SLP indexer checks it,
  walking back through its parents to the genesis, those unconfirmed
  fetched from peers' mempools, so tokens, as XEC, can be spent unconfirmed.
  Sending a token spends only its own checked coins.
- **Coins** as peers relay them, then confirmed in blocks; history; sending
  XEC at 1 sat a byte, to an address typed, pasted or scanned from a QR code
  with the camera (an amount in it, `?amount=12.34`, fills in too). A coin from a transaction carrying SLP is kept apart
  and never spent as XEC, so a payment cannot burn a token.
- Its chain starts at the newest checkpoint built in, so coins a key held
  only before that block are not found yet.

In a page of your own:

``` js
const node = new bcash.SPVNode({
  network: 'testnet',
  prefix: '/bcash',
  memory: false,
  workers: false,
  webTransport: WebTransport,
  wtStore: bcash.localStore('bcash-wthosts-testnet')
});
```

`wtSeeds` overrides the network's seeds: `"host:port"` for a seed by
domain, or `{host, port, hashes}` for a node by its certificate hashes.
