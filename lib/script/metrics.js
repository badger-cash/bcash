'use strict';

class Metrics {
   constructor(sigchecks) {
     this.sigchecks = sigchecks || 0;
     this.init();
   }
   init() {
     return this.sigchecks;
   }
}

module.exports = Metrics;
