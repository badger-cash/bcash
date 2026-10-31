# bcash
### Applies to: bcash v3.0.0
### Date updated: October 31, 2026

## Authors
The bcoin and bcash contributors

# Table of Contents
[SECTION I: BACKGROUND](#section-i-background)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;[Introduction](#introduction)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;[Uses](#uses)<BR>

[SECTION II: USAGE](#section-ii-usage)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;[Install](#install)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;[Documentation](#documentation)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;[Support](#support)<BR>

[SECTION III: NOTES](#section-iii-notes)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;[Disclaimer](#disclaimer)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;[Contribution and License Agreement](#contribution-and-license-agreement)<BR>
&nbsp;&nbsp;&nbsp;&nbsp;[License](#license)<BR>

[Copyright](#copyright)


# SECTION I: BACKGROUND

## Introduction

**bcash** (eCash Edition) is an alternative implementation of the eCash (XEC)
protocol, written in JavaScript for Node.js. It is a fork of
[bcoin](https://github.com/bcoin-org/bcoin) and keeps bcoin's HTTP and RPC
API, with additions for eCash.

bcash is under active development.

## Uses

- Full node
- SPV node, including one that runs inside a web page
  ([Running in the browser](docs/Running-in-the-browser.md))
- SPV+, which lets browser pages serve and relay for each other
  ([SPV+](docs/SPV-Plus.md))
- Avalanche: finality, staking and pre-consensus
  ([Avalanche](docs/Avalanche.md))
- Wallet backend (BIP44 derivation)
- Mining backend (`getblocktemplate` support)
- General-purpose eCash library

Try it in the browser: the bcash web wallet at https://webnode.badger.cash
runs a bcash SPV node in the page.

# SECTION II: USAGE

## Install

You need Node.js 18, 20 or 24, Yarn 1, git, and Python 3, `make` and a C/C++
compiler for `node-gyp`.

```
$ git clone https://github.com/badger-cash/bcash.git
$ cd bcash
$ yarn install
$ ./bin/bcash
```

`yarn install` builds the native modules (bcrypto, bdb, mrmr, n64 and
bstring) for the Node.js in use. None of them contains Python, but
`node-gyp` needs Python 3 to build them. A failed build of bstring only costs
speed, as it has a JavaScript fallback; the others stop the install.

See the [Beginner's Guide](docs/Beginner's-Guide.md) for more detail.

## Documentation

- bcash docs: [docs/](docs/README.md)
- bcoin's API reference, for the HTTP and RPC API that bcash shares with
  bcoin:
  https://github.com/bcoin-org/bcoin-org.github.io/tree/staging/api-docs-slate/source
- bcoin's docs: https://github.com/bcoin-org/bcoin/tree/master/docs

bcash has no API reference of its own yet. Where bcash and bcoin differ, the
code and the docs in this repository are the authority.

## Support

Report bugs and ask questions in the GitHub issues:
https://github.com/badger-cash/bcash/issues

# SECTION III: NOTES

## Disclaimer

bcash does not guarantee you against theft or lost funds due to bugs, mishaps,
or your own incompetence. You and you alone are responsible for securing your
money.

## Contribution and License Agreement

If you contribute code to this project, you are implicitly allowing your code
to be distributed under the MIT license. You are also implicitly verifying that
all code is your original work.

## License

- Copyright (c) 2014-2015, Fedor Indutny (MIT License).
- Copyright (c) 2014-2017, Christopher Jeffrey (MIT License).
- Copyright (c) 2018, bcash developers.

See [LICENSE](LICENSE) for more info.

# Copyright

This document is published under the terms of the MIT license.
