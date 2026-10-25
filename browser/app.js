/*!
 * app.js - the bcash web wallet
 * Copyright (c) 2026, Vin Armani (MIT License).
 * https://github.com/badger-cash/bcash
 */

/* eslint-env browser */
/* global WebTransport */

'use strict';

/*
 * The page: a wallet on bcash's SPV node in the browser. Its keys are
 * sealed with a password (wallet/vault.js), its coins tracked from the
 * node (wallet/coins.js), payments built and signed here
 * (wallet/send.js). The node peers with bcash full nodes over
 * WebTransport, from the newest checkpoint built in.
 */

const qrcode = require('qrcode-generator');
const bcash = require('./spv');
const {Vault} = require('./wallet/vault');
const {Coins} = require('./wallet/coins');
const {buildPayment, sendPayment} = require('./wallet/send');

const params = new URLSearchParams(location.search);
const network = params.get('network') || 'testnet';
const anchor = bcash.newestCheckpoint(network);
const ticker = network === 'main' ? 'XEC' : 'tXEC';

const $ = id => document.getElementById(id);

const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class')
      node.className = value;
    else if (key.startsWith('on'))
      node.addEventListener(key.slice(2), value);
    else if (value != null && value !== false)
      node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child != null)
      node.append(child instanceof Node ? child : String(child));
  }
  return node;
};

const num = n => n.toLocaleString('en-US');

const xec = sats => (sats / 100).toLocaleString('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

// "12.34" XEC as sats, or null.
const toSats = (text) => {
  const m = /^\s*(\d{1,12})(?:\.(\d{1,2}))?\s*$/.exec(text);
  if (!m)
    return null;
  return Number(m[1]) * 100 + Number((m[2] || '').padEnd(2, '0'));
};

const short = (s, n = 8) => s.length > 2 * n + 3
  ? `${s.slice(0, n)}...${s.slice(-n)}` : s;

const explorer = txid => network === 'main'
  ? `https://explorer.e.cash/tx/${txid}`
  : `https://texplorer.bitcoinabc.org/tx/${txid}`;

const copy = async (text, button) => {
  try {
    await navigator.clipboard.writeText(text);
    const was = button.textContent;
    button.textContent = 'Copied';
    setTimeout(() => (button.textContent = was), 1200);
  } catch (e) {
    prompt('Copy:', text);
  }
};

const download = (name, text) => {
  const url = URL.createObjectURL(new Blob([text], {type: 'application/json'}));
  const a = el('a', {href: url, download: name});
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
};

/*
 * State
 */

const vault = new Vault({network, storage: localStorage});

const ui = {
  screen: vault.exists() ? 'unlock' : 'welcome',
  tab: 'wallet',
  error: null,
  notice: null,
  send: null,
  scans: new Map(),
  modal: null
};

let node = null;
let coins = null;

/*
 * Events: a log for the Node tab.
 */

const events = [];

function log(msg, cls) {
  events.unshift({time: new Date().toISOString().slice(11, 19), msg, cls});
  events.length = Math.min(events.length, 300);
  if (ui.tab === 'node')
    render();
}

/*
 * The node: started once the keys are open, so they are watched before
 * any block arrives.
 */

async function startNode() {
  node = new bcash.SPVNode({
    network,
    prefix: `/bcash/anchor-${anchor.height}`,
    anchor,
    memory: false,
    workers: false,
    logConsole: false,
    webTransport: WebTransport,
    wtStore: bcash.localStore(`bcash-wthosts-${network}`)
  });

  const {pool} = node;

  const dial = pool.options.createSocket;
  pool.options.createSocket = (port, host) => {
    const name = `${host}:${port}`;
    log(pool.wtHosts.get(name)
      ? `Dialing node ${name}, by its certificate hash.`
      : `Dialing seed ${name} by name, for the nodes it knows.`);
    return dial(port, host);
  };

  pool.on('peer open', (peer) => {
    log(`Connected to ${peer.hostname()} (${peer.agent}), its tip at`
      + ` ${num(peer.height)}.`);
  });
  pool.on('peer close', (peer, connected) => {
    if (connected)
      log(`Disconnected from ${peer.hostname()}.`);
  });
  node.on('error', err => log(`Error: ${err.message}`, 'err'));

  log(`Starting at checkpoint ${num(anchor.height)}, built into this bcash.`);
  await node.open();
  log(`Chain open at ${num(node.chain.height)}.`);

  coins = new Coins({vault, node});
  coins.on('change', () => render());
  coins.on('error', err => log(`Error: ${err.message}`, 'err'));
  coins.on('scan', (scan) => {
    if (scan.done)
      ui.scans.delete(scan.start);
    else
      ui.scans.set(scan.start, scan);
    render();
  });
  await coins.open();

  node.chain.on('connect', () => scheduleRender());
  node.chain.on('full', () => log('Synced: following the tip.'));

  await node.connect();
  node.startSync();

  // What came in while the page was closed.
  coins.catchUp().catch(err => log(`Scan: ${err.message}`, 'err'));

  // Not while a list is open: rebuilt, it would close.
  setInterval(() => {
    const active = document.activeElement;
    if (!active || active.tagName !== 'SELECT')
      render();
  }, 1000);
}

let pending = false;
function scheduleRender() {
  if (pending)
    return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    render();
  });
}

