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
 * sealed with a password (wallet/vault.js) and belong to no network; each
 * network has its own node, chain and coins (wallet/coins.js), and the
 * page switches between them in place. Payments are built and signed here
 * (wallet/send.js). The node peers with bcash full nodes over
 * WebTransport, from the newest checkpoint built in.
 */

const qrcode = require('qrcode-generator');
const bcash = require('./spv');
const {Vault} = require('./wallet/vault');
const {Coins} = require('./wallet/coins');
const {Tokens} = require('./wallet/tokens');
const {lookupHeight, CHRONIK} = require('./wallet/chronik');
const {buildPayment, buildTokenPayment, sendPayment, parsePaymentURI,
  toBase, toSats, fromBase} = require('./wallet/send');

const NETWORKS = [
  {id: 'main', label: 'Mainnet', ticker: 'XEC'},
  {id: 'testnet', label: 'Testnet', ticker: 'tXEC'}
];

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

const short = (s, n = 8) => s.length > 2 * n + 3
  ? `${s.slice(0, n)}...${s.slice(-n)}` : s;

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

/**
 * Read a QR code with the camera (the rear one, on a phone). On its own
 * overlay, outside the page's rendering, so the video survives it.
 * @returns {Promise} the code's text, or null if closed.
 */

// The QR code reader: its own script, fetched the first time it is used.
let reader = null;

function loadReader() {
  if (!reader) {
    reader = new Promise((resolve, reject) => {
      const script = el('script', {src: 'bcash-scan.js'});
      script.onload = () => resolve(globalThis.bcashScan);
      script.onerror = () => {
        reader = null;
        reject(new Error('Could not load the QR code reader.'));
      };
      document.head.append(script);
    });
  }
  return reader;
}

async function scanCode() {
  const jsQR = await loadReader();

  return new Promise((resolve) => {
    const video = el('video', {playsinline: true, muted: true});
    const status = el('p', {class: 'muted small'}, 'Starting the camera...');
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', {willReadFrequently: true});
    let stream = null;
    let done = false;
    let overlay = null;

    function finish(text) {
      if (done)
        return;
      done = true;
      if (stream) {
        for (const track of stream.getTracks())
          track.stop();
      }
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(text);
    }

    function onKey(e) {
      if (e.key === 'Escape')
        finish(null);
    }

    overlay = el('div', {class: 'modal scanner'},
      el('div', {class: 'card narrow center'},
        el('h2', {}, 'Scan a QR code'),
        el('div', {class: 'viewfinder'}, video),
        status,
        el('button', {onclick: () => finish(null)}, 'Cancel')));

    document.body.append(overlay);
    document.addEventListener('keydown', onKey);

    const tick = () => {
      if (done)
        return;
      if (video.readyState >= video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const image = context.getImageData(0, 0, canvas.width,
          canvas.height);
        const code = jsQR(image.data, image.width, image.height,
          {inversionAttempts: 'dontInvert'});
        if (code && code.data) {
          finish(code.data);
          return;
        }
      }
      requestAnimationFrame(tick);
    };

    navigator.mediaDevices.getUserMedia({
      video: {facingMode: {ideal: 'environment'}},
      audio: false
    }).then(async (media) => {
      stream = media;
      if (done) {
        finish(null);
        return;
      }
      video.srcObject = media;
      await video.play();
      status.textContent = 'Hold the code in the frame.';
      requestAnimationFrame(tick);
    }).catch((err) => {
      status.textContent = err.name === 'NotAllowedError'
        ? 'The camera was not allowed. Allow it for this site, or paste'
          + ' the address.'
        : `No camera: ${err.message}`;
      status.className = 'error small';
    });
  });
}

/*
 * State
 */

const vault = new Vault({storage: localStorage});

const ui = {
  screen: vault.exists() ? 'unlock' : 'welcome',
  tab: 'wallet',
  error: null,
  notice: null,
  send: null,
  scans: new Map(),
  modal: null,
  menu: null,
  reveal: null,
  switching: false,
  nodeError: null
};

const asked = new URLSearchParams(location.search).get('network');
let network = NETWORKS.some(n => n.id === asked) ? asked : 'testnet';
let anchor = bcash.newestCheckpoint(network);
let node = null;
let coins = null;
let tokens = null;

const net = () => NETWORKS.find(n => n.id === network);
let ticker = net().ticker;

const explorer = txid => network === 'main'
  ? `https://explorer.e.cash/tx/${txid}`
  : `https://texplorer.e.cash/tx/${txid}`;

/*
 * Events: a log for the Node tab, the whole session's, every network's.
 */

const events = [];
let switched = false;

function log(msg, cls) {
  events.unshift({
    time: new Date().toISOString().slice(11, 19),
    // Once both networks have spoken, each line says whose it is.
    msg: switched ? `[${net().label}] ${msg}` : msg,
    cls
  });
  if (ui.tab === 'node')
    scheduleRender();
}

