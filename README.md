# NewListingBot

> 진행상황 기준: 2026-10-06

## 핵심만

- **구현:** 상장 감시·파일 전달, 시장 목록 캐시·후보 검색, 동일 토큰 CA 비교·현물 입출금망 필터 코드. 인증 API 실제 검증과 미지원 공지 처리는 남아 있다.
- **지원:** CEX Binance/Bybit/OKX/Bitget/Gate, Perp DEX Hyperliquid/Aster/Variational/Lighter. 총 9곳·20개 상품군.
- **후보 페어:** 현물·무기한 모두 원천 quote가 USDT/USDC이고 ACTIVE인 상품만 검색한다. 현물은 현물 전용 목록에서만 확인하며 매수 중단 페어는 제외한다. OKX 프리마켓·비정상 거래 룰도 제외한다.
- **결과:** 후보 검색과 신원·경로 검증을 별도 저장. 확인된 현물만 CA·체인 검증하며 `trading_allowed: false`.
- **최신 목록 검사:** 9곳·20개 상품군 실제 조회. NMR은 현물 5개·무기한 5개 후보. Binance 현물은 NMR/USDT 1개다. 후보 개수는 신원·입출금 검증 통과 개수가 아니다. [상태 검사 기록](data/checks/catalog-live-AmgPvO/market-status-audit.json)
- **거래 제한 수정:** 실제 목록에서 Gate 매도 전용 MSP/USDT 1개와 OKX 프리마켓 무기한 4개를 찾아 후보에서 제외했다. 이전 캐시의 제한 필드도 검사한다. 마지막 전체 테스트 168/168 통과 후 사용자 요청으로 추가 테스트를 중단했다.
- **남은 일:** 인증 네트워크 API 실제 연결·검증, 빗썸 등 공지 식별 어댑터, 무기한 기초자산 매핑, DEX 현물 풀.
- **미구현:** 판단부, 주문·체결, 출금·전송. 만기 선물도 현재 조회 범위에서 제외.

이전 NMR 검사(`data/checks/nmr-live-BfgCMG/report.json`)의 18개는 페어·거래 상태 필터 적용 전 기록이다. 당시 Bitget/Gate 현물 3개 페어의 CA·Ethereum 일치와 업비트 현재 입금 상태 미조회로 경로 통과 0개라는 결과는 과거 검증 기록으로 보존한다. 목록 상태는 기존 5분 API 갱신 기준이며, 갱신 사이의 실시간 거래 상태를 보장하지 않는다.

## 다음 모델 인수인계

작업 재개 시 [SESSION_CONTEXT.md](SESSION_CONTEXT.md) → 이 README → [AGENTS.md](AGENTS.md) 순서로 읽는다. 상세 코드 근거는 [시장 조회 설계](docs/MARKET_DISCOVERY.md)와 [신원·경로 필터](docs/IDENTITY_NETWORKS.md)를 참고한다. 요약 저장 날짜 이후의 사용자 요청과 실제 코드가 우선이다.

- **현재 중단점:** 중단·매수 제한 페어 검토와 수정 완료. 마지막 전체 테스트 168/168 통과. 사용자 요청으로 테스트를 중단했으며 이번 인수인계 작업에서는 다시 실행하지 않았다.
- **유지할 선택:** 5분 API 갱신 → 상장 이벤트는 로컬 캐시 검색. USDT/USDC·ACTIVE만 후보로 검색하며 현물과 무기한을 따로 집계한다.
- **범위:** 정보 조회까지 구현했다. 다음 구현 항목은 사용자와 정한 뒤 진행하며, 새 프로세스·복잡한 구조·주문·전송으로 임의 확대하지 않는다.
- **보존:** 기존 작업은 커밋되지 않은 상태다. `data/`·`state/`·과거 검사 결과·다른 작업 변경을 임의로 비우거나 되돌리지 않는다. `.env`·키를 출력하지 않는다.