/**
 * Watch a key just added, and scan for what it holds from its birth.
 */

async function adopt({name}) {
  const key = vault.list().find(k => k.name === name);
  coins.watch(key);

  const tip = node.chain.height;
  let start = key.born;

  if (start == null || start <= anchor.height) {
    start = anchor.height + 1;
    if (key.born == null || key.born < anchor.height) {
      ui.notice = `${name}: scanning from checkpoint ${num(anchor.height)}.`
        + ' Coins it held only before that are not found yet.';
    }
  }

  if (start <= tip) {
    const entry = coins.keys.get(vault.ring(name).getKeyHash('hex'));
    coins.scan(start, [entry])
      .then(() => log(`Scan for ${name} done.`))
      .catch(err => log(`Scan for ${name}: ${err.message}`, 'err'));
  }
}

const bornNow = () => (node ? node.chain.height : anchor.height);

/*
 * Screens
 */

function render() {
  const app = $('app');
  let view;

  switch (ui.screen) {
    case 'welcome':
      view = welcome();
      break;
    case 'unlock':
      view = unlock();
      break;
    case 'first':
      view = firstKey();
      break;
    default:
      view = main();
      break;
  }

  // Keep what is being typed, and a file chosen.
  const active = document.activeElement;
  const keep = active && active.id ? {id: active.id, value: active.value,
    start: active.selectionStart} : null;
  const values = {};
  const files = {};
  for (const input of app.querySelectorAll('input, textarea')) {
    if (!input.id)
      continue;
    if (input.type === 'file')
      files[input.id] = input;
    else
      values[input.id] = input.value;
  }

  app.replaceChildren(view);

  for (const [id, value] of Object.entries(values)) {
    const input = $(id);
    if (input)
      input.value = value;
  }
  for (const [id, old] of Object.entries(files)) {
    const input = $(id);
    if (input && old.files.length > 0)
      input.replaceWith(old);
  }
  if (keep && $(keep.id)) {
    $(keep.id).focus();
    try {
      $(keep.id).setSelectionRange(keep.start, keep.start);
    } catch (e) {
      ;
    }
  }

  if (ui.modal)
    app.append(ui.modal());
}

const error = () => ui.error
  ? el('p', {class: 'error'}, ui.error) : null;

const busy = async (fn) => {
  ui.error = null;
  try {
    await fn();
  } catch (e) {
    ui.error = e.message;
  }
  render();
};

