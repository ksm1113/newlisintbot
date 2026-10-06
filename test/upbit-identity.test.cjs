const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveUpbitIdentity } = require('../lib/networks/upbit-identity.cjs');

const sourceUrl = 'https://upbit.com/service_center/notice?id=330345227';
const address = '0x1776e1F26f98b1A5dF9cD347953a26dd3Cb46671';
const otherAddress = '0x1111111111111111111111111111111111111111';
const now = () => Date.parse('2026-10-06T11:50:00Z');
// Relevant public source excerpts captured from the official API on 2026-10-06.
// https://pub-info.upbit.com/api/v1/announcements/330345227
// Requests are always injected; this fixture makes no HTTP calls.
const fixture = {
  success: true,
  data: {
    id: 6642, uuid: '330345227', title: '뉴메레르(NMR) KRW, USDT 마켓 디지털 자산 추가',
    body: `안녕하세요. 가장 신뢰받는 디지털 자산 거래소 업비트입니다.\r\n\r\n<table>\r\n<thead>\r\n  <tr>\r\n    <th>디지털 자산</th>\r\n    <th>마켓</th>\r\n    <th>네트워크</th>\r\n    <th>거래지원 개시 시점</th>\r\n  </tr>\r\n</thead>\r\n<tbody>\r\n  <tr>\r\n    <td>뉴메레르(NMR)</td>\r\n    <td>KRW, USDT</td>\r\n    <td>Ethereum</td>\r\n    <td>10월 6일 20시 45분 예정</td>\r\n  </tr>\r\n</tbody>\r\n</table>\r\n\r\n## ※ 입금 유의사항\r\n- <highlight class="warning">안내된 네트워크 (NMR-Ethereum)로만 입출금이 지원됩니다. 입금 전 반드시 네트워크를 확인하세요.</highlight>\r\n- 업비트에서 거래지원하는 NMR의 컨트랙트 주소는 [${address}](https://etherscan.io/token/${address})입니다. NMR 입출금 진행 시 컨트랙트 주소를 확인 바랍니다.`,
  },
};
function copy() { return structuredClone(fixture); }
function resolve(response = copy(), options = {}) {
  return resolveUpbitIdentity({ sourceUrl, symbol: 'NMR', now, requestJson: async () => response, ...options });
}

test('Official notice ID, exact listing asset, Ethereum table and twice-bound full CA create a NOTICE anchor', async () => {
  let requested;
  const anchor = await resolve(copy(), { sourceUrl: `${sourceUrl}&view=share&utm_source=tg`, symbol: ' nmr ', requestJson: async (url, options) => {
    requested = url;
    assert.deepEqual(options, { method: 'GET' });
    return copy();
  } });
  assert.equal(requested, 'https://pub-info.upbit.com/api/v1/announcements/330345227');
  assert.equal(anchor.scope, 'NOTICE');
  assert.equal(anchor.source_url, sourceUrl);
  assert.equal(anchor.symbol, 'NMR');
  assert.equal(anchor.exchange, 'upbit');
  assert.equal(anchor.confirmed, true);
  assert.deepEqual(anchor.contracts, [{ chain_id: 'eip155:1', contract_address: address, token_kind: 'TOKEN' }]);
  assert.deepEqual(anchor.deposit_networks, ['eip155:1']);
  assert.equal(anchor.confirmed_at, '2026-10-06T11:50:00.000Z');
  assert.equal(anchor.valid_until, '2026-10-13T11:50:00.000Z');
  assert.deepEqual(anchor.evidence.map(e => e.url), [sourceUrl, requested]);
  assert.ok(anchor.evidence.every(e => e.authority === 'OFFICIAL' && e.purpose === 'LISTED_ASSET_NETWORK_AND_FULL_CA'));
  assert.equal(anchor.deposit_enabled, undefined);
  assert.equal(anchor.trading_allowed, undefined);
});

