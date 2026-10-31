'use strict';

/* eslint new-cap: "off" */

const bcash = require('../..');
const assert = require('assert');

(async () => {
  const master = bcash.hd.generate();
  // Cashtab's derivation path for eCash.
  const key = master.derivePath('m/44\'/1899\'/0\'/0/0');
  const keyring = bcash.KeyRing.fromPrivate(key.privateKey);

  console.log('Address: %s', keyring.getAddress('string'));
  const cb = new bcash.MTX();

  cb.addInput({
    prevout: new bcash.Outpoint(),
    script: new bcash.Script(),
    sequence: 0xffffffff
  });

  // Send 50,000 satoshis to ourselves.
  cb.addOutput({
    address: keyring.getAddress(),
    value: 50000
  });

  // Our available coins.
  const coins = [];

  // Convert the coinbase output to a Coin
  // object and add it to our available coins.
  // In reality you might get these coins from a wallet.
  const coin = bcash.Coin.fromTX(cb, 0, -1);
  coins.push(coin);

  // Create our redeeming transaction.
  const mtx = new bcash.MTX();

  // Send 10,000 satoshis to ourself.
  mtx.addOutput({
    address: keyring.getAddress(),
    value: 10000
  });

  // Now that we've created the output, we can do some coin selection (the
  // output must be added first so we know how much money is needed and also so
  // we can accurately estimate the size for fee calculation).

  // Select coins from our array and add inputs.
  // Calculate fee and add a change output.
  await mtx.fund(coins, {
    // Use a rate of 1,000 satoshis per kB (1 satoshi
    // per byte), the relay minimum on eCash.
    // With the `fullnode` object, you can
    // use the fee estimator for this instead
    // of blindly guessing.
    rate: 1000,
    // Send the change back to ourselves.
    changeAddress: keyring.getAddress()
  });

  // Sign input 0
  mtx.sign(keyring);

  // The transaction should now verify.
  assert(mtx.verify());

  // Commit our transaction and make it immutable.
  // This turns it from an MTX into a TX.
  const tx = mtx.toTX();

  // The transaction should still verify.
  // Regular transactions require a coin
  // viewpoint to be passed in.
  assert(tx.verify(mtx.view));

  console.log(mtx);
})().catch((err) => {
  console.error(err.stack);
  process.exit(1);
});
