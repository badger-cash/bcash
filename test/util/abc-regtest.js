'use strict';

/*
 * Run a Bitcoin ABC node on regtest, so tests can check bcash against
 * the reference implementation. Set BITCOIN_ABC_BITCOIND to its bitcoind.
 */

const assert = require('bsert');
const {spawn} = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const random = require('bcrypto/lib/random');
const hash160 = require('bcrypto/lib/hash160');
const secp256k1 = require('bcrypto/lib/secp256k1');
const KeyRing = require('../../lib/primitives/keyring');
const Outpoint = require('../../lib/primitives/outpoint');
const Script = require('../../lib/script/script');
const util = require('../../lib/utils/util');
const Proof = require('../../lib/avalanche/proof');
const {Stake} = require('../../lib/avalanche/stake');

const BITCOIND = process.env.BITCOIN_ABC_BITCOIND || null;

class ABCRegtest {
  /**
   * @param {String[]} [args] - More bitcoind arguments.
   * @param {Object} [options]
   * @param {Boolean} [options.p2p] - Listen for peers on 127.0.0.1.
   */

  constructor(args = [], options = {}) {
    assert(BITCOIND, 'BITCOIN_ABC_BITCOIND is not set.');
    this.args = args;
    this.dir = null;
    this.port = 20000 + (random.randomInt() % 20000);
    this.p2pPort = options.p2p ? this.port + 1 : null;
    this.auth = 'abc:' + random.randomBytes(16).toString('hex');
    this.proc = null;
    this.log = '';
  }

  static available() {
    return BITCOIND != null && fs.existsSync(BITCOIND);
  }

  get p2pHost() {
    assert(this.p2pPort, 'Not listening for peers.');
    return `127.0.0.1:${this.p2pPort}`;
  }

  async open(more = []) {
    if (!this.dir)
      this.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bcash-abc-'));

    const [user, password] = this.auth.split(':');

    const listen = this.p2pPort
      ? ['-listen=1', `-bind=127.0.0.1:${this.p2pPort}`]
      : ['-listen=0'];

    this.log = '';
    this.proc = spawn(BITCOIND, [
      '-regtest',
      `-datadir=${this.dir}`,
      '-server=1',
      ...listen,
      '-dnsseed=0',
      '-fixedseeds=0',
      `-rpcport=${this.port}`,
      `-rpcuser=${user}`,
      `-rpcpassword=${password}`,
      '-printtoconsole=1',
      ...this.args,
      ...more
    ]);

    this.proc.stdout.on('data', (data) => {
      this.log += data;
    });

    this.proc.stderr.on('data', (data) => {
      this.log += data;
    });

    // Wait out startup.
    for (let i = 0; i < 300; i++) {
      try {
        await this.call('getblockchaininfo');
        return;
      } catch (e) {
        if (this.proc.exitCode != null)
          throw new Error(`bitcoind exited:\n${this.log.slice(-2000)}`);
        await new Promise(r => setTimeout(r, 100));
      }
    }

    throw new Error('bitcoind did not start.');
  }

  async stop() {
    if (this.proc && this.proc.exitCode == null) {
      const exited = new Promise(r => this.proc.once('exit', r));
      this.proc.kill('SIGINT');
      await exited;
    }
  }

  /**
   * Restart on the same chain, with more arguments.
   * @param {String[]} more
   */

  async restart(more) {
    await this.stop();
    await this.open(more);
  }

  async close() {
    await this.stop();

    if (this.dir)
      fs.rmSync(this.dir, {recursive: true, force: true});

    this.dir = null;
  }

  /**
   * Make this node stake: mine coinbases to a stake key, build a proof
   * of two of them with bcash, and restart with it. Pass the node
   * -avaproofstakeutxoconfirmations=1 and a low dust threshold.
   * @returns {Promise} - Returns {proof, masterKey, stakeKey, descriptor}.
   */

  async stake() {
    const pub = key => secp256k1.publicKeyCreate(key, true);
    const wif = key => KeyRing.fromPrivate(key).toSecret('regtest');

    const masterKey = secp256k1.privateKeyGenerate();
    const stakeKey = secp256k1.privateKeyGenerate();

    const desc = `pkh(${pub(stakeKey).toString('hex')})`;
    const {descriptor} = await this.call('getdescriptorinfo', desc);
    const hashes = await this.call('generatetodescriptor', 10, descriptor);

    const stakes = [];
    for (const hash of hashes.slice(0, 2)) {
      const block = await this.call('getblock', hash, 2);
      const tx = block.tx[0];
      const stake = new Stake({
        outpoint: new Outpoint(util.fromRev(tx.txid), 0),
        // RPC amounts are in XEC, 100 satoshis each.
        amount: Math.round(tx.vout[0].value * 100),
        height: block.height,
        coinbase: true,
        pubkey: pub(stakeKey)
      });
      stakes.push({stake, key: stakeKey});
    }

    const proof = Proof.build({
      sequence: 1n,
      expiration: 0n,
      masterKey,
      payout: Script.fromPubkeyhash(hash160.digest(pub(masterKey))),
      stakes
    });

    await this.restart([
      `-avaproof=${proof.toHex()}`,
      `-avamasterkey=${wif(masterKey)}`
    ]);

    return {proof, masterKey, stakeKey, descriptor};
  }

  /**
   * Have the node register and share its own proof: it does at a new tip
   * once a node is connected to it.
   * @param {String} descriptor
   * @returns {Promise}
   */

  async shareProof(descriptor) {
    await this.call('generatetodescriptor', 1, descriptor);
    await until(async () => {
      const info = await this.call('getavalancheinfo');
      return info.local.verified;
    });
  }

  call(method, ...params) {
    const body = JSON.stringify({jsonrpc: '1.0', id: 0, method, params});

    return new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port: this.port,
        method: 'POST',
        auth: this.auth,
        headers: {'Content-Type': 'application/json'}
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          let json;
          try {
            json = JSON.parse(data);
          } catch (e) {
            reject(new Error(`${method}: HTTP ${res.statusCode}`));
            return;
          }
          if (json.error) {
            const err = new Error(`${method}: ${json.error.message}`);
            err.code = json.error.code;
            reject(err);
            return;
          }
          resolve(json.result);
        });
      });
      req.on('error', reject);
      req.end(body);
    });
  }
}

async function until(test, ms = 30000) {
  const start = Date.now();
  while (!await test()) {
    if (Date.now() - start > ms)
      throw new Error('Timed out.');
    await new Promise(r => setTimeout(r, 100));
  }
}

ABCRegtest.until = until;

module.exports = ABCRegtest;
