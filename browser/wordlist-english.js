/*
 * The BIP39 wordlists, English only, for the wallet's bundle: the one a
 * phrase is made and read in (as Cashtab). Every other language is an
 * empty list, so finding a phrase's language still works (it tries each
 * in turn) and a phrase in another reads as not a valid one. The library
 * bundle keeps them all.
 */

'use strict';

const english = require('../lib/hd/words/english');

exports.get = function get(name) {
  return name === 'english' ? english : [];
};
