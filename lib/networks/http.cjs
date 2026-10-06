const { createRequester } = require('../markets/http.cjs');

// This requester can only read the six explicitly supported metadata endpoints.
const ENDPOINTS = new Set([
  'api.binance.com/sapi/v1/capital/config/getall',
  'api.bybit.com/v5/asset/coin/query-info',
  'www.okx.com/api/v5/asset/currencies',
  'api.bitget.com/api/v2/spot/public/coins',
  'api.gateio.ws/api/v4/spot/currencies',
  'api.upbit.com/v1/status/wallet',
]);
function createNetworkRequester(options = {}) {
  const request = createRequester({...options, allowHeaders:true});
  return (url, settings = {}) => {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password ||
        !ENDPOINTS.has(parsed.host + parsed.pathname) || (settings.method || 'GET') !== 'GET' || settings.body !== undefined) {
      throw new Error('Unsupported read-only network metadata endpoint.');
    }
    return request(url, settings);
  };
}
module.exports = {createNetworkRequester};