function welcome() {
  return el('div', {class: 'card narrow'},
    el('h1', {}, 'bcash wallet'),
    el('p', {class: 'muted'},
      `An eCash wallet in your browser, on ${network}. It syncs from bcash`
      + ' nodes over WebTransport and checks everything itself: no server'
      + ' holds your keys or sees your addresses.'),
    el('label', {for: 'pw1'}, 'Choose a password'),
    el('input', {id: 'pw1', type: 'password', autocomplete: 'new-password'}),
    el('label', {for: 'pw2'}, 'Again'),
    el('input', {id: 'pw2', type: 'password', autocomplete: 'new-password'}),
    el('p', {class: 'muted small'},
      'It encrypts your keys in this browser. It cannot be recovered: back'
      + ' up your recovery phrase or wallet file.'),
    error(),
    el('button', {class: 'primary', onclick: () => busy(async () => {
      if ($('pw1').value !== $('pw2').value)
        throw new Error('The passwords differ.');
      await vault.create($('pw1').value);
      ui.screen = 'first';
    })}, 'Create wallet'));
}

function unlock() {
  return el('div', {class: 'card narrow'},
    el('h1', {}, 'bcash wallet'),
    el('p', {class: 'muted'}, `Unlock your ${network} wallet.`),
    el('label', {for: 'pw'}, 'Password'),
    el('input', {id: 'pw', type: 'password', autocomplete: 'current-password',
      onkeydown: e => e.key === 'Enter' && $('unlock').click()}),
    error(),
    el('button', {
      id: 'unlock',
      class: 'primary',
      onclick: () => busy(async () => {
        // Deriving the key takes a moment.
        $('unlock').textContent = 'Unlocking...';
        await vault.unlock($('pw').value);
        ui.screen = vault.list().length > 0 ? 'main' : 'first';
        if (ui.screen === 'main')
          await startNode();
      })
    }, 'Unlock'),
    el('details', {class: 'small'},
      el('summary', {}, 'Forgot the password?'),
      el('p', {class: 'muted'},
        'Erase this wallet from the browser, then import your recovery'
        + ' phrase, keys or wallet file again. Type ERASE to confirm.'),
      el('input', {id: 'erase'}),
      el('button', {class: 'danger', onclick: () => {
        if ($('erase').value !== 'ERASE')
          return;
        vault.destroy();
        ui.screen = 'welcome';
        render();
      }}, 'Erase wallet')));
}

function firstKey() {
  return el('div', {class: 'card narrow'},
    el('h1', {}, 'Your first key'),
    el('p', {class: 'muted'}, 'Make a new recovery phrase, or bring a key'
      + ' you have.'),
    el('button', {class: 'primary', onclick: () => busy(async () => {
      // Born at the anchor, where this page's chain starts: it can hold
      // nothing older.
      const made = await vault.newPhrase('Main', anchor.height);
      ui.screen = 'main';
      await startNode();
      showPhrase(made);
    })}, 'New recovery phrase'),
    el('hr'),
    importForm(async (key) => {
      ui.screen = 'main';
      await startNode();
      if (key)
        await adopt(key);
    }));
}

/**
 * Importing: a phrase or WIF as text, or a wallet file.
 */

function importForm(done) {
  return el('div', {},
    el('h2', {}, 'Import'),
    el('label', {for: 'imp-text'}, 'Recovery phrase or private key (WIF)'),
    el('textarea', {id: 'imp-text', rows: 3, autocomplete: 'off',
      spellcheck: 'false'}),
    el('div', {class: 'row'},
      el('div', {},
        el('label', {for: 'imp-name'}, 'Name'),
        el('input', {id: 'imp-name', placeholder: 'optional'})),
      el('div', {},
        el('label', {for: 'imp-born'}, 'Made at block'),
        el('input', {id: 'imp-born', placeholder: 'optional',
          inputmode: 'numeric'}))),
    el('p', {class: 'muted small'},
      'The block height it was made at, if you know it, makes the scan'
      + ' for its coins faster.'),
    el('button', {onclick: () => busy(async () => {
      const born = $('imp-born').value.trim();
      if (born && !/^\d+$/.test(born))
        throw new Error('The block height is a number.');
      const key = await vault.importText($('imp-text').value,
        $('imp-name').value || null, born ? Number(born) : null);
      for (const id of ['imp-text', 'imp-name', 'imp-born'])
        $(id).value = '';
      await done(key);
    })}, 'Import key'),
    el('h2', {}, 'Or a wallet file'),
    el('input', {id: 'imp-file', type: 'file',
      accept: '.json,application/json'}),
    el('label', {for: 'imp-file-pw'}, 'Its password'),
    el('input', {id: 'imp-file-pw', type: 'password', autocomplete: 'off'}),
    el('button', {onclick: () => busy(async () => {
      const file = $('imp-file').files[0];
      if (!file)
        throw new Error('Choose the wallet file.');
      const added = await vault.importFile(await file.text(),
        $('imp-file-pw').value);
      if (added.length === 0)
        throw new Error('Every key in that file is already here.');
      ui.notice = `Imported ${added.map(k => k.name).join(', ')}.`;
      await done(null);
      for (const key of added)
        await adopt(key);
    })}, 'Import wallet file'));
}

