# Running in the browser

bcash's SPV node runs in a web page with no proxy. The page keeps its chain
in IndexedDB and peers with bcash full nodes over the browser's own
WebTransport, pinning each node's self-signed certificate by its hash.

## Full nodes for pages

A full node takes pages as peers with `--wt-port` (see
[Configuration](Configuration.md)), which needs the optional dependency
`@fails-components/webtransport`. It tells its peers its WebTransport
endpoint in `wtaddr`, and answers `getwtaddr` with the endpoints it has
heard, so a page given one node finds the rest.

## The page

```
$ yarn install
$ yarn build-browser
```

This bundles `browser/spv.js` into `browser/bcash-spv.js`, a script exposing
`bcash`. `browser/index.html` is a minimal page: serve it and the bundle
from any static web server, with a `seeds.json` beside them naming nodes to
start from:

``` json
{
  "network": "testnet",
  "seeds": [
    {"host": "203.0.113.7", "port": 18335, "hashes": ["<hex sha-256>"]}
  ]
}
```

A node's hashes, current then next, are in its log at startup ("WebTransport
listening on ..."). Its certificate lasts 13 days, so refresh the seed list
as it rotates.

In a page of your own, the node is `bcash.SPVNode` given the browser's
`WebTransport` class and the seeds:

``` js
const node = new bcash.SPVNode({
  network: 'testnet',
  prefix: '/bcash',
  memory: false,
  workers: false,
  webTransport: WebTransport,
  wtSeeds: seeds
});
```