/*
 * The node: one per network, started once the keys are open, so they are
 * watched before any block arrives.
 */

async function startNode() {
  ui.nodeError = null;

  const started = new bcash.SPVNode({
    network,
    prefix: `/bcash/${network}-anchor-${anchor.height}`,
    anchor,
    memory: false,
    workers: false,
    logConsole: false,
    webTransport: WebTransport,
    wtStore: bcash.localStore(`bcash-wthosts-${network}`)
  });

  const {pool} = started;

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
  started.on('error', err => log(`Error: ${err.message}`, 'err'));

  log(`${net().label}: starting at checkpoint ${num(anchor.height)}, built`
    + ' into this bcash.');

  try {
    await started.open();
  } catch (e) {
    ui.nodeError = started.network.wtSeeds.length === 0
      && pool.wtHosts.size === 0
      ? `No bcash node serves ${net().label} over WebTransport yet, so this`
        + ' wallet cannot sync it. Your keys and addresses are here.'
      : `Could not open the chain: ${e.message}`;
    log(ui.nodeError, 'err');
    return;
  }

  log(`Chain open at ${num(started.chain.height)}.`);

  const tracked = new Coins({vault, node: started});
  tracked.on('change', () => scheduleRender());
  tracked.on('error', err => log(`Error: ${err.message}`, 'err'));
  tracked.on('scan', (scan) => {
    if (scan.done)
      ui.scans.delete(scan.start);
    else
      ui.scans.set(scan.start, scan);
    scheduleRender();
  });
  await tracked.open();

  // Tokens: their coins checked as they come, and pending ones again with
  // each block.
  // Where a token's genesis is, asked of Chronik (the explorers'
  // indexer) as a hint the wallet then checks in its own block.
  const tokenState = new Tokens({
    coins: tracked,
    node: started,
    heightOf: CHRONIK[network]
      ? txid => lookupHeight(CHRONIK[network], txid) : null
  });
  const recheck = () => tokenState.checkAll()
    .catch(err => log(`Token check: ${err.message}`, 'err'));
  tokenState.on('change', () => scheduleRender());
  tokenState.on('error', err => log(`Tokens: ${err.message}`, 'err'));
  tokenState.on('walk', ({lo, hi, floor}) => {
    ui.walk = {lo, hi, floor};
    scheduleRender();
  });
  tracked.on('change', recheck);

  started.chain.on('connect', () => {
    scheduleRender();
    if (started.chain.synced)
      recheck();
  });
  started.chain.on('full', () => log('Synced: following the tip.'));

  node = started;
  coins = tracked;
  tokens = tokenState;
  recheck();

  await started.connect();
  started.startSync();

  // What came in while the page was closed, and keys new to this network.
  coins.catchUp().catch(err => log(`Scan: ${err.message}`, 'err'));
  for (const key of coins.uncovered())
    cover(key);
}

async function stopNode() {
  const [stopping, tracked] = [node, coins];
  node = null;
  coins = null;
  tokens = null;
  ui.scans.clear();
  ui.walk = null;
  ui.tokenSend = null;

  if (tracked)
    await tracked.close();
  if (stopping)
    await stopping.close().catch(() => {});
}

/**
 * Switch networks in place: the other network's node, chain and coins;
 * the same keys, as its addresses.
 */

async function switchNetwork(id) {
  if (id === network || ui.switching)
    return;

  ui.switching = true;
  ui.menu = null;
  ui.send = null;
  ui.notice = null;
  render();

  try {
    await stopNode();

    network = id;
    anchor = bcash.newestCheckpoint(network);
    ticker = net().ticker;

    const url = new URL(location.href);
    url.searchParams.set('network', network);
    history.replaceState(null, '', url);

    switched = true;
    await startNode();
  } finally {
    ui.switching = false;
    render();
  }
}

/**
 * Where a key's scan starts on this network: its birth height here, below
 * the chain's anchor too; else the block made when it was (by block
 * times); else the anchor, and the key's birth asked for.
 */

async function startFor(key) {
  if (key.born != null)
    return key.born;

  if (key.created != null) {
    const height = await heightAt(key.created / 1000 - 2 * 60 * 60);
    await vault.setBorn(key.name, network, height);
    return height;
  }

  ui.notice = `${key.name}: its first block is not known, so it is scanned`
    + ` from checkpoint ${num(anchor.height)}. For older coins, give the`
    + ' block it was made at under Keys.';
  return anchor.height + 1;
}

/**
 * Scan a key's history again, from an earlier block: its birth, found.
 */

function scanFrom(key, height) {
  const tracked = coins;
  return vault.setBorn(key.name, network, height)
    .then(() => tracked.rescan(key, height))
    .then(() => log(`Scan for ${key.name} from ${num(height)} done.`))
    .catch(err => log(`Scan for ${key.name}: ${err.message}`, 'err'));
}