function showPhrase({name, phrase}) {
  ui.modal = () => el('div', {class: 'modal'},
    el('div', {class: 'card narrow'},
      el('h2', {}, `${name}: recovery phrase`),
      el('p', {class: 'muted'}, 'Write these 12 words down, in order, and'
        + ' keep them safe. Anyone with them holds the key; without them,'
        + ' a lost password loses the key.'),
      el('ol', {class: 'words'},
        ...phrase.split(' ').map(w => el('li', {}, w))),
      el('button', {class: 'primary', onclick: () => {
        ui.modal = null;
        render();
      }}, 'I have written it down')));
  render();
}

/*
 * The wallet
 */

function main() {
  const key = vault.active();
  const bal = coins ? coins.balance(key.address)
    : {confirmed: 0, unconfirmed: 0, locked: 0, immature: 0, total: 0};

  const tabs = [['wallet', 'Wallet'], ['send', 'Send'],
    ['receive', 'Receive'], ['keys', 'Keys'], ['node', 'Node']];

  let body;
  switch (ui.tab) {
    case 'send':
      body = sendTab(key, bal);
      break;
    case 'receive':
      body = receiveTab(key);
      break;
    case 'keys':
      body = keysTab();
      break;
    case 'node':
      body = nodeTab();
      break;
    default:
      body = walletTab(key);
      break;
  }

  return el('div', {class: 'shell'},
    el('header', {},
      el('div', {class: 'brand'}, 'bcash', el('span', {}, network)),
      el('select', {id: 'key-select', 'aria-label': 'Key', onchange: e => busy(
        () => vault.use(e.target.value))},
      ...vault.list().map(k => el('option', {value: k.name,
        selected: k.active}, k.name))),
      syncChip()),
    el('section', {class: 'balance'},
      el('div', {class: 'amount'}, xec(bal.total),
        el('span', {}, ` ${ticker}`)),
      el('div', {class: 'muted small'}, [
        bal.unconfirmed ? `${xec(bal.unconfirmed)} unconfirmed` : null,
        bal.immature ? `${xec(bal.immature)} maturing` : null,
        bal.locked ? `${xec(bal.locked)} in token coins, kept apart` : null
      ].filter(Boolean).join(' · ') || short(key.address, 12))),
    ui.notice ? el('p', {class: 'notice', onclick: () => {
      ui.notice = null;
      render();
    }}, ui.notice) : null,
    scanBar(),
    el('nav', {}, ...tabs.map(([id, label]) => el('button', {
      class: ui.tab === id ? 'active' : '',
      onclick: () => {
        ui.tab = id;
        ui.error = null;
        render();
      }
    }, label))),
    el('main', {}, body));
}

function syncState() {
  if (!node)
    return {text: 'Starting', cls: 'wait'};

  const {pool, chain} = node;
  let best = chain.height;
  let peers = 0;
  for (let peer = pool.peers.head(); peer; peer = peer.next) {
    if (peer.handshake) {
      peers += 1;
      best = Math.max(best, peer.height);
    }
  }

  if (peers === 0)
    return {text: 'Connecting', cls: 'wait', best};
  if (chain.synced)
    return {text: `Synced ${num(chain.height)}`, cls: 'ok', best};

  const span = best - anchor.height;
  const pct = span > 0 ? (chain.height - anchor.height) / span * 100 : 0;
  return {text: `Syncing ${pct.toFixed(0)}%`, cls: 'wait', best};
}

