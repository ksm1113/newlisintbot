# 시장 조회 설계·구현 — 2026-10-06

> 이 문서는 초기 시장 조회 단계의 설계와 검증 기록을 포함한다. 이후 CA·입출금 필터와 USDT/USDC·ACTIVE·매수 제한·OKX 거래 룰 필터를 구현했다. 현재 상태는 [README](../README.md)와 [인수인계](../SESSION_CONTEXT.md)를 우선한다. 아래 87개 테스트·초기 미구현 항목은 과거 단계이며 마지막 전체 테스트는168/168 통과 후 사용자 요청으로 중단한 상태다.

## 핵심만

- **구현:** CEX 5곳·Perp DEX 4곳, 총 9곳의 20개 상품군 목록 수집·캐시·시장 후보 검색.
- **연결:** 상장 접수 → 재시작 후 이어가는 조회 작업 → 이벤트별 시장 후보 파일.
- **미구현:** 동일 코인 검증, CA·입금 네트워크 확인, EVM/Solana 현물 풀 조회, 판단·매매·전송.
- **상태 구분:** `FRESH`는 목록이 최신이라는 뜻이다. 후보가 같은 코인이거나 주문 가능한지 검증한 상태가 아니다. 모든 결과는 `UNVERIFIED`, `trading_allowed: false`다.
- **실 API 검증:** 9곳·20개 상품군 전부 정상 수집. Aster의 미분류 거래 전 항목과 Binance 전통자산 무기한을 명시적으로 구분한다.

## 사용자가 선택한 범위

| 경로 | 목표 | 현재 상태 |
| --- | --- | --- |
| CEX 현물·무기한 선물 | Binance, Bybit, OKX, Bitget, Gate | 읽기 전용 상품 목록·후보 검색 구현 |
| Perp DEX | Hyperliquid, Aster, Variational, Lighter | 읽기 전용 상품 목록·후보 검색 구현 |
| DEX 현물 | EVM 계열 + Solana | 미구현. 개별 EVM 네트워크·스왑 경로는 추후 확정 |

현재 상품 형식은 `spot`과 `perpetual`이다. 만기 선물·옵션은 이번 목록 범위에 포함하지 않는다. 실제 범위는 `lib/markets/adapters/*.cjs`의 `segments[].description`과 결과의 `coverage[].scope`에 남는다.

시장 데이터 접근, 주문 API 제공 여부, 실제 계정의 주문 가능 여부는 각각 다른 확인 항목이다. Perp DEX의 현물 상품도 이번 목록에서 자동으로 지원하지 않는다. Hyperliquid의 `spotMeta` 호출은 무기한 시장의 담보 자산 이름을 확인하는 데만 사용한다.

## 구현한 목록 어댑터

공식 문서를 바탕으로 읽기 전용 경로를 구현했다. 목록의 티커·상품 ID만으로 동일 자산을 확정하지 않는다.