/**
 * The first block at or after a time, from the chain this page holds.
 */

async function heightAt(time) {
  const {chain} = node;
  let lo = anchor.height;
  let hi = chain.height;

  if ((await chain.getEntryByHeight(hi)).time < time)
    return hi;

  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const entry = await chain.getEntryByHeight(mid);
    if (entry && entry.time < time)
      lo = mid + 1;
    else
      hi = mid;
  }

  return lo;
}

function cover(key) {
  const tracked = coins;
  startFor(key)
    .then(start => tracked.cover(key, start))
    .then(() => log(`Scan for ${key.name} done.`))
    .catch(err => log(`Scan for ${key.name}: ${err.message}`, 'err'));
}

/**
 * Watch a key just added, and scan for what it holds from its birth.
 */

function adopt({name}) {
  if (!coins)
    return;
  const key = vault.list(network).find(k => k.name === name);
  coins.watch(key);
  cover(key);
}

const bornNow = () => (node ? node.chain.height : anchor.height);

/*
 * Rendering
 */

// A render replaces the page's elements: one between a press and its
// release would swallow the click (the press and release on different
// elements). So renders wait while a pointer is down, and during sync,
// when every block asks for one, come at most four times a second.
let pressed = false;
let deferred = false;
let pending = false;

document.addEventListener('pointerdown', () => {
  pressed = true;
}, true);

for (const type of ['pointerup', 'pointercancel']) {
  document.addEventListener(type, () => {
    pressed = false;
    if (deferred) {
      deferred = false;
      // After the click this release makes, which may change the state.
      setTimeout(render, 0);
    }
  }, true);
}

function scheduleRender() {
  if (pending)
    return;
  pending = true;
  setTimeout(() => {
    pending = false;
    render();
  }, 250);
}

function render() {
  if (pressed) {
    deferred = true;
    return;
  }

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

  const root = el('div', {}, view, ui.modal ? ui.modal() : null);

  // Keep what is being typed, where, a file chosen, and how far a box with
  // its own scrollbar was scrolled.
  const scrolls = {};
  for (const box of app.querySelectorAll('[data-scroll]'))
    scrolls[box.dataset.scroll] = box.scrollTop;

  const active = document.activeElement;
  const keep = active && active.id && app.contains(active)
    ? {id: active.id, start: active.selectionStart} : null;
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

  app.replaceChildren(root);

  for (const [id, value] of Object.entries(values)) {
    const input = $(id);
    if (input && input.type !== 'file')
      input.value = value;
  }
  for (const [id, old] of Object.entries(files)) {
    const input = $(id);
    if (input && old.files.length > 0)
      input.replaceWith(old);
  }
  for (const box of app.querySelectorAll('[data-scroll]')) {
    if (scrolls[box.dataset.scroll] != null)
      box.scrollTop = scrolls[box.dataset.scroll];
  }

  if (keep && $(keep.id)) {
    $(keep.id).focus();
    try {
      $(keep.id).setSelectionRange(keep.start, keep.start);
    } catch (e) {
      ;
    }
  }
}

// Each second, for the sync state: not while a dialog or menu is open, or
// while typing.
setInterval(() => {
  if (ui.screen !== 'main' || ui.modal || ui.menu)
    return;
  const active = document.activeElement;
  if (active && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName))
    return;
  render();
}, 1000);

document.addEventListener('click', (e) => {
  if (ui.menu && !e.target.closest('.menu')) {
    ui.menu = null;
    render();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && (ui.menu || ui.modal)) {
    ui.menu = null;
    closeModal();
  }
});

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

/**
 * A small menu: a button with a caret, and its choices below.
 */

function menu(id, label, items, onselect, cls = '') {
  const open = ui.menu === id;
  return el('div', {class: `menu ${cls}`},
    el('button', {
      class: 'menu-button',
      'aria-haspopup': 'listbox',
      'aria-expanded': open ? 'true' : 'false',
      disabled: ui.switching,
      onclick: () => {
        ui.menu = open ? null : id;
        render();
      }
    }, label, el('span', {class: 'caret'}, open ? '▴' : '▾')),
    open ? el('ul', {class: 'menu-list', role: 'listbox'},
      ...items.map(item => el('li', {
        role: 'option',
        'aria-selected': item.selected ? 'true' : 'false',
        class: item.selected ? 'selected' : '',
        onclick: (e) => {
          e.stopPropagation();
          ui.menu = null;
          if (!item.selected)
            onselect(item.value);
          else
            render();
        }
      }, el('span', {}, item.label),
      item.detail ? el('span', {class: 'muted small'}, item.detail) : null,
      item.selected ? el('span', {class: 'check'}, '✓') : null))) : null);
}

function closeModal() {
  ui.modal = null;
  ui.reveal = null;
  ui.error = null;
  render();
}

/*
 * Screens
 */

