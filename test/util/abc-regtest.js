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

const BITCOIND = process.env.BITCOIN_ABC_BITCOIND || null;

class ABCRegtest {
  constructor(args = []) {
    assert(BITCOIND, 'BITCOIN_ABC_BITCOIND is not set.');
    this.args = args;
    this.dir = null;
    this.port = 20000 + (random.randomInt() % 20000);
    this.auth = 'abc:' + random.randomBytes(16).toString('hex');
    this.proc = null;
    this.log = '';
  }

  static available() {
    return BITCOIND != null && fs.existsSync(BITCOIND);
  }

  async open() {
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bcash-abc-'));

    const [user, password] = this.auth.split(':');

    this.proc = spawn(BITCOIND, [
      '-regtest',
      `-datadir=${this.dir}`,
      '-server=1',
      '-listen=0',
      '-dnsseed=0',
      '-fixedseeds=0',
      `-rpcport=${this.port}`,
      `-rpcuser=${user}`,
      `-rpcpassword=${password}`,
      '-printtoconsole=1',
      ...this.args
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

  async close() {
    if (this.proc && this.proc.exitCode == null) {
      const exited = new Promise(r => this.proc.once('exit', r));
      this.proc.kill('SIGINT');
      await exited;
    }

    if (this.dir)
      fs.rmSync(this.dir, {recursive: true, force: true});
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

module.exports = ABCRegtest;
