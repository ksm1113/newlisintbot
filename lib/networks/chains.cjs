'use strict';

// Static mainnet aliases, checked against the official sources below on 2026-10-06.
// These names identify the network only, never the coin, native asset, or token.
// New names must be added with venue-specific evidence. No global/fuzzy fallback.
//
// EVM names and numeric chain IDs:
// https://web3.okx.com/onchainos/dev-docs/home/supported-chain
// CAIP-2 namespace rules and mainnet references:
// https://namespaces.chainagnostic.org/eip155/caip2
// https://namespaces.chainagnostic.org/solana/caip2
// https://namespaces.chainagnostic.org/bip122/caip2
// https://namespaces.chainagnostic.org/tron/caip2
// Tron uses the canonical decimal reference; the historical hex form is not emitted.
const chainIds = {
  ethereum: 'eip155:1',
  bsc: 'eip155:56',
  arbitrum: 'eip155:42161',
  optimism: 'eip155:10',
  base: 'eip155:8453',
  polygon: 'eip155:137',
  solana: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  bitcoin: 'bip122:000000000019d6689c085ae165831e93',
  tron: 'tron:728126428',
};

function aliases(groups) {
  const result = new Map();
  for (const [chain, names] of Object.entries(groups)) {
    for (const name of names) {
      if (result.has(name)) throw new Error(`Duplicate chain alias: ${name}`);
      result.set(name, chainIds[chain]);
    }
  }
  return result;
}

const venueAliases = new Map([
  // Binance network/name schema and code-to-name examples:
  // https://developers.binance.com/en/docs/catalog/core-trading-wallet/api/rest-api/capital
  // https://developers.binance.com/en/docs/products/connect-2.0/on-ramp-buy-apis/2.get-crypto-networks
  // https://www.binance.com/ja/support/faq/detail/115003764971
  // https://www.binance.com/en-TR/support/faq/detail/85a1c394ac1d489fb0bfac0ef2fceafd
  ['binance', aliases({
    ethereum: ['ETH', 'ETHEREUM', 'ERC20'],
    bsc: ['BSC', 'BEP20'],
    arbitrum: ['ARBITRUM'],
    optimism: ['OPTIMISM'],
    base: ['BASE'],
    polygon: ['MATIC', 'POLYGON'],
    solana: ['SOL', 'SOLANA'],
    bitcoin: ['BTC', 'BITCOIN'],
    tron: ['TRX', 'TRON', 'TRC20'],
  })],
  // Bybit chain/chainType example (ETH/Ethereum) and published network names:
  // https://bybit-exchange.github.io/docs/v5/asset/coin-info
  // https://github.com/bybit-exchange/balance-checker/blob/main/balance-checker.py
  // https://www.bybit.com/en/learn/blockchain/how-to-use-arbitrum-bridge (Arbi = Arbitrum One)
  // https://announcements.bybit.com/en/article/bybit-to-support-optimism-op-network-upgrade-jul-08-2026--art5bca9bde1308/
  // https://www.bybit.com/common-static/cht-static/por/Bybit_PoR_Audit_2026_Mar_18.pdf
  ['bybit', aliases({
    ethereum: ['ETH', 'ETHEREUM'],
    bsc: ['BSC'],
    arbitrum: ['ARBI', 'ARBITRUM', 'ARBITRUM ONE'],
    optimism: ['OP', 'OPTIMISM'],
    base: ['BASE'],
    polygon: ['MATIC', 'POLYGON'],
    solana: ['SOL', 'SOLANA'],
    bitcoin: ['BTC', 'BITCOIN'],
    tron: ['TRX', 'TRON'],
  })],
  // Bitget coin/chain schema and official notices containing these network labels:
  // https://www.bitget.com/zh-CN/docs/catalog/classic-spot-market/classic-spot-market
  // https://www.bitget.com/support/articles/12560603777870 (ERC20/TRC20/POLYGON/OP/BSC/ARB/SOL)
  // https://www.bitget.com/support/articles/12560603838172 (BEP20/Polygon/Optimism/Base/Arbitrum One)
  ['bitget', aliases({
    ethereum: ['ETH', 'ETHEREUM', 'ERC20'],
    bsc: ['BSC', 'BEP20'],
    arbitrum: ['ARB', 'ARBITRUMONE', 'ARBITRUM ONE'],
    optimism: ['OP', 'OPTIMISM'],
    base: ['BASE'],
    polygon: ['POLYGON'],
    solana: ['SOL', 'SOLANA'],
    bitcoin: ['BTC'],
    tron: ['TRX', 'TRON', 'TRC20'],
  })],
  // Gate chains[].name uses ETH in its official response. Additional network labels:
  // https://www.gate.com/docs/developers/apiv4/en/spot/#query-all-currency-information
  // https://www.gate.com/en-us/crosschain (BSC/BEP20 and Solana)
  // https://miniapp.gate.com/announcements/article/49200 (SOL/ETH/Base/ARB/Polygon/OP)
  // https://www.gate.com/fr/announcements/article/21249/Gate.io-Supports-Transactions-Via-Polygon-MATIC-Mainnet
  // https://www.gate.com/ja/announcements/article/101849 (Optimism network / OP)
  // https://www.gate.com/tr/announcements/article/41219 (TRON/TRX)
  // https://www.gate.com/es/announcements/article/16797 (TRC20 on TRON)
  ['gate', aliases({
    ethereum: ['ETH', 'ETHEREUM', 'ERC20'],
    bsc: ['BSC', 'BEP20', 'BSC/BEP20'],
    arbitrum: ['ARB', 'ARBITRUM', 'ARBITRUM ONE'],
    optimism: ['OP', 'OPTIMISM'],
    base: ['BASE'],
    polygon: ['MATIC', 'POLYGON'],
    solana: ['SOL', 'SOLANA'],
    bitcoin: ['BTC', 'BITCOIN'],
    tron: ['TRX', 'TRON', 'TRC20'],
  })],
  // OKX chain is a structured currency-network value (e.g. USDT-ERC20).
  // https://tr.okx.com/docs-v5/en/#funding-account-rest-api-get-currencies
  // https://www.okx.com/en-us/help/how-long-does-it-take-for-a-deposit-to-be-completed
  // https://web3.okx.com/onchainos/dev-docs/home/supported-chain
  ['okx', aliases({
    ethereum: ['ETH', 'ETHEREUM', 'ERC20'],
    bsc: ['BSC', 'BEP20', 'BNB CHAIN'],
    arbitrum: ['ARBITRUM ONE'],
    optimism: ['OPTIMISM'],
    base: ['BASE'],
    polygon: ['POLYGON'],
    solana: ['SOL', 'SOLANA'],
    bitcoin: ['BTC', 'BITCOIN'],
    tron: ['TRX', 'TRON', 'TRC20'],
  })],
  // Upbit documents net_type as the network identifier, distinct from display names.
  // ETH/BTC response examples and ETH/TRX/SOL net_type examples:
  // https://docs.upbit.com/kr/reference/list-deposit-addresses
  // https://docs.upbit.com/kr/reference/get-service-status
  ['upbit', aliases({ ethereum: ['ETH'], solana: ['SOL'], bitcoin: ['BTC'], tron: ['TRX'] })],
]);