function syncChip() {
  const {text, cls} = syncState();
  return el('button', {class: `chip ${cls}`, onclick: () => {
    ui.tab = 'node';
    render();
  }}, text);
}

function scanBar() {
  const scans = [...ui.scans.values()];
  if (scans.length === 0)
    return null;
  const {start, end, height} = scans[0];
  const pct = end > start ? (height - start + 1) / (end - start + 1) * 100 : 0;
  return el('p', {class: 'notice'},
    `Scanning blocks ${num(start)} to ${num(end)} for coins:`
    + ` ${pct.toFixed(0)}%`);
}

function walletTab(key) {
  if (!coins)
    return el('p', {class: 'muted'}, 'Opening...');

  const history = coins.history(key.address);
  const tip = node.chain.height;

  if (history.length === 0) {
    return el('div', {class: 'empty'},
      el('p', {}, 'No transactions yet.'),
      el('p', {class: 'muted small'}, node.chain.synced
        ? 'Receive some XEC to see them here.'
        : 'Still syncing: they appear as blocks arrive.'));
  }

  return el('ul', {class: 'history'}, ...history.map((tx) => {
    const sent = tx.net < 0;
    const depth = tip - tx.height + 1;
    const status = tx.height === -1
      ? 'Unconfirmed'
      : `${num(depth)} confirmation${depth === 1 ? '' : 's'}`;
    const date = new Date(tx.time * 1000).toLocaleString();
    return el('li', {},
      el('div', {class: `icon ${sent ? 'out' : 'in'}`}, sent ? '↑' : '↓'),
      el('div', {class: 'what'},
        el('div', {}, sent ? 'Sent' : 'Received',
          tx.token ? el('span', {class: 'tag'}, 'token') : null),
        el('div', {class: 'muted small'}, `${date} · ${status}`),
        el('a', {class: 'small mono', href: explorer(tx.txid),
          target: '_blank', rel: 'noopener'}, short(tx.txid))),
      el('div', {class: `value ${sent ? 'out' : 'in'}`},
        `${sent ? '' : '+'}${xec(tx.net)}`));
  }));
}

function sendTab(key, bal) {
  if (!coins)
    return el('p', {class: 'muted'}, 'Opening...');

  const spendable = coins.spendable(key.address)
    .reduce((s, c) => s + c.value, 0);

  if (ui.send && ui.send.sent) {
    const {txid, value} = ui.send.sent;
    return el('div', {class: 'card'},
      el('h2', {}, 'Sent'),
      el('p', {}, `${xec(value)} ${ticker} is on its way.`),
      el('p', {class: 'mono small'}, txid),
      el('button', {onclick: () => {
        ui.send = null;
        ui.tab = 'wallet';
        render();
      }}, 'Done'));
  }

  if (ui.send && ui.send.review) {
    const {tx, fee, value, to} = ui.send.review;
    return el('div', {class: 'card'},
      el('h2', {}, 'Review'),
      el('dl', {},
        el('dt', {}, 'To'), el('dd', {class: 'mono'}, to),
        el('dt', {}, 'Amount'), el('dd', {}, `${xec(value)} ${ticker}`),
        el('dt', {}, 'Fee'), el('dd', {}, `${xec(fee)} ${ticker}`),
        el('dt', {}, 'Total'), el('dd', {}, `${xec(value + fee)} ${ticker}`)),
      error(),
      el('div', {class: 'row'},
        el('button', {onclick: () => {
          ui.send = null;
          render();
        }}, 'Back'),
        el('button', {class: 'primary', onclick: () => busy(async () => {
          await sendPayment({coins, node, tx});
          ui.send = {sent: {txid: tx.txid(), value}};
          log(`Sent ${xec(value)} ${ticker}: ${tx.txid()}.`);
        })}, 'Send')));
  }

  return el('div', {class: 'card'},
    el('label', {for: 'to'}, 'To'),
    el('input', {id: 'to', placeholder: network === 'main'
      ? 'ecash:...' : 'ectest:...', autocomplete: 'off', spellcheck: 'false'}),
    el('label', {for: 'amount'}, `Amount (${ticker})`),
    el('div', {class: 'row'},
      el('input', {id: 'amount', inputmode: 'decimal', placeholder: '0.00'}),
      el('button', {class: 'small-btn', onclick: () => busy(async () => {
        const built = await buildPayment({coins, ring: vault.ring(),
          address: key.address, to: $('to').value, max: true});
        ui.send = {review: {...built, to: $('to').value.trim()}};
      })}, 'Max')),
    el('p', {class: 'muted small'}, `Spendable: ${xec(spendable)} ${ticker}`
      + (bal.locked ? '. Token coins are never spent as XEC.' : '.')),
    node.chain.synced ? null : el('p', {class: 'warn small'},
      'Still syncing: the balance may not be complete yet.'),
    error(),
    el('button', {class: 'primary', onclick: () => busy(async () => {
      const value = toSats($('amount').value);
      if (!value)
        throw new Error('Enter an amount, like 12.34.');
      const built = await buildPayment({coins, ring: vault.ring(),
        address: key.address, to: $('to').value, value});
      ui.send = {review: {...built, to: $('to').value.trim()}};
    })}, 'Review'));
}