## 실행

Node.js 22 이상. 의존성은 `npm install`, 피드 키는 `.env`의 `NLF_KEY`에 설정한다. 공개 상품 목록·Bitget/Gate 네트워크 조회에는 키가 필요 없다. 정보부는 실행 시 `.env`를 읽으며 인증 네트워크 조회 키 이름은 [신원·경로 필터](docs/IDENTITY_NETWORKS.md)에 있다.

프로젝트 폴더에서 터미널 두 개로 실행한다.

```powershell
# 터미널 1: 실제 신규상장 피드 수신
npm run start:watcher

# 터미널 2: 공개 API 목록 갱신 + 신규 기록 접수·시장 후보 조회
npm run start:info
```

정보부를 먼저 켜도 입력 파일 생성을 기다린다. `Ctrl+C`로 종료한다. 감시부와 정보부는 각각 하나씩 실행한다.

```powershell
# 기존 오프라인 접수 명령 유지. 외부 API 호출 없음
npm run info:once

# 공개 목록 한 번 갱신 + 미완료 작업 한 번 처리하고 종료
npm run info:lookup-once

# 재시도 한도를 초과한 FAILED 작업도 다시 처리
node info.cjs --lookup-once --retry-failed

# 목록만 확인. start:info 실행 중에는 같은 잠금 때문에 동시 실행 불가
npm run catalog:once
```

`--lookup-once`는 대기 작업을 한 차례 처리한다. 일부 API가 실패하면 부분 조회를 저장하고 종료 코드 1을 반환한다. 계속 재시도하려면 기본 정보부를 실행한다.

## 구현된 흐름과 파일

```text
NewListings → client.cjs → data/listings.jsonl
                                  ↓ 새 완성된 줄 감지
                               info.cjs
                                  ↓ 접수
                         data/info-results.jsonl
                                  ↓ 조회 worker
                 state/market-jobs/<event_id>.json
                                  ↓ 목록 캐시에서 후보 검색
                 data/market-results/<event_id>.json

선택한 9곳 공개 API → data/catalogs/<venue>-<segment>.json
```

| 파일 | 의미 |
| --- | --- |
| `data/listings.jsonl` | 감시부가 받은 상장 기록. 원본 `raw` 보존 |
| `data/info-results.jsonl` | `LOOKUP_PENDING` 접수 기록. 실제 조회 완료 결과가 아님 |
| `data/catalogs/*.json` | 상품 목록·원본 필드·출처·갱신/만료 시각 |
| `data/catalogs/status.json` | 상품군별 수집 상태·개수·오류·제외 항목 |
| `data/market-results/<event_id>.json` | 이벤트별 최신 시장 후보 조회 결과 |
| `data/networks/<venue>.json` | 통화별 네트워크·CA·입출금 상태 캐시 |
| `data/identities/<key>.json` | 공식 신원 확인 작업·근거·재시도 상태 캐시 |
| `data/enrichment-results/<event_id>.json` | 동일 토큰·경로 검증, 통과한 현물과 보류 사유 |
| `state/info-consumer.json` | 감시부 기록의 접수 바이트 커서 |
| `state/market-lookup-consumer.json` | 접수 기록을 조회 job으로 등록한 바이트 커서 |
| `state/market-jobs/<event_id>.json` | 재시작 후에도 남는 작업 상태·시도 횟수 |

결과에 현물/무기한, 거래소 상품 ID, 기초·표시·결제 통화, 거래 상태, 확인 가능한 가격/수량 단위, 출처와 유효 시각을 기록한다. 공급자가 주지 않는 값은 `null`/`UNKNOWN`으로 남긴다. Variational의 ID는 공개 티커 라벨이며 실행 상품 ID로 취급하지 않는다.

### 조회 상태