| 거래소 | 상품군 | 목록 경로·보존 사항 |
| --- | --- | --- |
| Binance | 현물, USDⓈ-M 무기한, COIN-M 무기한 — 3개 | `/api/v3/exchangeInfo`, `/fapi/v1/exchangeInfo`, `/dapi/v1/exchangeInfo`. 계약 유형·상태·가격/수량 필터·계약 크기 보존. [현물](https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/rest-api/general), [선물](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data) |
| Bybit | 현물, USDT/USDC 무기한, inverse 무기한 — 3개 | `/v5/market/instruments-info`. category별 조회·cursor 페이지 완주, 계약 유형·`isPreListing`·상태·주문 조건 구분. [공식 문서](https://bybit-exchange.github.io/docs/v5/market/instrument) |
| OKX | 현물, linear/inverse SWAP — 2개 | `/api/v5/public/instruments`. SPOT/SWAP 조회, `ctType`·`ctVal`·단위·상태·주문 조건 보존. [공식 문서](https://app.okx.com/docs-v5/en/#public-data-rest-api-get-instruments) |
| Bitget | Classic 현물, USDT-M·USDC-M·Coin-M 무기한 — 4개 | `/api/v2/spot/public/symbols`, `/api/v2/mix/market/contracts`. productType별 조회, 계약 유형·상태·API 제한·주문 조건 보존. [현물](https://www.bitget.com/zh-CN/docs/catalog/classic-spot-market/classic-spot-market), [선물](https://www.bitget.com/docs/catalog/classic-contract-market/classic-contract-market) |
| Gate | 현물, USDT·BTC·USD1 결제 무기한 — 4개 | `/api/v4/spot/currency_pairs`, `/api/v4/futures/{settle}/contracts`. limit/offset 페이지 조회, 매수/매도 제한·delisting·`quanto_multiplier`·계약 수량 단위 보존. [현물](https://www.gate.com/docs/developers/apiv4/en/spot/), [선물](https://www.gate.com/docs/developers/apiv4/en/futures/) |
| Hyperliquid | 기본·HIP-3 무기한 — 1개 | 공개 `POST /info`: `perpDexs`, `allPerpMetas`, 담보 확인용 `spotMeta`. namespace·원본 이름·숫자 상품 ID·담보·delisting·수량 정밀도 보존. [목록](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals), [ID](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/asset-ids) |
| Aster | V3 무기한 — 1개 | `GET /fapi/v3/exchangeInfo`. 계약 유형·상태·marginAsset·필터 보존. 미분류 상장 대기 항목은 별도 `exclusions` 기록. [공식 V3](https://github.com/asterdex/api-docs/blob/master/V3%28Recommended%29/EN/aster-finance-futures-api-v3.md) |
| Variational Omni | 공개 무기한 listing label — 1개 | `GET /metadata/stats`. ticker label과 원본 통계 보존. 실행 상품 ID로 확정하지 않으며 주문 API는 `UNAVAILABLE`. [공식 API](https://docs.variational.io/technical-documentation/api) |
| Lighter | mainnet 무기한 — 1개 | `/api/v1/orderBookDetails?filter=perp`. perp 배열만 사용. ID·상태·multiplier·supported decimals·최소 주문 조건 보존. [목록](https://apidocs.lighter.xyz/reference/orderbookdetails), [공식 스키마](https://github.com/elliottech/lighter-python/blob/main/docs/PerpsOrderBookDetail.md) |

**Variational:** 공식 문서는 Trading API가 아직 사용자에게 제공되지 않는다고 안내한다. 공개 bid/ask는 최대 600초 캐시될 수 있어 주문용 실시간 견적으로 사용하지 않는다. 목록 조회 성공을 자동 주문 지원으로 표시하지 않는다. [공식 API](https://docs.variational.io/technical-documentation/api).

**Binance:** USDⓈ-M의 공식 `TRADIFI_PERPETUAL` 유형도 무기한 목록에 보존하며 `asset_class: TRADFI`와 원천 `underlyingType`을 남긴다. 전통자산 가격을 추종하는 상품이므로 암호화폐 토큰과 동일 자산으로 확정하지 않는다. [공식 계약 유형](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data), [TradFi 출시 안내](https://www.binance.com/en/support/announcement/detail/ecf7318c0d434c339e80878588e700d0).

## 현재 흐름과 저장 파일

```text
NewListings → client.cjs → data/listings.jsonl
                                  ↓ InfoConsumer
                         data/info-results.jsonl
                                  ↓ LookupWorker
                      state/market-jobs/<event_id>.json
                                  ↓ 캐시에서 시장 후보 검색
                       data/market-results/<event_id>.json

공개 상품 API → Catalog → data/catalogs/<venue>-<segment>.json
                               ↓ 후보 검색에서 사용
```

| 파일·모듈 | 담당 |
| --- | --- |
| `data/info-results.jsonl` | 기존 신규 기록 접수. 여전히 `LOOKUP_PENDING`이며 실제 조회 완료 파일이 아님 |
| `lib/markets/adapters/` | 9곳의 읽기 전용 상품 목록 조회·정규화 |
| `lib/markets/catalog.cjs` | 상품군별 갱신·캐시·만료·오류 상태·단일 실행 잠금 |
| `data/catalogs/<venue>-<segment>.json` | 마지막 정상 목록·출처·성공/시도 시각·만료·오류·미분류 항목 |
| `data/catalogs/status.json` | 상품군별 상태·실패/재시도 정보 |
| `lib/markets/matcher.cjs` | 원천 base label로 시장 후보 검색. 동일 코인 확정 기능은 없음 |
| `lib/markets/lookup-worker.cjs` | 작업 등록·부분 결과·재시도·재시작 복구 |
| `state/market-lookup-consumer.json` | 조회 작업 등록용 바이트 커서. 기존 접수 커서와 별도 |
| `state/market-jobs/<event_id>.json` | 이벤트·작업 상태·시도 횟수·재시도 시각·카탈로그 fingerprint |
| `data/market-results/<event_id>.json` | 이벤트별 시장 후보와 coverage. 갱신 시 원자적으로 교체 |

작업을 먼저 디스크에 등록한 뒤 등록 커서를 갱신한다. 결과 저장 후 완료 상태를 기록하며, 그 사이 종료되면 저장된 결과로 완료 상태를 복구한다. 재시작 시 `RUNNING` 작업은 다시 대기한다. 부분 줄은 완성될 때까지 기다리고, 완성된 손상 JSON·파일 교체/축소·저장 실패는 중단한다. `data`와 `state`는 함께 보존해야 한다.

목록 갱신은 상품군별로 독립적으로 끝나며 구독자에게 알린다. 조회 워커는 먼저 확보된 목록으로 부분 결과를 저장할 수 있다. 모든 거래소가 성공해야 최초 결과가 나오는 구조는 아니다.

## 캐시 설정과 상태

기본값은 `config/markets.json`에서 바꾼다.

| 설정 | 기본값 |
| --- | --- |
| 정상 상품군 갱신 주기 | 5분 |
| 캐시 TTL | 정상 수집 후 10분 |
| 개별 HTTP timeout | 10초 |
| 상품군 전체 timeout | 60초 |
| 동시 상품군 수집 | 3개 |
| 실패 상품군·조회 작업 재확인 간격 | 30초. 상품군 호출은 공급자의 더 긴 Retry-After 우선 |
| 부분 조회 최대 시도 | 5회. 목록 로딩·호출 제한 대기·미분류 보류는 시도를 소모하지 않음 |

같은 호스트의 HTTP 요청은 직렬화하고 호출 시작 간격을 둔다. 429/418 이후 호스트별 cooldown을 적용한다. 재시도 정보는 디스크에 남겨 재시작 후에도 참고한다.

| 카탈로그 상태 | 의미 |
| --- | --- |
| `NOT_FETCHED` | 아직 수집하지 않음 |
| `FRESH` | 정상 수집·TTL 내·최근 수집 오류 없음 |
| `STALE` | 이전 목록은 있지만 만료됐거나 새 수집이 실패함 |
| `ERROR` | 수집 실패, 이전 정상 목록 없음 |

정상 목록 전체를 검증한 뒤 원자적으로 교체한다. 페이지 누락·API 오류·timeout을 성공한 빈 목록으로 바꾸지 않는다. 반대로 유효한 응답의 상품이 0개일 수 있다. 실제 검사에서 Bitget Coin-M 무기한은 0개인 정상 응답을 확인했다.

저장 실패는 API 장애로 숨기지 않는다. 병렬 갱신의 치명적 오류가 발생하면 남은 작업을 중단하고 모든 진행 작업의 종료를 기다린 뒤 잠금을 해제한다.

## 후보 검색과 결과 상태

후보 기준은 **원천 base label의 앞뒤 공백 제거·대소문자 무시 일치**다. `1000`·`1M`·`k` 등의 접두사를 추측해 변환하지 않는다. 예를 들어 `TEST` 이벤트는 `1000TEST` 상품과 자동으로 일치하지 않는다. Hyperliquid HIP-3의 문서화된 namespace는 분리하되 원본 상품 이름·ID를 보존한다.

후보마다 상품 종류·출처·상태·정밀도·계약 단위·카탈로그 확인 시각/만료를 남긴다. `identity_status: UNVERIFIED`, `asset_id: null`, `trading_allowed: false`를 강제한다. 오래된 목록의 후보도 증거로 남길 수 있으나 `catalog_status: STALE`가 붙는다.

| 조회 결과 상태 | 의미 |
| --- | --- |
| `CATALOG_CANDIDATES_READY` | 모든 대상 상품군이 최신이며 label 후보를 찾음. 동일 코인·주문 가능 검증 완료는 아님 |
| `CATALOG_SEARCH_EMPTY` | 최신인 선택 상품군 범위에서 label 후보 없음. 전 세계 시장 부재를 뜻하지 않음 |
| `CATALOG_PARTIAL` | 일부 목록이 미수집·오래됨·실패했거나 해당 label의 미분류 항목 존재 |
| `SYMBOL_REQUIRED` | 조회할 label이 없거나 일부 자산의 label이 빠짐. 알려진 자산의 후보는 보존 |

Aster에서 관찰한 `contractType: ""` + `PENDING_TRADING` 조합은 무기한으로 추정하지 않는다. ID·label·원래 상태·제외 이유를 `exclusions`에 보존하고, 이벤트가 그 label을 찾으면 `UNCLASSIFIED_CATALOG_ENTRY`로 표시한다. 다른 미확인 계약 유형은 오류로 처리한다.

조회 작업은 `QUEUED` → `RUNNING` 후 결과에 따라 `WAITING_CATALOG`, `RETRY`, `COMPLETE`, `WAITING_IDENTITY`, `FAILED`가 된다. `COMPLETE`는 이번 **시장 목록 검색**의 완료다. CA·동일 코인·입금 네트워크 검증의 완료가 아니다. 조회가 계속 부분 상태면 정해진 횟수 이후 `FAILED`로 남고, 수동으로 다시 시도할 수 있다.

공급자의 `retry_after_ms`가 일반 조회 재시도 간격보다 길면 `WAITING_CATALOG`로 대기하며 조회 횟수를 소모하지 않는다. 일반 네트워크/스키마 오류는 `RETRY`와 최대 시도 한도를 적용한다. 전체 목록이 최신이어도 해당 코인의 계약 유형만 미분류인 경우 역시 목록 변경을 기다린다. 동일 보류 상태를 1초마다 다시 저장하지 않는다.

`COMPLETE`·`WAITING_IDENTITY` 작업의 결과는 자동 갱신하지 않는다. 저장 당시 결과 파일은 이후 TTL이 지나도 상태값이 저절로 바뀌지 않는다. 향후 판단부는 사용 시점의 캐시·확인 시각·만료를 재검증해야 한다. 현재 DEX 현물·입금 네트워크는 항상 `NOT_QUERIED`다.

## 추가 합의: 현물 입출금 네트워크 필터 — 미구현

사용자가 이벤트 기반 목록 갱신 제안을 취소했으므로 상품 목록의 **5분 주기 갱신과 기존 캐시 검색을 유지**한다. listing/delisting을 계기로 갱신 후 재검색하는 기능은 추가하지 않았다.

새 요구는 현물 매수처의 출금 지원망과 신규 상장 거래소의 입금 지원망을 비교하는 것이다. 조회부는 다음 조건을 확인한 경로만 현물 전송 후보로 전달한다.

- 동일 코인 확인, 표준 체인 ID 일치, 해당 체인의 토큰/네이티브 자산 일치. 토큰이면 전체 CA/mint와 공식 근거를 확인한다.
- 매수처는 해당 망 출금 활성, 도착처는 해당 망 입금 활성. 지원 목록에 있다는 사실과 현재 활성 상태를 구분한다.
- 상태의 출처·확인 시각·유효기간 기록. 미조회·오류·만료·미확인 망 이름은 `UNKNOWN`/보류이며 통과로 바꾸지 않는다.
- 거래소별 검증된 망 이름 매핑을 사용한다. 토큰 규격 문자열 또는 같은 티커만으로 체인을 추정하지 않는다. 브리지/래핑 경로는 직접 동일 망 전송 경로와 별도 검증 대상이다.

신규 상장 공지의 지원 입금망을 먼저 확보하고, 각 현물 매수처의 출금망과 교집합을 구한다. 공지의 상장 예정은 입금 활성 확인으로 취급하지 않는다. NewListings의 토큰 체인/CA도 그 거래소의 입금 지원망을 증명하지 않는다. 대상 거래소가 지원 목록 9곳 밖이어도 공식 입금망 확인 경로가 필요하다.

현물 시장 후보 원본과 필터 통과/제외/보류 이유를 보존한다. 이 필터는 이동 경로 조건이며, 계정 제한·주소/메모·금액/최소 출금·수수료 등의 최종 실행 조건과 실제 거래 허가는 미래 판단/전송 단계에서 확인한다. 무기한 상품의 존재 여부에는 현물 출금망 필터를 적용하지 않는다.

지원망 캐시는 최초 후보 조회에 활용하고 입출금 활성 상태는 실제 매수·전송 직전에 재확인한다. 새 네트워크 조회 경로가 상품 후보 검색의 완료를 막지 않도록 별도 상태로 관리한다. 확인되지 않은 경로를 사용하는 현물 이동 전략은 보류한다.

| 매수처 | 공식 통화/네트워크 조회 경로 | 확인 항목·접근 조건 |
| --- | --- | --- |
| Binance | `GET /sapi/v1/capital/config/getall` | `networkList`: 망·CA·입출금 활성. API 키·서명 필요. [공식 Wallet API](https://developers.binance.com/en/docs/catalog/core-trading-wallet/api/rest-api/capital) |
| Bybit | `GET /v5/asset/coin/query-info` | `chains`: 망·CA·입출금 상태. API 키·서명 필요. [공식 Coin Info](https://bybit-exchange.github.io/docs/v5/asset/coin-info) |
| OKX | `GET /api/v5/asset/currencies` | `chain`, `canDep`, `canWd`, `ctAddr`. API 키·서명·passphrase 필요. 계정 KYC entity 범위 응답. [공식 Funding API](https://my.okx.com/docs-v5/en/#rest-api-funding-get-currencies) |
| Bitget | `GET /api/v2/spot/public/coins` | 공개 조회. `chains`: 망·CA·`withdrawable`/`rechargeable`. [공식 Classic Spot API](https://www.bitget.com/zh-CN/docs/catalog/classic-spot-market/classic-spot-market) |
| Gate | `GET /api/v4/spot/currencies` 또는 통화별 조회 | 공개 조회. `chains`: 망·CA·입출금 중단 상태. 통화 최상위의 폐기된 상태 필드를 대신 쓰지 않는다. [공식 Spot API](https://www.gate.com/docs/developers/apiv4/en/spot/) |

현재 네트워크 API는 호출하지 않았고 필터도 구현하지 않았다. 인증이 필요한 조회는 향후 자격 증명 설정 후 별도 구현한다. 위 공식 문서는 2026-10-06에 확인했으며, 구현 시 응답·권한 범위를 재검증한다. OKX `/asset/deposit-address`의 `ctAddr`는 CA 마지막 6자리이므로 전체 주소 비교에 쓰면 안 된다. [공식 입금 주소 API](https://my.okx.com/docs-v5/en/#rest-api-funding-get-deposit-address).

## 공통 상품 형식

| 필드 | 의미 |
| --- | --- |
| `venue`, `venue_kind`, `segment` | 목표 거래소, CEX/Perp DEX, 상품군 |
| `market_id`, `market_type` | 원천 상품 식별자, 현재 `spot`/`perpetual`. Variational의 ID는 ticker label이며 별도 표기 |
| `base_symbol`, `quote_symbol`, `settle_symbol` | 원천 label·호가·결제 자산. 확인되지 않은 값은 null |
| `asset_id`, `identity_status`, `trading_allowed` | 현재 null, UNVERIFIED, false |
| `multiplier`, `contract_size`, `linear`, `inverse` | 원천 근거가 있는 계약 단위. 모르면 null |
| `price_tick`, `quantity_step`, `limits` | 문자열 정밀도·최소/최대 주문 조건·원천 필터·단위 |
| `native_status`, `market_status` | 원천 상태와 ACTIVE/INACTIVE/UNKNOWN |
| `order_api_status` | 제공된 주문 API 존재 여부. 실제 계정 권한이나 주문 허가와 별개 |
| `source`, `raw` | 목록 근거와 원본 상품. 이벤트 후보에는 raw를 복제하지 않음 |

`fetched_at`·`valid_until`은 카탈로그 view와 이벤트 후보에 포함한다. 공급자별 단위·정밀도 차이를 보존하고 주문 수량 변환은 미래 실행 어댑터에서 검증한다. 모델에는 아직 검증된 코인 매핑·신원 근거 수집 기능이 없다.

## 실행과 검사

```powershell
# 접수 + 공개 상품 목록 갱신 + 시장 후보 검색. NewListings 키는 필요 없음
node info.cjs

# 기존 외부 연결 없는 접수만 수행
node info.cjs --once

# 공개 목록 갱신 및 현재 작업 조회를 한 번 수행
node info.cjs --lookup-once

# 실패 작업의 시도 횟수를 초기화하고 다시 조회
node info.cjs --lookup-once --retry-failed

# 합성 데이터로 감시부 → 접수 → 9곳 후보 결과 검사. API 연결 없음
npm run check:info

# 공개 상품 API 검사. 운영 파일과 분리된 data/checks 폴더 사용
npm run check:catalog
```

`catalog.cjs`는 상품 목록 갱신을 단독 실행하는 도구다. 기본 `info.cjs`가 이미 카탈로그 잠금을 가지므로 두 도구를 같은 프로젝트 데이터에서 동시에 실행하지 않는다.

검사 폴더의 합성 결과는 실제 상장·실시간 거래 가능 검증이 아니다. 실제 공개 API 검사도 읽기 전용이며 지갑 서명·주문·전송을 실행하지 않는다.

## 검증 기록과 남은 작업

2026-10-06 최종 공개 API 검사는 **9곳·20/20개 상품군 정상**이다. 보고서는 `data/checks/catalog-live-Xv6Gx6/report.json`에 저장했다. Aster는 확인된 무기한 612개와 계약 유형이 비어 있는 거래 전 항목 5개를 구분했다. Binance USDⓈ-M 무기한은 920개이며 전통자산 상품을 별도 표시한다. Bitget Coin-M 0개는 검증된 정상 빈 목록이다. 조회 성공은 동일 코인·계정 주문 가능·실행 견적 검증의 완료가 아니다.

오프라인 자동 테스트는 **87/87 통과**했다. 합성 정보부 자동 전달 검사도 9개 미검증 후보 저장으로 통과했다 (`data/checks/info-offline-uCs71G/report.json`). 일반 반복 실패는 5회에서 중단하며 긴 호출 제한·재시작·미분류 보류·배치 중 TTL 경계를 별도로 검증했다.

다음 구현 순서는 다음과 같다.

1. **공식 코인 식별:** 이벤트·공식 공지·프로젝트 근거로 동일 코인, 네트워크, 체인+CA 확인. ticker 후보를 검증된 매핑으로 승격하는 기준 설계.
2. **DEX 현물 풀:** 확인된 EVM 네트워크+컨트랙트 또는 Solana+mint로 해당 토큰의 풀 조회. 풀·프로토콜 검증·실제 금액 견적.
3. **검증된 경로 결합:** CEX 상품·Perp DEX·현물 DEX 결과에 자산 식별·확인 시각·유효성·불확실성 기록.
4. **판단부·모의 실행:** 만료 재확인, 거래 상태·계정 가능·금액 한도·자금 예약·중복 주문 통제.
5. **매매·전송:** 승인된 전략·한도와 모의 실행 검증 후 별도 실행 어댑터 연결.

[DexScreener의 토큰 풀 조회](https://docs.dexscreener.com/api/reference)는 chainId와 tokenAddress를 받는다. [GeckoTerminal/CoinGecko의 토큰별 풀 조회](https://docs.coingecko.com/reference/top-pools-contract-address)는 network와 토큰 주소를 받아 공급자별 체인 ID 변환이 필요하다. EVM 주소 처리와 Solana의 대소문자 보존을 구분한다. 집계 API는 공급자가 추적한 풀 후보이며 모든 풀의 존재를 보장하지 않는다.

운영 보완도 남았다. 조회 작업은 최대 5만 개를 넘어 조용히 누락하지 않도록 중단하며 자동 보관·순환은 아직 없다. 실패 작업 재시도와 결과 고정 정책도 신원 검증 단계에서 확장한다. 전체 피드→후보 결과 지연과 API 장애·많은 이벤트 상황의 부하는 별도로 측정해야 한다.