test('The optional www host stays bound to its notice while tracking parameters are removed', async () => {
  const anchor = await resolve(copy(), { sourceUrl: 'https://www.upbit.com/service_center/notice?view=share&id=330345227&utm_campaign=nmr' });
  assert.equal(anchor.source_url, 'https://www.upbit.com/service_center/notice?id=330345227');
});

test('Unsupported or unsafe source URLs and invalid symbols return null without any request', async () => {
  let calls = 0;
  const requestJson = async () => { calls++; return copy(); };
  for (const url of [
    undefined, '', 'not-a-url', 'http://upbit.com/service_center/notice?id=330345227',
    'https://upbit.com.evil.test/service_center/notice?id=330345227',
    'https://evil.test@upbit.com/service_center/notice?id=330345227',
    'https://upbit.com:444/service_center/notice?id=330345227',
    'https://pub-info.upbit.com/api/v1/announcements/330345227',
    'https://upbit.com/service_center/notice/330345227',
    'https://upbit.com/service_center/notice?id=330345227&id=6642',
    'https://upbit.com/service_center/notice?id=330345227&token=sensitive-value',
    'https://upbit.com/service_center/notice?id=330345227&view=share&view=other',
    'https://upbit.com/service_center/notice?id=330345227#fragment',
    'https://up\tbit.com/service_center/notice?id=330345227',
    'https://upbit.com/service_center/notice?id=../6642',
  ]) assert.equal(await resolve(copy(), { sourceUrl: url, requestJson }), null);
  for (const symbol of [undefined, '', 'NMR|.*', 'NMR/ETH', '$NMR', 'A'.repeat(33)]) {
    assert.equal(await resolve(copy(), { symbol, requestJson }), null);
  }
  assert.equal(calls, 0);
});

test('UUID mismatch and broken API schemas are typed errors; internal numeric id is never the notice identity', async () => {
  const invalid = [null, {}, { success: true }, { success: 'true', data: copy().data },
    { success: true, data: { ...copy().data, title: null } },
    { success: true, data: { ...copy().data, body: {} } },
    { success: true, data: { ...copy().data, body: '' } },
    { success: true, data: { ...copy().data, uuid: null } }];
  for (const value of invalid) await assert.rejects(resolve(value), { code: 'INVALID_RESPONSE' });
  await assert.rejects(resolve({ success: false, message: 'sensitive-value' }), { code: 'API_ERROR' });
  const mismatch = copy(); mismatch.data.uuid = '6642'; mismatch.data.id = 330345227;
  await assert.rejects(resolve(mismatch), { code: 'SOURCE_MISMATCH' });
  const internalChanged = copy(); internalChanged.data.id = 'anything';
  assert.ok(await resolve(internalChanged));
});

test('Other symbols, title changes and unsupported networks remain unconfirmed', async () => {
  for (const mutate of [
    f => { f.data.title = f.data.title.replace('(NMR)', '(OTHER)'); },
    f => { f.data.title = f.data.title.replace('디지털 자산 추가', '거래지원 종료'); },
    f => { f.data.body = f.data.body.replace('뉴메레르(NMR)', '뉴메레르(OTHER)'); },
    f => { f.data.body = f.data.body.replace('<td>Ethereum</td>', '<td>Solana</td>'); },
    f => { f.data.body = f.data.body.replace('<td>Ethereum</td>', '<td>Ethereum, Solana</td>'); },
    f => { f.data.body = f.data.body.replace('(NMR-Ethereum)', '(NMR-Solana)'); },
    f => { f.data.body = f.data.body.replace('(NMR-Ethereum)', '(OTHER-Ethereum)'); },
    f => { f.data.body = f.data.body.replace('거래지원하는 NMR의', '거래지원하는 OTHER의'); },
    f => { f.data.body = f.data.body.replace('안내된 네트워크 (NMR-Ethereum)로만 입출금이 지원됩니다.', ''); },
  ]) { const response = copy(); mutate(response); assert.equal(await resolve(response), null); }
  assert.equal(await resolve(copy(), { symbol: 'OTHER' }), null);
});