function receiveTab(key) {
  const qr = qrcode(0, 'M');
  qr.addData(key.address);
  qr.make();

  const box = el('div', {class: 'qr'});
  box.innerHTML = qr.createSvgTag({cellSize: 6, margin: 2, scalable: true});

  const button = el('button', {onclick: () => copy(key.address, button)},
    'Copy address');

  return el('div', {class: 'card center'},
    box,
    el('p', {class: 'mono address'}, key.address),
    button,
    el('p', {class: 'muted small'}, 'Payments show up as soon as peers relay'
      + ' them, then confirm in a block.'));
}

function keysTab() {
  const keys = vault.list();

  return el('div', {},
    el('ul', {class: 'keys'}, ...keys.map(k => el('li', {},
      el('div', {class: 'what'},
        el('div', {}, k.name, k.active ? el('span', {class: 'tag'}, 'in use')
          : null, el('span', {class: 'tag'}, k.type === 'mnemonic'
          ? 'phrase' : 'WIF')),
        el('div', {class: 'mono small'}, k.address),
        el('div', {class: 'muted small'}, k.born != null
          ? `Made at block ${num(k.born)}` : 'Made at: unknown')),
      el('div', {class: 'actions'},
        k.active ? null : el('button', {onclick: () => busy(
          () => vault.use(k.name))}, 'Use'),
        el('button', {onclick: () => revealKey(k)}, 'Back up'))))),
    el('div', {class: 'card'},
      el('h2', {}, 'Add a key'),
      el('div', {class: 'row'},
        el('input', {id: 'new-name', placeholder: 'Name (optional)'}),
        el('button', {onclick: () => busy(async () => {
          const made = await vault.newPhrase($('new-name').value || null,
            bornNow());
          await adopt(made);
          showPhrase(made);
        })}, 'New phrase'),
        el('button', {onclick: () => busy(async () => {
          const made = await vault.newKey($('new-name').value || null,
            bornNow());
          await adopt(made);
          ui.notice = `Made ${made.name}. Back it up from its Back up button.`;
        })}, 'New WIF key')),
      el('hr'),
      importForm(async (key) => {
        if (key) {
          ui.notice = `Imported ${key.name}.`;
          await adopt(key);
        }
      })),
    el('div', {class: 'card'},
      el('h2', {}, 'Wallet file'),
      el('p', {class: 'muted small'}, 'Every key, phrase and the block it was'
        + ' made at, encrypted with your password: import it in another'
        + ' browser to restore the wallet, with a fast sync.'),
      el('button', {onclick: () => download(`bcash-wallet-${network}.json`,
        vault.exportFile())}, 'Download wallet file'),
      el('button', {onclick: () => location.reload()}, 'Lock')),
    error());
}

