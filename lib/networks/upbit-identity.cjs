'use strict';

const { normalizeContract } = require('./chains.cjs');
const ETHEREUM = 'eip155:1';
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PURPOSE = 'LISTED_ASSET_NETWORK_AND_FULL_CA';

function fail(code, message) {
  const error = new Error(`Upbit identity ${message}`);
  error.code = code;
  return error;
}
function noticeSource(input) {
  if (typeof input !== 'string' || input.length > 4096 || /[\s\x00-\x1f\x7f]/.test(input)) return null;
  let url;
  try { url = new URL(input); } catch { return null; }
  if (url.protocol !== 'https:' || !['upbit.com', 'www.upbit.com'].includes(url.hostname) ||
      url.username || url.password || url.port || url.hash || url.pathname !== '/service_center/notice') return null;
  const ids = url.searchParams.getAll('id');
  if (ids.length !== 1 || !/^\d{1,32}$/.test(ids[0])) return null;
  for (const key of url.searchParams.keys()) {
    if (key !== 'id' && key !== 'view' && !/^utm_[a-z0-9_]+$/.test(key)) return null;
    if (url.searchParams.getAll(key).length !== 1) return null;
  }
  const id = ids[0];
  return { id, url: `${url.origin}/service_center/notice?id=${id}`,
    endpoint: `https://pub-info.upbit.com/api/v1/announcements/${id}` };
}
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function responseData(body, id) {
  if (!object(body) || typeof body.success !== 'boolean') throw fail('INVALID_RESPONSE', 'response schema invalid.');
  if (body.success !== true) throw fail('API_ERROR', 'API returned an error.');
  const data = body.data;
  if (!object(data) || !['string', 'number'].includes(typeof data.uuid) ||
      typeof data.title !== 'string' || !data.title.trim() || data.title.length > 1000 ||
      typeof data.body !== 'string' || !data.body.trim() || data.body.length > 1024 * 1024) {
    throw fail('INVALID_RESPONSE', 'announcement schema invalid.');
  }
  if (String(data.uuid) !== id) throw fail('SOURCE_MISMATCH', 'announcement ID mismatch.');
  return data;
}
function cells(content, tag) {
  const expression = new RegExp(`<${tag}>([^<>]*)</${tag}>`, 'g');
  const values = [...content.matchAll(expression)].map(match => match[1].trim());
  return content.replace(expression, '').trim() === '' ? values : null;
}
function rows(content) {
  const expression = /<tr>([\s\S]*?)<\/tr>/g;
  const values = [...content.matchAll(expression)].map(match => match[1]);
  return content.replace(expression, '').trim() === '' ? values : null;
}
function listingTable(body, assetName, symbol, markets) {
  // Supported grammar is the HTML table embedded in the verified current markdown.
  // No generic HTML renderer, fuzzy symbol match, or first-address extraction.
  if (/<(?:script|iframe|object|style)\b/i.test(body) || /<!--/.test(body)) return null;
  const expression = /<table>([\s\S]*?)<\/table>/g;
  const tables = [...body.matchAll(expression)];
  const opening = (body.match(/<table\b/gi) || []).length;
  const closing = (body.match(/<\/table\s*>/gi) || []).length;
  if (opening !== closing || tables.length !== opening) throw fail('INVALID_RESPONSE', 'announcement table markup invalid.');
  const listings = [];
  for (const table of tables) {
    const parts = /^\s*<thead>([\s\S]*?)<\/thead>\s*<tbody>([\s\S]*?)<\/tbody>\s*$/.exec(table[1]);
    if (!parts) return null;
    const headers = rows(parts[1]);
    const dataRows = rows(parts[2]);
    if (!headers || !dataRows || headers.length !== 1) return null;
    const header = cells(headers[0], 'th');
    if (!header) return null;
    if (header.join('|') !== '디지털 자산|마켓|네트워크|거래지원 개시 시점') continue;
    if (dataRows.length !== 1) return null; // Multiple assets need a separate parser.
    const row = cells(dataRows[0], 'td');
    if (!row || row.length !== 4 || row[0] !== `${assetName}(${symbol})` ||
        row[1] !== markets || row[2] !== 'Ethereum' || !row[3]) return null;
    listings.push(row);
  }
  return listings.length === 1 ? listings[0] : null;
}
function parseIdentity(data, symbol) {
  const title = /^([^()\r\n]+)\(([A-Z0-9]{1,32})\) ([A-Z0-9]+(?:, [A-Z0-9]+)*) 마켓 디지털 자산 추가$/.exec(data.title);
  if (!title || title[2] !== symbol) return null;
  const body = data.body.replace(/\r\n/g, '\n');
  if (!listingTable(body, title[1].trim(), symbol, title[3])) return null;
  const networkStatements = body.match(/안내된 네트워크 \([^\r\n)]*\)로만 입출금이 지원됩니다\./g) || [];
  if (networkStatements.length !== 1 || networkStatements[0] !== `안내된 네트워크 (${symbol}-Ethereum)로만 입출금이 지원됩니다.`) return null;
  const contractMarkers = body.match(/업비트에서 거래지원하는 [^\r\n]*?의 컨트랙트 주소는/g) || [];
  if (contractMarkers.length !== 1) return null;
  const expression = new RegExp(`^- 업비트에서 거래지원하는 ${symbol}의 컨트랙트 주소는 \\[(0x[0-9a-fA-F]{40})\\]\\(https://etherscan\\.io/token/(0x[0-9a-fA-F]{40})\\)입니다\\. ${symbol} 입출금 진행 시 컨트랙트 주소를 확인 바랍니다\\.$`, 'gm');
  const contracts = [...body.matchAll(expression)];
  if (contracts.length !== 1) return null;
  const contract = contracts[0];
  const address = normalizeContract(ETHEREUM, contract[1]);
  if (!address || address !== normalizeContract(ETHEREUM, contract[2])) return null;
  // Additional addresses, even a repetition of the same one, need reconciliation.
  // Counting for ambiguity does not pick an address or establish identity.
  const addresses = body.match(/0x[0-9a-fA-F]+/g) || [];
  if (addresses.length !== 2 || addresses.some(value => normalizeContract(ETHEREUM, value) !== address)) return null;
  return contract[1];
}