test('Incomplete CA, conflicting linked CA, wrong link authority and multiple contract markers hold the notice', async () => {
  for (const mutate of [
    f => { f.data.body = f.data.body.replace(address, '0x1776...6671'); },
    f => { f.data.body = f.data.body.replace(`token/${address}`, `token/${otherAddress}`); },
    f => { f.data.body = f.data.body.replace('https://etherscan.io/token/', 'https://evil.test/token/'); },
    f => { f.data.body += `\n- 업비트에서 거래지원하는 OTHER의 컨트랙트 주소는 [${otherAddress}](https://etherscan.io/token/${otherAddress})입니다.`; },
    f => { f.data.body += `\n- 업비트에서 거래지원하는 NMR의 컨트랙트 주소는 [${address}](https://etherscan.io/token/${address})입니다. NMR 입출금 진행 시 컨트랙트 주소를 확인 바랍니다.`; },
    f => { f.data.body += `\nOther token ${otherAddress}`; },
    f => { f.data.body += `\nRepeated token ${address}`; },
  ]) { const response = copy(); mutate(response); assert.equal(await resolve(response), null); }
});

test('Multiple listing assets or tables and unrelated address prose cannot be reduced to the first asset', async () => {
  const duplicate = copy();
  const row = '<tr><td>다른코인(OTHER)</td><td>KRW, USDT</td><td>Ethereum</td><td>예정</td></tr>';
  duplicate.data.body = duplicate.data.body.replace('</tbody>', `${row}</tbody>`);
  assert.equal(await resolve(duplicate), null);
  const twoTables = copy(); twoTables.data.body += '\n' + twoTables.data.body.match(/<table>[\s\S]*?<\/table>/)[0];
  assert.equal(await resolve(twoTables), null);
  const bareAddress = copy(); bareAddress.data.body = bareAddress.data.body.replace(/^.*업비트에서 거래지원하는.*$/m, `Contract: ${address}`);
  assert.equal(await resolve(bareAddress), null);
  const titleMultiple = copy(); titleMultiple.data.title = '뉴메레르(NMR), 다른코인(OTHER) KRW, USDT 마켓 디지털 자산 추가';
  assert.equal(await resolve(titleMultiple), null);
});

test('Malformed table markup errors, while unsupported HTML or markdown formats stay held', async () => {
  const malformed = copy(); malformed.data.body = malformed.data.body.replace('</table>', '');
  await assert.rejects(resolve(malformed), { code: 'INVALID_RESPONSE' });
  for (const mutate of [
    f => { f.data.body = f.data.body.replace('<td>Ethereum</td>', '<td><span>Ethereum</span></td>'); },
    f => { f.data.body = `<script>${f.data.body}</script>`; },
    f => { f.data.body = `<!--${f.data.body}-->`; },
    f => { f.data.body = '<p>Unrecognized body format.</p>'; },
  ]) { const response = copy(); mutate(response); assert.equal(await resolve(response), null); }
});

test('Requester failures mask response text and nested causes while preserving safe retry codes', async () => {
  await assert.rejects(resolve(copy(), { requestJson: async () => {
    const error = new Error('sensitive-value https://private.invalid/?secret=sensitive-value');
    error.code = 'HTTP_429'; error.retryAfterMs = 4567; error.cause = new Error('sensitive-value');
    throw error;
  } }), error => {
    assert.equal(error.code, 'HTTP_429');
    assert.equal(error.retryAfterMs, 4567);
    assert.equal(error.cause, undefined);
    assert.equal(error.stack.includes('sensitive-value'), false);
    return true;
  });
  await assert.rejects(resolve(copy(), { requestJson: undefined }), { code: 'REQUESTER_REQUIRED' });
  await assert.rejects(resolve(copy(), { now: () => NaN }), { code: 'INVALID_CLOCK' });
});
