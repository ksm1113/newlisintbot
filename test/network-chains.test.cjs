'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeChain, normalizeContract } = require('../lib/networks/chains.cjs');

const solana = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const bitcoin = 'bip122:000000000019d6689c085ae165831e93';
const tron = 'tron:728126428';
const evmAddress = '0xE66747a101bFF2dBA3697199DCcE5b743b454759';

test('Chain aliases join supported venue networks using exact mainnet IDs', () => {
  const rows = [
    ['binance', 'ETH', 'eip155:1'], ['bitget', 'ERC20', 'eip155:1'], ['gate', 'Ethereum', 'eip155:1'],
    ['bybit', 'ETH', 'eip155:1'], ['upbit', 'ETH', 'eip155:1'],
    ['binance', 'BSC', 'eip155:56'], ['bitget', 'BEP20', 'eip155:56'], ['gate', 'BSC/BEP20', 'eip155:56'],
    ['bybit', 'BSC', 'eip155:56'], ['bybit', 'ARBI', 'eip155:42161'],
    ['binance', 'ARBITRUM', 'eip155:42161'], ['bitget', 'ArbitrumOne', 'eip155:42161'],
    ['gate', 'ARB', 'eip155:42161'], ['bitget', 'Arbitrum One', 'eip155:42161'],
    ['gate', 'OP', 'eip155:10'], ['bybit', 'Optimism', 'eip155:10'], ['bitget', 'Base', 'eip155:8453'],
    ['gate', 'Polygon', 'eip155:137'], ['bybit', 'MATIC', 'eip155:137'],
    ['bitget', 'SOL', solana], ['gate', 'Solana', solana], ['upbit', 'SOL', solana],
    ['binance', 'BTC', bitcoin], ['upbit', 'BTC', bitcoin],
    ['bitget', 'TRC20', tron], ['gate', 'TRON', tron], ['upbit', 'TRX', tron],
  ];
  for (const [venue, network, expected] of rows) assert.equal(normalizeChain(venue, network), expected, `${venue}/${network}`);
  assert.equal(normalizeChain(' BiTgEt ', ' erc20 '), 'eip155:1');
});

test('OKX currency-network grammar resolves an exact network suffix', () => {
  const rows = [
    ['USDT-ERC20', 'eip155:1'], ['MNT-ERC20', 'eip155:1'], ['1INCH-ERC20', 'eip155:1'],
    ['USDT-TRC20', tron], ['ETH-Arbitrum One', 'eip155:42161'], ['ETH-Optimism', 'eip155:10'],
    ['ETH-Base', 'eip155:8453'], ['USDC-Polygon', 'eip155:137'], ['USDT-Solana', solana], ['BTC-Bitcoin', bitcoin],
  ];
  for (const [network, expected] of rows) assert.equal(normalizeChain('okx', network), expected, network);
  for (const value of ['USDT-ERC20-EXTRA', 'USDT-Arbitrum Nova', 'USDT-Polygon zkEVM', '-ERC20',
    'BAD_COIN-ERC20', 'USDT--ERC20', 'USDT- ERC20', 'USDT-ERC20 EXTRA']) {
    assert.equal(normalizeChain('okx', value), null, value);
  }
});

test('Unconfirmed aliases, other venues, testnets and lookalike names remain unknown', () => {
  for (const value of ['Arbitrum Nova', 'EthereumClassic', 'ETH Sepolia', 'Ethereum Mainnet testnet',
    'ERC20-new', 'New ERC20', 'Polygon zkEVM', 'opBNB', 'SOL testnet', 'eip155:1', '1', '__proto__']) {
    for (const venue of ['binance', 'bybit', 'okx', 'bitget', 'gate', 'upbit']) {
      assert.equal(normalizeChain(venue, value), null, `${venue}/${value}`);
    }
  }
  // A confirmed alias from one provider is not a global alias for every venue.
  assert.equal(normalizeChain('upbit', 'Ethereum'), null);
  assert.equal(normalizeChain('upbit', 'ERC20'), null);
  assert.equal(normalizeChain('binance', 'ARBI'), null);
  assert.equal(normalizeChain('unknown', 'ETH'), null);
  assert.equal(normalizeChain('__proto__', 'ETH'), null);
  for (const value of [undefined, null, '', 1, {}, []]) {
    assert.equal(normalizeChain(value, 'ETH'), null);
    assert.equal(normalizeChain('upbit', value), null);
  }
});

test('Contract normalization requires a full EVM address on an explicitly supported chain', () => {
  for (const chain of ['eip155:1', 'eip155:56', 'eip155:42161', 'eip155:10', 'eip155:8453', 'eip155:137']) {
    assert.equal(normalizeContract(chain, evmAddress), evmAddress.toLowerCase());
    assert.equal(normalizeContract(chain, evmAddress.toLowerCase()), evmAddress.toLowerCase());
  }
  for (const address of [undefined, null, '', ' ', 123, {}, evmAddress.slice(0, -1), `${evmAddress}a`,
    `${evmAddress.slice(0, -1)}g`, evmAddress.slice(2), `${evmAddress.slice(0, 12)}...${evmAddress.slice(-8)}`,
    ` ${evmAddress}`, `${evmAddress} `, `${evmAddress}\n`, `${evmAddress}\r`, evmAddress.replace('0x', '0X')]) {
    assert.equal(normalizeContract('eip155:1', address), null);
  }
  for (const chain of [undefined, null, '', 'ETH', 'eip155:999999', 'eip155:01', bitcoin, tron]) {
    assert.equal(normalizeContract(chain, evmAddress), null, String(chain));
  }
});

test('Solana contract normalization preserves case and validates exactly 32 decoded bytes', () => {
  const wrappedSol = 'So11111111111111111111111111111111111111112';
  const tokenProgram = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  for (const address of [wrappedSol, tokenProgram, '11111111111111111111111111111111']) {
    assert.equal(normalizeContract(solana, address), address);
    assert.equal(normalizeContract('eip155:1', address), null);
  }
  assert.notEqual(normalizeContract(solana, wrappedSol.toLowerCase()), wrappedSol);
  for (const address of ['1'.repeat(31), '1'.repeat(33), 'z'.repeat(44), '2'.repeat(45),
    wrappedSol.replace('S', '0'), wrappedSol.replace('S', 'O'), wrappedSol.replace('S', 'I'),
    wrappedSol.replace('S', 'l'), `${wrappedSol} `, ` ${wrappedSol}`, `${wrappedSol}\n`, `${wrappedSol}\r`,
    evmAddress, '', null, 123]) {
    assert.equal(normalizeContract(solana, address), null, String(address));
  }
  assert.equal(normalizeContract('solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', wrappedSol), null);
});

test('Empty contracts never imply native identity on any mapped network', () => {
  for (const chain of ['eip155:1', 'eip155:56', 'eip155:42161', 'eip155:10', 'eip155:8453', 'eip155:137', solana, bitcoin, tron]) {
    assert.equal(normalizeContract(chain, ''), null);
    assert.equal(normalizeContract(chain, null), null);
  }
});