function normalizeChain(venue, networkCode) {
  if (typeof venue !== 'string' || typeof networkCode !== 'string') return null;
  const venueId = venue.trim().toLowerCase();
  const mapping = venueAliases.get(venueId);
  if (!mapping) return null;
  const code = networkCode.trim().toUpperCase();
  if (!code) return null;
  if (mapping.has(code)) return mapping.get(code);
  if (venueId === 'okx') {
    // Parse only OKX's documented currency-network grammar. The suffix itself
    // still requires an exact alias, so USDT-Arbitrum Nova cannot become One.
    const match = /^[A-Z0-9]+-([A-Z0-9 ]+)$/.exec(code);
    if (match) return mapping.get(match[1]) || null;
  }
  return null;
}

const evmChains = new Set([
  chainIds.ethereum, chainIds.bsc, chainIds.arbitrum,
  chainIds.optimism, chainIds.base, chainIds.polygon,
]);
const base58Alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const base58Values = new Map([...base58Alphabet].map((character, index) => [character, BigInt(index)]));

function validSolanaAddress(address) {
  // Solana addresses are base58 encodings of exactly 32 bytes, including any
  // leading zero bytes. Length/alphabet alone cannot reject a 33-byte value.
  // https://solana.com/docs/core/accounts
  if (address.length < 32 || address.length > 44) return false;
  let value = 0n;
  for (const character of address) {
    const digit = base58Values.get(character);
    if (digit === undefined) return false;
    value = value * 58n + digit;
  }
  let leadingZeroBytes = 0;
  while (leadingZeroBytes < address.length && address[leadingZeroBytes] === '1') leadingZeroBytes += 1;
  let nonZeroBytes = 0;
  while (value > 0n) { value >>= 8n; nonZeroBytes += 1; }
  return leadingZeroBytes + nonZeroBytes === 32;
}

function normalizeContract(chainId, address) {
  if (typeof address !== 'string' || !address) return null;
  if (evmChains.has(chainId)) {
    // Full 20-byte EVM address only. Never accept shortened display addresses.
    // https://ethereum.org/developers/docs/accounts/
    return address.length === 42 && /^0x[0-9a-fA-F]{40}$/.test(address) ? address.toLowerCase() : null;
  }
  if (chainId === chainIds.solana) return validSolanaAddress(address) ? address : null;
  // Missing CA never proves a native asset. BTC/TRON and unknown chains need
  // their own identity evidence and validators before they can be compared.
  return null;
}

module.exports = { normalizeChain, normalizeContract };