| 상태 | 뜻 |
| --- | --- |
| `CATALOG_CANDIDATES_READY` | 선택한 범위의 최신 목록에서 티커 일치 후보를 찾음 |
| `CATALOG_SEARCH_EMPTY` | 선택한 범위의 원천 기초 티커와 일치 없음. 모든 거래소에 없다는 뜻은 아님 |
| `CATALOG_PARTIAL` | 일부 목록 미조회/오류/만료 또는 해당 코인의 계약 유형 미분류 |
| `SYMBOL_REQUIRED` | 티커가 없는 자산이 있어 추가 식별 필요 |
| `UNVERIFIED` | 동일 코인·실제 거래 경로 확인 전 |
| `trading_allowed: false` | 현재 모든 결과에 강제 적용. 주문 기능 없음 |

카탈로그 상태는 `NOT_FETCHED` / `FRESH` / `STALE` / `ERROR`이다. 실패 시 마지막 정상 목록을 `STALE`로 보존한다. 실패를 정상 빈 목록으로 바꾸지 않는다. 검증된 정상 응답의 빈 목록은 허용한다.

작업 상태는 `QUEUED` → `RUNNING` → `COMPLETE` 또는 `WAITING_IDENTITY` / `WAITING_CATALOG` / `RETRY` / `FAILED`이다. `COMPLETE`는 시장 후보 검색 단계 완료이며 동일 코인 검증 완료가 아니다. 목록 로딩·호출 제한 대기·미분류 계약 보류는 실패 시도 횟수를 소모하지 않는다. 오류가 반복돼 한도를 초과하면 `FAILED`로 남으며 명시적 재시도가 필요하다.

시장 후보 결과는 공지 당시 조회 기록으로 보존하며 이후 목록 갱신마다 자동 재검색하지 않는다. `COMPLETE`·`WAITING_IDENTITY` 작업은 기존 코드에서 다시 검색하지 않으며 `--retry-failed`도 완료 결과를 재작성하지 않는다. 필터 변경만으로 과거 완료 결과가 새 기준으로 바뀌지는 않는다. 별도 신원·경로 결과는 네트워크 캐시·신원 근거·만료 상태 변화에 따라 다시 평가한다. 미래 판단부는 유효 시각과 현재 상태를 다시 확인해야 한다. 현재 호가·잔고·계정 주문 가능 여부를 확인한 결과가 아니다.

## 역할과 지원 범위

| 역할 | 담당 | 현재 상태 |
| --- | --- | --- |
| 감시부 | 피드 수신·상장 선별·파일 기록 | 구현. 실제 인증과 예시 재생 검증 |
| 정보부 | 접수·시장/네트워크 캐시·후보·신원/경로 평가 | 구현. 인증 API 라이브 검증은 남음 |
| 코인 식별·조회부 | 공식 근거·체인/CA | 업비트 단일 Ethereum 공지 API 지원. 다른 형식은 보류 |
| DEX 현물 조회 | 풀·동일 토큰·견적 | 미구현 |
| 판단부 | 전략·정보 유효성·한도·중복 주문·자금 예약 | 미구현 |
| 매매부 | 현물/선물/DEX 스왑·주문/체결 추적 | 미구현 |
| 전송부 | 출금·네트워크/주소/메모·도착 확인 | 미구현 |

| 거래소 | 조회 범위 |
| --- | --- |
| Binance | 현물, USDⓈ-M·COIN-M 무기한. 전통자산 유형은 `TRADFI`로 별도 표시 |
| Bybit | 현물, linear·inverse 무기한. 기본 목록 응답 범위 |
| OKX | 현물, SWAP |
| Bitget | 현물, USDT·USDC·COIN 무기한 |
| Gate | 현물, USDT·BTC·USD1 무기한 |
| Hyperliquid | 기본 시장 + HIP-3 무기한 |
| Aster | V3에서 유형이 확인된 무기한. 빈 유형의 거래 전 상품은 별도 보류 |
| Variational | Omni 공개 시장 라벨. 주문 API는 현재 사용자 미제공 안내 |
| Lighter | 무기한 order book 상세 목록 |
| DEX 현물 | EVM 계열 + Solana 목표. 아직 조회하지 않음 |

