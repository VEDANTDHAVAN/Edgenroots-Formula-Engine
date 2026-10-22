const Decimal = require('decimal.js'); 

Decimal.set({ precision: 30, rounding: Decimal.ROUND_HALF_UP });

const round = (value) => new Decimal(value).toDecimalPlaces(2).toNumber();

module.exports = { round };