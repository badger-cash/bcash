/*!
 * paymentdetails.js - bip70 paymentdetails for bcoin
 * Copyright (c) 2016-2017, Christopher Jeffrey (MIT License).
 * https://github.com/bcoin-org/bcoin
 */

'use strict';

const assert = require('bsert');
const ProtoReader = require('./utils/protoreader');
const ProtoWriter = require('./utils/protowriter');

/**
 * BIP70 Payment Details
 */

class PaymentDetails {
  /**
   * Create payment details.
   * @constructor
   * @param {Object?} options
   * @property {String|null} network
   * @property {Object[]} outputs
   * @property {Number} time
   * @property {Number} expires
   * @property {String|null} memo
   * @property {String|null} paymentUrl
   * @property {Buffer|null} merchantData
   */

  constructor(options) {
    this.network = null;
    this.outputs = [];
    this.time = Math.floor(Date.now() / 1000);
    this.expires = -1;
    this.memo = null;
    this.paymentUrl = null;
    this.merchantData = null;

    if (options)
      this.fromOptions(options);
  }

  /**
   * Inject properties from options.
   * @private
   * @param {Object} options
   * @returns {PaymentDetails}
   */

  fromOptions(options) {
    if (options.network != null) {
      assert(typeof options.network === 'string');
      this.network = options.network;
    }

    if (options.outputs) {
      assert(Array.isArray(options.outputs));
      for (const output of options.outputs) {
        assert(output && typeof output === 'object');
        assert(Number.isSafeInteger(output.value) && output.value >= 0);
        assert(Buffer.isBuffer(output.script));
        this.outputs.push(output);
      }
    }

    if (options.time != null) {
      assert(Number.isSafeInteger(options.time));
      this.time = options.time;
    }

    if (options.expires != null) {
      assert(Number.isSafeInteger(options.expires));
      this.expires = options.expires;
    }

    if (options.memo != null) {
      assert(typeof options.memo === 'string');
      this.memo = options.memo;
    }

    if (options.paymentUrl != null) {
      assert(typeof options.paymentUrl === 'string');
      this.paymentUrl = options.paymentUrl;
    }

    if (options.merchantData)
      this.setData(options.merchantData);

    return this;
  }

  /**
   * Instantiate payment details from options.
   * @param {Object} options
   * @returns {PaymentDetails}
   */

  static fromOptions(options) {
    return new PaymentDetails().fromOptions(options);
  }

  /**
   * Test whether the payment is expired.
   * @returns {Boolean}
   */

  isExpired() {
    if (this.expires === -1)
      return false;
    return Math.floor(Date.now() / 1000) > this.expires;
  }

  /**
   * Set payment details.
   * @param {Object} data
   * @param {String?} enc
   */

  setData(data, enc) {
    if (data == null || Buffer.isBuffer(data)) {
      this.merchantData = data;
      return;
    }

    if (typeof data !== 'string') {
      assert(!enc || enc === 'json');
      this.merchantData = Buffer.from(JSON.stringify(data), 'utf8');
      return;
    }

    this.merchantData = Buffer.from(data, enc);
  }

  /**
   * Get payment details.
   * @param {String?} enc
   * @returns {String|Object|null}
   */

  getData(enc) {
    let data = this.merchantData;

    if (!data)
      return null;

    if (!enc)
      return data;

    if (enc === 'json') {
      data = data.toString('utf8');
      try {
        data = JSON.parse(data);
      } catch (e) {
        return null;
      }
      return data;
    }

    return data.toString(enc);
  }

  /**
   * Inject properties from serialized data.
   * @private
   * @param {Buffer} data
   * @returns {PaymentDetails}
   */

  fromRaw(data) {
    const br = new ProtoReader(data);

    this.network = br.readFieldString(1, true);

    while (br.nextTag() === 2) {
      const op = new ProtoReader(br.readFieldBytes(2));
      const output = {
        value: op.readFieldU64(1, true),
        script: op.readFieldBytes(2, true)
      };
      this.outputs.push(output);
    }

    this.time = br.readFieldU64(3);
    this.expires = br.readFieldU64(4, true);
    this.memo = br.readFieldString(5, true);
    this.paymentUrl = br.readFieldString(6, true);
    this.merchantData = br.readFieldBytes(7, true);

    return this;
  }

  /**
   * Instantiate payment details from serialized data.
   * @param {Buffer} data
   * @returns {PaymentDetails}
   */

  static fromRaw(data, enc) {
    if (typeof data === 'string')
      data = Buffer.from(data, enc);
    return new PaymentDetails().fromRaw(data);
  }

  /**
   * Serialize the payment details (protobuf).
   * @returns {Buffer}
   */

  toRaw() {
    const bw = new ProtoWriter();

    if (this.network != null)
      bw.writeFieldString(1, this.network);

    for (const output of this.outputs) {
      const op = new ProtoWriter();
      op.writeFieldU64(1, output.value);
      op.writeFieldBytes(2, output.script);
      bw.writeFieldBytes(2, op.render());
    }

    bw.writeFieldU64(3, this.time);

    if (this.expires !== -1)
      bw.writeFieldU64(4, this.expires);

    if (this.memo != null)
      bw.writeFieldString(5, this.memo);

    if (this.paymentUrl != null)
      bw.writeFieldString(6, this.paymentUrl);

    if (this.merchantData)
      bw.writeFieldString(7, this.merchantData);

    return bw.render();
  }
}

/*
 * Expose
 */

module.exports = PaymentDetails;