Coinbase와 GRVT는 사용자 요청으로 제외했다. CEX 선물 중 현재 구현된 것은 무기한이며 만기 상품을 지원한다고 주장하지 않는다. 자세한 공식 API·형식·예외는 [시장 조회 설계](docs/MARKET_DISCOVERY.md)에 있다.

어떤 코인이 상장할지 미리 아는 구조가 아니다. 미리 받을 것은 선택한 거래소의 현재 상품 목록이다. 처음 보는 코인의 동일성·체인/CA·풀은 이벤트 후 조사하고 확인한 매핑을 재사용한다. 전 세계 토큰·풀을 저장하지 않는다.

티커는 대소문자와 앞뒤 공백을 정리해서 원천 기초 티커와 비교한다. `1000`·`k` 접두사를 추정으로 제거하지 않으며 배수 상품은 검증된 매핑을 추가한 뒤 연결한다. 티커가 같은 다른 프로젝트, 전통자산·지수 상품도 후보 단계에서 동일 코인으로 확정하지 않는다.

후보의 quote 통화는 USDT/USDC, 시장 상태는 ACTIVE로 제한한다. 현물·무기한에 같은 조건을 적용하며 각각 전용 API 목록에서만 확인한다. 담보/결제 통화나 상품 ID의 접미사로 미확인 quote를 추정하지 않는다. 현재 Lighter는 quote 미확인, Variational은 상태 UNKNOWN이라 후보에서 제외된다. 원천 카탈로그 전체와 과거 검사 기록은 보존한다. 기존 NMR 자료는 새 조건으로 재검색 시18→10개이며, 2026-10-06 Binance 현물 전용 API 재검사에서 조건을 만족한 현물은 NMR/USDT 1개다. `data/checks/catalog-live-rRRcos/nmr-spot-check.json`에 근거를 기록했다.

CEX 시장 / Perp DEX 시장 / DEX 현물 풀은 병렬 경로로 설계한다. CEX는 DEX CA 조회를 기다리지 않는다. 미래 주문 허가는 공통 판단부가 처리하고 주문·전송은 별도 실행 모듈로 둔다. AI/Surf는 정보 보충에 사용하고 주문 승인·수량 계산은 정해진 코드 규칙으로 처리한다.

## 캐시·재시도 설정

`config/markets.json`의 기본값이며 속도 보장은 아니다.

| 항목 | 기본값 |
| --- | --- |
| 정상 목록 갱신 | 5분 |
| 목록 유효기간 | 정상 수집 후 10분 |
| HTTP timeout / 상품군 전체 timeout | 10초 / 60초 |
| 동시에 수집할 상품군 | 3개. 같은 호스트는 직렬·최소 200 ms 간격 |
| 오류 재확인 / 조회 최대 시도 | 30초 / 5회 |
| 파일 보완 확인 | 1초 |

HTTP 429/418은 호스트별 대기와 `Retry-After`를 반영한다. 상품군 전체 수집이 성공해야 목록을 교체한다. 원천 오류·잘못된 페이지·미지 계약 유형을 조용히 버리지 않는다. Aster의 명시적인 미분류 거래 전 항목은 `exclusions`에 근거를 남기며 해당 티커가 조회되면 보류한다.

사용자 최종 선택으로 **목록은 기존 5분 주기 갱신을 유지**한다. 상장 이벤트에서 API 갱신을 기다리는 경로는 추가하지 않았다. 감시부는 현재 listing만 저장하며 delisting 기반 갱신도 추가하지 않았다.

### 현물의 입출금 경로 필터 — 구현