function welcome() {
  return el('div', {class: 'card narrow'},
    el('h1', {}, 'bcash wallet'),
    el('p', {class: 'muted'},
      'An eCash wallet in your browser. It syncs from bcash nodes over'
      + ' WebTransport and checks everything itself: no server holds your'
      + ' keys or sees your addresses.'),
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
    el('p', {class: 'muted'}, 'Unlock your wallet.'),
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
        ui.screen = vault.list(network).length > 0 ? 'main' : 'first';
        render();
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
      const made = await vault.newPhrase('Main', {network,
        height: anchor.height});
      ui.screen = 'main';
      showPhrase(made);
      await startNode();
    })}, 'New recovery phrase'),
    el('hr'),
    importForm(async (key) => {
      ui.screen = 'main';
      render();
      await startNode();
      if (key)
        adopt(key);
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
        el('label', {for: 'imp-born'}, `Made at ${net().label} block`),
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
        $('imp-name').value || null,
        {network, height: born ? Number(born) : null});
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
      $('imp-file-pw').value = '';
      ui.notice = `Imported ${added.map(k => k.name).join(', ')}.`;
      await done(null);
      for (const key of added)
        adopt(key);
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
      el('button', {class: 'primary', onclick: closeModal},
        'I have written it down')));
  render();
}

/*
 * The wallet
 */