function revealKey(k) {
  ui.reveal = null;
  ui.error = null;
  ui.modal = () => el('div', {class: 'modal'},
    el('div', {class: 'card narrow'},
      el('h2', {}, `Back up ${k.name}`),
      ui.reveal ? el('div', {},
        ui.reveal.phrase ? el('div', {},
          el('p', {class: 'muted small'},
            `Recovery phrase (${ui.reveal.path})`),
          el('ol', {class: 'words'},
            ...ui.reveal.phrase.split(' ').map(w => el('li', {}, w)))) : null,
        el('p', {class: 'muted small'}, 'Private key (WIF)'),
        el('p', {class: 'mono small'}, ui.reveal.wif))
        : el('div', {},
          el('label', {for: 'reveal-pw'}, 'Password'),
          el('input', {id: 'reveal-pw', type: 'password',
            autocomplete: 'current-password'}),
          error(),
          el('button', {class: 'primary', onclick: () => busy(async () => {
            ui.reveal = await vault.reveal(k.name, $('reveal-pw').value);
          })}, 'Show')),
      el('button', {onclick: () => {
        ui.modal = null;
        ui.reveal = null;
        ui.error = null;
        render();
      }}, 'Close')));
  render();
}

function nodeTab() {
  if (!node)
    return el('p', {class: 'muted'}, 'Starting...');

  const {pool, chain} = node;
  const {best} = syncState();

  const tail = pool.headerChain && pool.headerChain.tail;
  const tip = pool.headerTip;
  const headers = pool.checkpoints && tail && tip && tail.height < tip.height;

  let state = 'downloading blocks';
  if (headers)
    state = `headers to checkpoint ${num(tip.height)}: ${num(tail.height)}`;
  else if (chain.synced)
    state = 'synced';

  const rows = [];
  for (let peer = pool.peers.head(); peer; peer = peer.next) {
    rows.push(el('li', {},
      el('div', {class: 'mono small'}, peer.hostname()),
      el('div', {class: 'muted small'}, peer.handshake
        ? `${peer.agent}, ${peer === pool.peers.load ? 'syncing from' : 'open'}`
        : 'connecting')));
  }

  return el('div', {},
    el('div', {class: 'card'},
      el('dl', {},
        el('dt', {}, 'Network'), el('dd', {}, network),
        el('dt', {}, 'Height'), el('dd', {}, `${num(chain.height)}`
          + (chain.tip ? ` (block of ${new Date(chain.tip.time * 1000)
            .toISOString().slice(0, 10)})` : '')),
        el('dt', {}, 'Best known'), el('dd', {}, num(best || chain.height)),
        el('dt', {}, 'Anchor'), el('dd', {},
          `checkpoint ${num(anchor.height)}, built in`),
        el('dt', {}, 'State'), el('dd', {}, state),
        el('dt', {}, 'Nodes known'), el('dd', {}, `${pool.wtHosts.size}`),
        el('dt', {}, 'Finality'), el('dd', {},
          'not yet: confirmations only (Avalanche needs stake on bcash'
          + ' nodes reachable over WebTransport)'))),
    el('h2', {}, 'Peers'),
    el('ul', {class: 'peers'}, ...rows),
    el('h2', {}, 'Events'),
    el('pre', {class: 'log'}, ...events.map(e => el('div',
      {class: e.cls || ''}, `${e.time} ${e.msg}`))));
}

/*
 * Start
 */

window.addEventListener('beforeunload', () => {
  if (coins)
    coins.flush();
});

if (typeof WebTransport !== 'function') {
  $('app').replaceChildren(el('div', {class: 'card narrow'},
    el('h1', {}, 'bcash wallet'),
    el('p', {class: 'error'}, 'This browser has no WebTransport, or the page'
      + ' is not served over HTTPS. Try a current Chrome, Edge or Firefox.')));
} else {
  render();
}

window.wallet = {vault, get node() {
  return node;
}, get coins() {
  return coins;
}};