현물 후보는 **매수할 거래소의 출금망과 신규 상장 거래소의 입금망이 일치**하는 경로를 확인해야 한다. 같은 코인·같은 체인의 토큰인지 검증하고, 매수처 출금과 도착처 입금이 각각 활성인 경로만 필터를 통과시킨다. 네트워크 이름은 거래소별 확인된 매핑으로 표준 체인 ID에 연결하며, 티커·이름만 같다고 통과시키지 않는다.

예: 신규 상장 거래소가 Ethereum 입금만 받으면, Ethereum 출금을 지원하는 매수처를 선택한다. Solana 출금만 지원하거나 출금이 중단된 경로는 제외한다. 입금망·토큰·현재 상태를 확인하지 못한 후보는 보류한다.

시장·네트워크 목록은 각각 5분마다 갱신한다. 이벤트는 로컬 캐시에서 후보를 먼저 내보내며 신원 API를 기다리지 않는다. 미확인 업비트 공지는 공식 공개 API로 별도 확인하고 재사용한다. 홈페이지 UI는 런타임에서 열지 않는다. 새 코인·미지원 공지 형식은 근거가 없으면 보류한다.

같은 CA·망을 확인한 `NETWORK_COMPATIBLE_HELD`와 현재 입출금 상태까지 조건을 확인한 `FILTER_PASSED`를 구분한다. 네트워크 필터 통과도 최종 매매·전송 승인은 아니다. 무기한에는 현물 전송 필터를 적용하지 않고 기초자산 매핑 전까지 미검증으로 둔다. 업비트 상태 API는 수 분 지연될 수 있는 참고값이므로 반환되더라도 자동 경로 통과 근거로 쓰지 않는다. 세부 조건은 [신원·경로 필터](docs/IDENTITY_NETWORKS.md).

## 검증

아래 명령은 사용법 기록이다. **현재 테스트·라이브 검사는 사용자 요청으로 중단한 상태이며 자동 재실행하지 않는다.** 마지막 전체 실행 결과는 168/168 통과다.

```powershell
npm test                  # 외부 연결 없는 자동 테스트
npm run check:info        # 합성 상장 → 자동 접수 → 9개 후보 결과 저장
npm run check:catalog     # 실제 9곳 공개 목록 조회. 키 없이 실행
npm run check:listing     # 실제 NMR 공지 재구성 + 공개 시장/네트워크/공식 CA 검사

npm run check:replay      # 감시부·파일 전달 재생 검사
node scripts/replay.cjs --file fixtures/official-full-example.jsonl
npm run check:feed        # 실제 NewListings READY + 3초 관찰
```

매번 `data/checks/`에 독립 data/state와 `report.json`을 보존한다. 운영 상장·접수 기록과 커서를 바꾸지 않는다. 합성 결과는 실제 거래소 상장 검증으로 취급하지 않는다.

2026-10-06 확인:

- 최종 자동 테스트 **168/168 통과**. Gate 매도 전용·OKX 프리마켓/미지 룰 제외, 이전 캐시 제한 조건, 네트워크 경로 보류까지 포함한다. 이후 사용자 요청으로 추가 실행을 중단했다.
- 최신 공개 API **9곳·20/20개 상품군 수집 성공**: `data/checks/catalog-live-AmgPvO/report.json`. 당시 자료를 현재 조건으로 검사한 `market-status-audit.json`에서 NMR 현물5개·무기한5개와 제한 페어5개 제외를 확인했다. OKX raw는 현재 어댑터로 재정규화했고 과거 원본 파일은 보존했다.
- 이전 NMR 통합 검사: `data/checks/nmr-live-BfgCMG/report.json`. 필터 적용 전 후보18개, Bitget/Gate 현물3개 페어 CA·망 일치, 입금 상태 인증 미조회로0개 통과. 실제 WebSocket 원본 수신이 아닌 사용자 링크·공식 공지 재구성이다. 이 검사는 계정 키를 로드하지 않는다.
- 마지막 합성 정보부 검사: 자동 파일 감지로9개 미검증 후보 저장 성공. `data/checks/info-offline-yUYYcj/report.json`. 이후 제한 페어 수정은 전체 자동 테스트로 검증했다.
- 기존 무료 피드: `READY` 성공, `feed_free`, 추가 `delay_ms: 3000`. 짧은 관찰 중 실제 새 상장 0건. `data/checks/live-FNBsxB/report.json`.
- 합성 재생 9개 입력 → 고유 상장 6개 접수. 공식 Full PONS 예시 1개 접수 성공. 공개 문서 예시이며 우리 키로 받은 과거 원본이 아님.
- 이전 로컬 재생 지연 p50 25.103 ms / 최대 999.187 ms. 외부 피드·인터넷 지연 제외. 일부 1초 경로와 실수신 상장 전체 지연은 추가 실측 대상.