async function resolveUpbitIdentity({ sourceUrl, symbol, requestJson, now = Date.now } = {}) {
  const source = noticeSource(sourceUrl);
  const ticker = typeof symbol === 'string' ? symbol.trim().toUpperCase() : '';
  if (!source || !/^[A-Z0-9]{1,32}$/.test(ticker)) return null;
  if (typeof requestJson !== 'function') throw fail('REQUESTER_REQUIRED', 'requester missing.');
  let body;
  try { body = await requestJson(source.endpoint, { method: 'GET' }); }
  catch (cause) {
    // Do not expose requester response text, headers, signed URLs, or nested causes.
    const code = /^HTTP_[1-5]\d\d$/.test(cause?.code || '') || cause?.code === 'HOST_COOLDOWN' ? cause.code : 'REQUEST_FAILED';
    const error = fail(code, 'request failed.');
    if (Number.isFinite(cause?.retryAfterMs) && cause.retryAfterMs >= 0) error.retryAfterMs = cause.retryAfterMs;
    throw error;
  }
  const data = responseData(body, source.id);
  const address = parseIdentity(data, ticker);
  if (!address) return null;
  const checkedAt = typeof now === 'function' ? now() : NaN;
  if (!Number.isSafeInteger(checkedAt) || !Number.isFinite(new Date(checkedAt + TTL_MS).getTime())) throw fail('INVALID_CLOCK', 'confirmation clock invalid.');
  return {
    scope: 'NOTICE', confirmed: true, symbol: ticker, exchange: 'upbit', source_url: source.url,
    contracts: [{ chain_id: ETHEREUM, contract_address: address, token_kind: 'TOKEN' }],
    deposit_networks: [ETHEREUM], confirmed_at: new Date(checkedAt).toISOString(),
    valid_until: new Date(checkedAt + TTL_MS).toISOString(),
    evidence: [source.url, source.endpoint].map(url => ({ url, purpose: PURPOSE, authority: 'OFFICIAL' })),
  };
}

module.exports = { resolveUpbitIdentity };
