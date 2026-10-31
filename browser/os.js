/*
 * The few `os` calls bcash makes, for the browser bundle.
 */

'use strict';

exports.cpus = () => new Array(globalThis.navigator
  ? globalThis.navigator.hardwareConcurrency || 1
  : 1).fill({});

exports.homedir = () => '/';

exports.networkInterfaces = () => ({});
