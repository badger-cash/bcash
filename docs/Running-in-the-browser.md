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

## The page

```
$ yarn install
$ yarn build-browser
```

This bundles `browser/spv.js` into `browser/bcash-spv.js`, a script exposing
`bcash`. `browser/index.html` is a minimal page: serve it and the bundle
from any static web server, over HTTPS (browsers offer WebTransport only to
secure pages). `?network=` picks the network; testnet by default.

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