무료키의 History 미지원 때문에 과거 원본은 확보하지 못했다. [공식 예시 출처·한계](fixtures/official-full-example.md), [History 안내](https://newlistings.pro/docs/v2/history).

## 파일 구조

```text
newlistingbot/
├─ client.cjs / info.cjs / catalog.cjs
├─ config/markets.json
├─ lib/
│  ├─ listing-event.cjs / info-consumer.cjs
│  ├─ jsonl.cjs / lock.cjs / paths.cjs
│  ├─ feed-check.cjs / replay.cjs
│  ├─ markets/
│  │  ├─ adapters/            # 선택한 9곳 원천 API
│  │  ├─ model.cjs / registry.cjs
│  │  ├─ http.cjs / catalog.cjs
│  │  └─ matcher.cjs / lookup-worker.cjs
│  └─ networks/              # 네트워크 캐시·신원·CA·경로 평가
├─ scripts/                  # 피드·재생·정보부 검사
├─ test/ / fixtures/
├─ data/                     # 상장·접수·목록·후보 결과·격리 검사
├─ state/                    # 커서·조회 job·실행 잠금
├─ docs/MARKET_DISCOVERY.md
├─ docs/IDENTITY_NETWORKS.md
├─ SESSION_CONTEXT.md
└─ .env                      # 피드 키. Git 제외
```

## 운영 규칙과 남은 일

- 입력은 추가 기록 방식. 완성된 줄만 읽고 UTF-8 바이트 커서를 저장한다. 잘못된 완성 JSON·파일 교체/축소·완료 결과 유실은 중단한다.
- 접수 결과 → 접수 커서, 조회 job → 조회 접수 커서, 후보 결과 → job 완료 순서로 저장한다. 재시작 시 ID로 중복 처리를 막는다.
- 불완전 꼬리는 작성자 재시작 시 `.partial-*`에 보존한다. `data/`와 `state/`는 함께 보존하고 입력·결과를 임의로 비우지 않는다.
- 잠금은 감시부·접수·목록·조회 worker별로 둔다. `start:catalog`와 기본 정보부는 같은 목록 잠금을 사용한다.
- 조회 job은 5만 건 상한. 자동 기록 순환/보관은 아직 없으며 상한 도달·손상 데이터는 건너뛰지 않고 중단한다.
- OneDrive에서도 같은 PC의 로컬 파일로 전달한다. 컴퓨터 간 동기화 전달, 피드 단절 중 소식 자동 복구는 지원하지 않는다.

다음은 **인증 네트워크 API 실제 검증·다른 거래소 공지 파서·무기한 기초자산 검증**, 이후 **EVM/Solana DEX 현물 풀·견적 조회**다. 전략·한도 합의 → 판단부·모의 실행 → 현물/선물 → 별도 전송부 순서로 진행한다.

추후 확정할 것: 개별 EVM 네트워크·현물 실행 DEX, 배수 상품의 검증 매핑, 만기 선물 필요 여부, 전략·한도, 유료 API/피드, 기록 보관·성능 목표.
