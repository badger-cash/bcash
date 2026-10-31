/*!
 * payment.js - bip70 payment for bcoin
 * Copyright (c) 2016-2017, Christopher Jeffrey (MIT License).
 * https://github.com/bcoin-org/bcoin
 */

'use strict';

const assert = require('bsert');
const ProtoReader = require('./utils/protoreader');
const ProtoWriter = require('./utils/protowriter');
const {setData, getData} = require('./paymentdetails').prototype;

/**
 * BIP70 Payment
 */

class Payment {
  /**
   * Create a payment.
   * @constructor
   * @param {Object?} options
   * @property {Buffer} merchantData
   * @property {Buffer[]} transactions
   * @property {Buffer[]} refundTo
   * @property {String|null} memo
   */

  constructor(options) {
    this.merchantData = null;
    this.transactions = [];
    this.refundTo = [];
    this.memo = null;

    if (options)
      this.fromOptions(options);
  }

  /**
   * Inject properties from options.
   * @private
   * @param {Object} options
   * @returns {Payment}
   */

  fromOptions(options) {
    if (options.merchantData)
      this.setData(options.merchantData);

    if (options.transactions) {
      assert(Array.isArray(options.transactions));
      for (const tx of options.transactions) {
        assert(Buffer.isBuffer(tx));
        this.transactions.push(tx);
      }
    }

    if (options.refundTo) {
      assert(Array.isArray(options.refundTo));
      for (const output of options.refundTo) {
        assert(output && typeof output === 'object');
        assert(Number.isSafeInteger(output.value) && output.value >= 0);
        assert(Buffer.isBuffer(output.script));
        this.refundTo.push(output);
      }
    }

    if (options.memo != null) {
      assert(typeof options.memo === 'string');
      this.memo = options.memo;
    }

    return this;
  }

  /**
   * Instantiate payment from options.
   * @param {Object} options
   * @returns {Payment}
   */

  static fromOptions(options) {
    return new Payment().fromOptions(options);
  }

  /**
   * Set payment details.
   * @param {Object} data
   * @param {String?} enc
   */

  setData(data, enc) {
    return setData.call(this, data, enc);
  }

  /**
   * Get payment details.
   * @param {String?} enc
   * @returns {String|Object|null}
   */

  getData(enc) {
    return getData.call(this, enc);
  }

  /**
   * Inject properties from serialized data.
   * @private
   * @param {Buffer} data
   * @returns {Payment}
   */

  fromRaw(data) {
    const br = new ProtoReader(data);

    this.merchantData = br.readFieldBytes(1, true);

    while (br.nextTag() === 2) {
      const tx = br.readFieldBytes(2);
      this.transactions.push(tx);
    }

    while (br.nextTag() === 3) {
      const op = new ProtoReader(br.readFieldBytes(3));
      const output = {
        value: op.readFieldU64(1, true),
        script: op.readFieldBytes(2, true)
      };
      this.refundTo.push(output);
    }

    this.memo = br.readFieldString(4, true);

    return this;
  }

  /**
   * Instantiate payment from serialized data.
   * @param {Buffer} data
   * @returns {Payment}
   */

  static fromRaw(data, enc) {
    if (typeof data === 'string')
      data = Buffer.from(data, enc);
    return new Payment().fromRaw(data);
  }

  /**
   * Serialize the payment (protobuf).
   * @returns {Buffer}
   */

  toRaw() {
    const bw = new ProtoWriter();

    if (this.merchantData)
      bw.writeFieldBytes(1, this.merchantData);

    for (const tx of this.transactions)
      bw.writeFieldBytes(2, tx);

    for (const output of this.refundTo) {
      const op = new ProtoWriter();
      op.writeFieldU64(1, output.value);
      op.writeFieldBytes(2, output.script);
      bw.writeFieldBytes(3, op.render());
    }

    if (this.memo != null)
      bw.writeFieldString(4, this.memo);

    return bw.render();
  }
}

/*
 * Expose
 */

module.exports = Payment;