function main() {
  const key = vault.active(network);
  const keys = vault.list(network);
  const bal = coins ? coins.balance(key.address)
    : {confirmed: 0, unconfirmed: 0, locked: 0, immature: 0, total: 0};

  const tabs = [['wallet', 'Wallet'], ['send', 'Send'],
    ['receive', 'Receive'], ['tokens', 'eTokens'], ['keys', 'Keys'],
    ['node', 'Node']];

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
    case 'tokens':
      body = tokensTab(key);
      break;
    case 'node':
      body = nodeTab();
      break;
    default:
      body = walletTab(key);
      break;
  }

  const keyLabel = keys.length > 1
    ? menu('key', key.name, keys.map(k => ({
      value: k.name,
      label: k.name,
      detail: short(k.address.split(':')[1], 5),
      selected: k.active
    })), name => busy(() => vault.use(name)), 'key-menu')
    : el('div', {class: 'key-name'}, key.name);

  return el('div', {class: 'shell'},
    el('header', {},
      el('div', {class: 'brand'}, 'bcash'),
      menu('network', net().label.toUpperCase(), NETWORKS.map(n => ({
        value: n.id,
        label: n.label,
        selected: n.id === network
      })), id => switchNetwork(id), 'network-menu'),
      el('div', {class: 'spacer'}),
      syncChip()),
    el('section', {class: 'balance'},
      keyLabel,
      el('div', {class: 'amount'}, xec(bal.total),
        el('span', {}, ` ${ticker}`)),
      el('div', {class: 'muted small'}, [
        scanProgress() ? 'incomplete: history being scanned' : null,
        bal.unconfirmed ? `${xec(bal.unconfirmed)} unconfirmed` : null,
        bal.immature ? `${xec(bal.immature)} maturing` : null,
        bal.locked ? `${xec(bal.locked)} in token coins, kept apart` : null
      ].filter(Boolean).join(' · ') || short(key.address, 12))),
    ui.switching ? el('p', {class: 'notice'},
      `Switching to ${net().label}...`) : null,
    ui.nodeError ? el('p', {class: 'notice warn'}, ui.nodeError) : null,
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
  if (ui.switching)
    return {text: 'Switching', cls: 'wait'};
  if (ui.nodeError)
    return {text: 'No node', cls: 'bad'};
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
  // The chain's own flag goes by the tip's time: at the peers' height too.
  if (chain.synced && chain.height >= best) {
    // The chain at the tip, its history still scanned for coins.
    const scan = scanProgress();
    if (scan)
      return {text: `Scanning ${scan.pct.toFixed(0)}%`, cls: 'wait', best};
    return {text: `Synced ${num(chain.height)}`, cls: 'ok', best};
  }

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

// The share of a coin scan done, or null with none running.
function scanProgress() {
  const scans = [...ui.scans.values()];
  if (scans.length === 0)
    return null;
  const {start, end, height} = scans[0];
  const pct = end > start ? (height - start + 1) / (end - start + 1) * 100 : 0;
  return {start, end, pct: Math.max(0, pct)};
}

function scanBar() {
  const scan = scanProgress();
  if (!scan)
    return null;
  const {start, end, pct} = scan;
  if (coins && coins.rebuilding) {
    return el('p', {class: 'notice'},
      'Rebuilding this wallet\'s coin history, once: a fix to how spends'
      + ' are counted needs each key\'s history scanned again. Blocks'
      + ` ${num(start)} to ${num(end)}: ${pct.toFixed(0)}%. Keys and`
      + ' tokens are kept; the balance fills in as it goes.');
  }
  return el('p', {class: 'notice'},
    `Scanning blocks ${num(start)} to ${num(end)} for coins:`
    + ` ${pct.toFixed(0)}%. The balance fills in as it goes.`);
}

const unavailable = () => el('div', {class: 'empty'},
  el('p', {}, ui.nodeError ? 'Not syncing.' : 'Opening...'),
  ui.nodeError ? el('p', {class: 'muted small'}, ui.nodeError) : null);

function walletTab(key) {
  if (!coins)
    return unavailable();

  const history = coins.history(key.address);
  const tip = node.chain.height;

  if (history.length === 0) {
    return el('div', {class: 'empty'},
      el('p', {}, 'No transactions yet.'),
      el('p', {class: 'muted small'}, node.chain.synced
        ? `Receive some ${ticker} to see them here.`
        : 'Still syncing: they appear as blocks arrive.'));
  }

  const moved = tokens ? tokens.movements(key.address) : new Map();

  return el('ul', {class: 'history'}, ...history.map((tx) => {
    const depth = tip - tx.height + 1;
    const status = tx.height === -1
      ? 'Unconfirmed'
      : `${num(depth)} confirmation${depth === 1 ? '' : 's'}`;
    const date = new Date(tx.time * 1000).toLocaleString();

    // A known token moved: the row is its, the XEC beside it the dust.
    const movement = (moved.get(tx.txid) || []).find(m => m.net !== 0n);
    const known = movement && movement.token;
    const sent = known ? movement.net < 0n : tx.net < 0;

    let label = sent ? 'Sent' : 'Received';
    let value = `${sent ? '' : '+'}${xec(tx.net)}`;
    let detail = null;
    const tags = [];

    if (known) {
      const {decimals} = movement.token;
      const name = tokenName(movement.token);
      label = `${sent ? 'Sent' : 'Received'} ${name}`;
      value = `${sent ? '-' : '+'}${fromBase(sent ? -movement.net
        : movement.net, decimals)} ${name}`;
      detail = `${tx.net < 0 ? '' : '+'}${xec(tx.net)} ${ticker}`;
      if (movement.status === 'invalid')
        tags.push('invalid');
      else if (movement.status === 'pending')
        tags.push('checking');
    } else if (tx.token) {
      tags.push(movement ? 'unknown token' : 'token');
    }

    return el('li', {},
      el('div', {class: `icon ${sent ? 'out' : 'in'}`}, sent ? '↑' : '↓'),
      el('div', {class: 'what'},
        el('div', {}, label,
          ...tags.map(t => el('span', {class: 'tag'}, t))),
        el('div', {class: 'muted small'}, `${date} · ${status}`),
        el('a', {class: 'small mono', href: explorer(tx.txid),
          target: '_blank', rel: 'noopener'}, short(tx.txid))),
      el('div', {class: 'actions'},
        el('div', {class: `value ${sent ? 'out' : 'in'}`}, value),
        detail ? el('div', {class: 'muted small right'}, detail) : null));
  }));
}

function sendTab(key, bal) {
  if (!coins)
    return unavailable();

  const spendable = coins.spendable(key.address)
    .reduce((s, c) => s + c.value, 0);

  if (ui.send && ui.send.broadcasting) {
    const {value, to} = ui.send.broadcasting;
    return el('div', {class: 'card center'},
      el('div', {class: 'spinner', 'aria-hidden': 'true'}),
      el('h2', {}, 'Broadcasting'),
      el('p', {}, `Sending ${xec(value)} ${ticker} to peers.`),
      el('p', {class: 'muted small'}, `To ${short(to, 12)}. Signed here;`
        + ' waiting for a peer to take it.'));
  }

  if (ui.send && ui.send.sent) {
    const {txid, value} = ui.send.sent;
    return el('div', {class: 'card'},
      el('h2', {}, 'Sent'),
      el('p', {}, `${xec(value)} ${ticker} is on its way.`),
      el('a', {class: 'mono small txid', href: explorer(txid),
        target: '_blank', rel: 'noopener'}, txid),
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
        el('dt', {class: 'full'}, 'To'),
        el('dd', {class: 'mono one-line'}, to),
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
          // At once: what is happening, while peers take it.
          ui.send = {broadcasting: {value, to}};
          render();
          try {
            await sendPayment({coins, node, tx});
          } catch (e) {
            ui.send = {review: {tx, fee, value, to}};
            throw e;
          }
          ui.send = {sent: {txid: tx.txid(), value}};
          log(`Sent ${xec(value)} ${ticker}: ${tx.txid()}.`);
        })}, 'Send')));
  }

  const scan = () => busy(async () => {
    const text = await scanCode();
    if (text == null)
      return;
    const {address, value} = parsePaymentURI(text, network);
    $('to').value = address;
    if (value != null)
      $('amount').value = xec(value).replace(/,/g, '');
  });

  return el('div', {class: 'card'},
    el('label', {for: 'to'}, 'To'),
    el('div', {class: 'row'},
      el('input', {id: 'to', placeholder: network === 'main'
        ? 'ecash:...' : 'ectest:...', autocomplete: 'off',
      spellcheck: 'false'}),
      navigator.mediaDevices && navigator.mediaDevices.getUserMedia
        ? qrButton(scan) : null),
    el('label', {for: 'amount'}, `Amount (${ticker})`),
    el('div', {class: 'row'},
      el('input', {id: 'amount', inputmode: 'decimal', placeholder: '0.00'}),
      el('button', {onclick: () => busy(async () => {
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

/*
 * eTokens
 */

function tokenName(token) {
  if (!token)
    return 'unknown';
  return token.ticker || token.name || short(token.tokenId, 6);
}

function tokensTab(key) {
  if (!coins || !tokens)
    return unavailable();

  if (ui.tokenSend)
    return tokenSendView(key);

  const entries = tokens.balances(key.address);
  const added = tokens.list();

  const rows = [];

  for (const token of added) {
    const entry = entries.find(e => e.tokenId === token.tokenId)
      || {valid: 0n, pending: 0n, invalid: 0n};
    const notes = [
      entry.pending ? `${fromBase(entry.pending, token.decimals)} being`
        + ' checked' : null,
      entry.invalid ? `${fromBase(entry.invalid, token.decimals)} invalid`
        + ' (not counted)' : null
    ].filter(Boolean).join(' · ');

    rows.push(el('li', {},
      el('div', {class: 'icon in'}, (token.ticker || '?').slice(0, 1)),
      el('div', {class: 'what'},
        el('div', {}, tokenName(token), el('span', {class: 'tag'},
          `Type ${token.version}`)),
        el('div', {class: 'muted small'}, token.name || ''),
        notes ? el('div', {class: 'muted small'}, notes) : null),
      el('div', {class: 'actions'},
        el('div', {class: 'value'}, fromBase(entry.valid, token.decimals)),
        entry.valid > 0n ? el('button', {onclick: () => {
          ui.tokenSend = {tokenId: token.tokenId};
          ui.error = null;
          render();
        }}, 'Send') : null)));
  }

  for (const entry of entries) {
    if (entry.tokenId && tokens.get(entry.tokenId))
      continue;
    rows.push(el('li', {},
      el('div', {class: 'icon'}, '?'),
      el('div', {class: 'what'},
        el('div', {}, entry.tokenId ? 'Unknown token' : 'Unsupported token'),
        el('div', {class: 'mono small'}, entry.tokenId
          ? short(entry.tokenId, 10) : 'a token type this wallet does not'
            + ' read'),
        el('div', {class: 'muted small'}, `${entry.coins} coin`
          + `${entry.coins === 1 ? '' : 's'}, kept apart`),
        entry.tokenId ? el('div', {class: 'muted small'},
          lookupText(tokens.lookups.get(entry.tokenId))) : null),
      entry.tokenId ? el('div', {class: 'actions'},
        el('button', {onclick: () => {
          $('token-id').value = entry.tokenId;
          $('token-height').focus();
        }}, 'Add')) : null));
  }

  const walk = ui.walk && tokens.checking
    ? el('p', {class: 'notice'}, 'Checking token coins: blocks'
      + ` ${num(ui.walk.lo)} to ${num(ui.walk.hi)} (down to the genesis,`
      + ` ${num(ui.walk.floor)}).`) : null;

  return el('div', {},
    walk,
    rows.length > 0 ? el('ul', {class: 'history'}, ...rows)
      : el('div', {class: 'empty'},
        el('p', {}, 'No tokens yet.'),
        el('p', {class: 'muted small'}, 'Add a token to see and send it.')),
    el('div', {class: 'card'},
      el('h2', {}, 'Add a token'),
      el('p', {class: 'muted small'}, 'By its genesis: the token id (the'
        + ' genesis txid) and the block it is in. The wallet checks the'
        + ' genesis is in that block, and every coin back to it.'),
      el('label', {for: 'token-id'}, 'Token id'),
      el('input', {id: 'token-id', autocomplete: 'off', spellcheck: 'false',
        class: 'mono'}),
      el('label', {for: 'token-height'}, 'Genesis block height'),
      el('input', {id: 'token-height', inputmode: 'numeric'}),
      error(),
      el('button', {class: 'primary', onclick: () => busy(async () => {
        const height = $('token-height').value.trim();
        if (!/^\d+$/.test(height))
          throw new Error('The block height is a number.');
        const token = await tokens.add($('token-id').value, Number(height));
        $('token-id').value = '';
        $('token-height').value = '';
        ui.notice = `Added ${tokenName(token)}.`;
      })}, 'Add token')));
}

function lookupText(lookup) {
  if (!lookup)
    return 'Looking for its genesis...';
  switch (lookup.state) {
    case 'looking':
      return 'Looking for its genesis...';
    case 'found':
      return `Its genesis is at block ${num(lookup.height)}: waiting for`
        + ' the wallet to reach it.';
    case 'not found':
      return 'Not found automatically: add it by hand below.';
    case 'added':
      return 'Added.';
    default:
      return `${lookup.state[0].toUpperCase()}${lookup.state.slice(1)}`;
  }
}

function tokenSendView(key) {
  const send = ui.tokenSend;
  const token = tokens.get(send.tokenId);
  const name = tokenName(token);
  const back = () => {
    ui.tokenSend = null;
    ui.error = null;
    render();
  };

  if (send.broadcasting) {
    return el('div', {class: 'card center'},
      el('div', {class: 'spinner', 'aria-hidden': 'true'}),
      el('h2', {}, 'Broadcasting'),
      el('p', {}, `Sending ${fromBase(send.amount, token.decimals)} ${name}`
        + ' to peers.'));
  }

  if (send.sent) {
    return el('div', {class: 'card'},
      el('h2', {}, 'Sent'),
      el('p', {}, `${fromBase(send.amount, token.decimals)} ${name} is on`
        + ' its way.'),
      el('a', {class: 'mono small txid', href: explorer(send.sent),
        target: '_blank', rel: 'noopener'}, send.sent),
      el('button', {onclick: back}, 'Done'));
  }

  if (send.review) {
    const {tx, fee} = send.review;
    return el('div', {class: 'card'},
      el('h2', {}, 'Review'),
      el('dl', {},
        el('dt', {class: 'full'}, 'To'),
        el('dd', {class: 'mono one-line'}, send.to),
        el('dt', {}, 'Amount'),
        el('dd', {}, `${fromBase(send.amount, token.decimals)} ${name}`),
        el('dt', {}, 'Fee'), el('dd', {}, `${xec(fee)} ${ticker}`)),
      error(),
      el('div', {class: 'row'},
        el('button', {onclick: () => {
          send.review = null;
          render();
        }}, 'Back'),
        el('button', {class: 'primary', onclick: () => busy(async () => {
          send.broadcasting = true;
          render();
          try {
            await sendPayment({coins, node, tx});
          } finally {
            send.broadcasting = false;
          }
          send.review = null;
          send.sent = tx.txid();
          log(`Sent ${fromBase(send.amount, token.decimals)} ${name}:`
            + ` ${tx.txid()}.`);
          tokens.checkAll();
        })}, 'Send')));
  }

  const have = tokens.spendable(key.address, send.tokenId)
    .reduce((s, c) => s + BigInt(c.slp.amount), 0n);

  const scan = () => busy(async () => {
    const text = await scanCode();
    if (text == null)
      return;
    $('token-to').value = parsePaymentURI(text.split('?')[0],
      network).address;
  });

  return el('div', {class: 'card'},
    el('h2', {}, `Send ${name}`),
    el('label', {for: 'token-to'}, 'To'),
    el('div', {class: 'row'},
      el('input', {id: 'token-to', placeholder: network === 'main'
        ? 'ecash:...' : 'ectest:...', autocomplete: 'off',
      spellcheck: 'false'}),
      navigator.mediaDevices && navigator.mediaDevices.getUserMedia
        ? qrButton(scan) : null),
    el('label', {for: 'token-amount'}, `Amount (${name})`),
    el('div', {class: 'row'},
      el('input', {id: 'token-amount', inputmode: 'decimal',
        placeholder: fromBase(0n, token.decimals)}),
      el('button', {onclick: () => {
        $('token-amount').value = fromBase(have, token.decimals);
      }}, 'Max')),
    el('p', {class: 'muted small'}, `Verified: ${fromBase(have,
      token.decimals)} ${name}. The fee is paid in ${ticker}.`),
    error(),
    el('div', {class: 'row'},
      el('button', {onclick: back}, 'Cancel'),
      el('button', {class: 'primary', onclick: () => busy(async () => {
        const amount = toBase($('token-amount').value, token.decimals);
        if (!amount)
          throw new Error(`Enter an amount, with up to ${token.decimals}`
            + ' decimals.');
        const to = $('token-to').value.trim();
        const built = await buildTokenPayment({coins, tokens,
          ring: vault.ring(), address: key.address, to,
          tokenId: send.tokenId, amount});
        Object.assign(send, {review: built, amount, to});
      })}, 'Review')));
}

/**
 * The scan button: the QR code icon.
 */

function qrButton(onclick) {
  const button = el('button', {
    class: 'icon-button',
    onclick,
    title: 'Scan a QR code',
    'aria-label': 'Scan a QR code'
  });

  // Three finder squares and a few modules: the icon people know.
  button.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22"'
    + ' fill="none" stroke="currentColor" stroke-width="2"'
    + ' aria-hidden="true">'
    + '<rect x="3" y="3" width="7" height="7" rx="1"/>'
    + '<rect x="14" y="3" width="7" height="7" rx="1"/>'
    + '<rect x="3" y="14" width="7" height="7" rx="1"/>'
    + '<path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3"'
    + ' stroke-linecap="round" stroke-linejoin="round"/>'
    + '<path d="M6 6h1v1H6zM17 6h1v1h-1zM6 17h1v1H6z" fill="currentColor"/>'
    + '</svg>';

  return button;
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
  const keys = vault.list(network);

  return el('div', {},
    el('ul', {class: 'keys'}, ...keys.map(k => el('li', {},
      el('div', {class: 'what'},
        el('div', {}, k.name, k.active ? el('span', {class: 'tag'}, 'in use')
          : null, el('span', {class: 'tag'}, k.type === 'mnemonic'
          ? 'phrase' : 'WIF')),
        el('div', {class: 'mono small'}, k.address),
        el('div', {class: 'muted small'}, k.born != null
          ? `Made at ${net().label} block ${num(k.born)}`
          : `Made at: not known on ${net().label}`),
        // Imported keys: their history may reach back past what was
        // scanned.
        k.type && !k.created ? el('div', {class: 'row scan-from'},
          el('input', {id: `scan-${k.name}`, inputmode: 'numeric',
            placeholder: 'Scan earlier, from block'}),
          el('button', {onclick: () => busy(async () => {
            const height = $(`scan-${k.name}`).value.trim();
            if (!/^\d+$/.test(height))
              throw new Error('The block height is a number.');
            if (!coins)
              throw new Error('Not syncing this network.');
            if (Number(height) > node.chain.height)
              throw new Error('That block is not reached yet.');
            $(`scan-${k.name}`).value = '';
            ui.notice = `Scanning ${k.name}'s history from block`
              + ` ${num(Number(height))}.`;
            scanFrom(k, Number(height));
          })}, 'Scan')) : null),
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
            {network, height: bornNow()});
          $('new-name').value = '';
          adopt(made);
          showPhrase(made);
        })}, 'New phrase'),
        el('button', {onclick: () => busy(async () => {
          const made = await vault.newKey($('new-name').value || null,
            {network, height: bornNow()});
          $('new-name').value = '';
          adopt(made);
          ui.notice = `Made ${made.name}. Back it up from its Back up button.`;
        })}, 'New WIF key')),
      el('hr'),
      importForm(async (key) => {
        if (key) {
          ui.notice = `Imported ${key.name}.`;
          adopt(key);
        }
      })),
    el('div', {class: 'card'},
      el('h2', {}, 'Wallet file'),
      el('p', {class: 'muted small'}, 'Every key, phrase and when it was'
        + ' made, encrypted with your password, for every network: import'
        + ' it in another browser to restore the wallet, with a fast sync.'),
      el('button', {onclick: () => download('bcash-wallet.json',
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
        el('p', {class: 'muted small'}, `Private key (WIF, ${net().label})`),
        el('p', {class: 'mono small'}, ui.reveal.wif))
        : el('div', {},
          el('label', {for: 'reveal-pw'}, 'Password'),
          el('input', {id: 'reveal-pw', type: 'password',
            autocomplete: 'current-password',
            onkeydown: e => e.key === 'Enter' && $('reveal-show').click()}),
          error(),
          el('button', {id: 'reveal-show', class: 'primary',
            onclick: () => busy(async () => {
              ui.reveal = await vault.reveal(k.name, $('reveal-pw').value,
                network);
            })}, 'Show')),
      el('button', {onclick: closeModal}, 'Close')));
  render();
  $('reveal-pw').focus();
}

function nodeTab() {
  if (!node) {
    return el('div', {},
      unavailable(),
      el('h2', {}, 'Events'),
      el('pre', {class: 'log', 'data-scroll': 'log'},
        ...events.map(e => el('div',
        {class: e.cls || ''}, `${e.time} ${e.msg}`))));
  }

  const {pool, chain} = node;
  const {best} = syncState();

  const tail = pool.headerChain && pool.headerChain.tail;
  const tip = pool.headerTip;
  const headers = pool.checkpoints && tail && tip && tail.height < tip.height;

  let state = 'downloading blocks';
  const scan = scanProgress();
  if (headers)
    state = `headers to checkpoint ${num(tip.height)}: ${num(tail.height)}`;
  else if (chain.synced && scan)
    state = 'synced to the tip; scanning history for coins,'
      + ` ${scan.pct.toFixed(0)}%`;
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
        el('dt', {}, 'Network'), el('dd', {}, net().label),
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
    el('pre', {class: 'log', 'data-scroll': 'log'},
      ...events.map(e => el('div',
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

window.wallet = {
  vault,
  get network() {
    return network;
  },
  get node() {
    return node;
  },
  get coins() {
    return coins;
  }
};
