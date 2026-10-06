# 다음 모델 인수인계 — 2026-10-06

이 파일은 최신 상태로 정리한 요약이다. 예전 단계의 “네트워크 필터 미구현”, “최종 87/161/164개 테스트”, “현재 후보18개” 기록은 현재 상태를 뜻하지 않는다. 재개 시 이 파일과 README.md, AGENTS.md를 먼저 읽고 최신 사용자 요청과 실제 코드를 우선한다.

## 현재 중단점과 사용자 지시

- 최신 개발 작업: 다른 거래소도 중단·거래 제한 페어를 집계하는지 검토하고 수정 완료.
- 마지막 전체 node --test 결과 **168/168 통과**. 이후 사용자가 **“다 만들었으면 테스트는 일단 멈춰봐”**라고 요청했다. 테스트·라이브 검사를 추가 실행하지 말고 후속 사용자 지시를 따른다. 이번 문서 정리에서는 코드 수정·테스트·거래소 API 실행을 하지 않았다.
- 최신 요청: 지금까지의 작업을 README에 기록하고 다른 모델이 이어받을 기록을 남긴 뒤 /compact. README와 이 파일에 인수인계를 저장했다. 현재 세션에는 이 채팅의 compact를 실행하는 도구가 없어 실행 완료로 보고하지 않는다. 사용자 입력창의 /compact 실행이 남아 있다.
- 사용자 설명은 한국어로 핵심만 짧고 쉽게. 가벼운 커뮤니티 말투 가능. 긴 설명·추가 대기·과한 구조를 싫어한다.
- 설계를 합의한 범위에서 구현한다. 새 봇·프로세스·큐·전체 구조를 더 늘리거나 주문·전송을 임의로 구현하지 않는다. 기존 캐시 → 비교 → 결과 저장의 단순한 흐름을 원한다. 현재 코드를 대규모로 줄이는 리팩터링은 수행하지 않았다.
- 작업물은 커밋되지 않은 상태다. 기존 변경을 되돌리지 않는다. .env·키는 출력하거나 문서·로그에 기록하지 않는다.

## 확정된 설계

- CEX5곳: **Binance, Bybit, OKX, Bitget, Gate**.
- Perp DEX4곳: **Hyperliquid, Aster, Variational, Lighter**. Coinbase·GRVT는 사용자 요청으로 제외.
- **5분마다 API 상품 목록 갱신, 정상 수집 후 TTL10분. 상장 이벤트는 로컬 캐시에서 검색.** 이벤트 listing/delisting 기반 갱신 제안은 사용자가 취소했다. 갱신을 기다렸다가 해당 상장 건을 재검색하는 경로를 추가하지 않는다.
- 코인을 미리 예측하거나 전 세계 토큰·풀을 매핑하지 않는다. 선택한 거래소의 현재 상품 목록만 미리 받는다. 처음 보는 코인 신원·CA·풀은 이벤트 이후 확인하고 검증된 근거를 재사용한다.
- 현물·무기한 후보는 **원천 quote가 USDT/USDC이고 market_status=ACTIVE**인 상품만. 현물은 현물 전용 API, 무기한은 무기한 전용 API에서 읽는다. All 화면이나 전체 카탈로그 개수를 현물 개수로 설명하지 않는다.
- 티커는 공백 정리·대소문자 무시 비교만 한다. 1000·1M·k 배수 접두사, quote·담보 통화를 추정으로 연결하지 않는다. 티커 일치 후보와 동일 코인 검증을 구분한다.
- 현물 매수처 출금망과 신규 상장 거래소 입금망이 동일하고, 같은 체인·전체 CA·상태 조건까지 확인해야 경로 필터를 통과한다. 미조회·미검증은 보류한다.
- DEX 현물의 목표는 EVM 계열+Solana. 개별 EVM 네트워크·실행 DEX는 아직 미확정이며 풀 조회도 미구현이다.

## 구현된 흐름과 파일

```text
NewListings → client.cjs → data/listings.jsonl
                               ↓ InfoConsumer
                      data/info-results.jsonl (LOOKUP_PENDING 접수)
                               ↓ LookupWorker
                  state/market-jobs/<event_id>.json
                               ↓ 로컬 시장 목록 검색
                  data/market-results/<event_id>.json
                               ↓ 별도 신원·경로 평가
                  data/enrichment-results/<event_id>.json

선택한 9곳 공개 API → data/catalogs/<venue>-<segment>.json
소스 CEX5+Upbit 네트워크 API → data/networks/<venue>.json
공식 공지 조회·신원 근거 → data/identities/<key>.json
```

- client.cjs: WebSocket 인증/재접속, listing만 선별, 여러 assets·분류·raw·내부 event ID 보존.
- lib/info-consumer.cjs, lib/jsonl.cjs: 완성된 UTF-8 줄, 바이트 커서, flush 후 커서 저장, 중복 방지·잠금·불완전 꼬리 복구. 파일 축소/교체·완성 JSON 손상은 중단한다.
- lib/markets/: model·registry·HTTP·Catalog·matcher·lookup-worker·9개 adapter. 상품군20개: Binance3/Bybit3/OKX2/Bitget4/Gate4/각 Perp DEX1. 페이지 완주, 원천 상태·계약 단위·정밀도 보존. 만기 선물 제외.
- Catalog는 상품군 전체 수집 성공 후 원자적으로 교체. 실패하면 마지막 정상 목록을 STALE로 보존하고 ERROR·정상 빈 목록을 구분한다. 429/418·Retry-After·호스트 직렬/간격·timeout 처리.
- lib/networks/: 소스 CEX5+Upbit metadata adapter, read-only HTTP, 5분 캐시·10분 TTL, 체인/CA 비교, 입출금 경로 평가, 신원 조회·별도 enrichment worker. 기본 정보부와 --lookup-once에 연결돼 있다.
- 시장 후보 파일 저장은 신원·네트워크 API를 기다리지 않는다. 별도 작업이 신원 cache MISS인 업비트 공식 공지를 API로 확인한다. 런타임은 거래소 홈페이지 UI를 열지 않는다.
- Upbit 자동 파서는 **단일 코인·Ethereum 공지 형식만** 지원. 다중 종목·다른 망·미지 형식·충돌 CA는 보류. 빗썸 및 다른 거래소 공지 자동 식별은 미구현.
- 신원 anchor는 날짜·공식 근거·코인/거래소·체인/전체 CA·입금망에 연결. NOTICE는 공지 URL에 묶이고 VENUE_ASSET는 검증된 거래소 자산 근거 재사용. 충돌·만료·미지 체인은 보류.
- 후보 검색 결과는 asset_id:null, identity_status:UNVERIFIED. 신원/경로 평가 결과만 별도로 VERIFIED를 기록할 수 있다. **모든 단계 trading_allowed:false**, 실제 주문·출금·전송 없음.
- 상세 근거·인증 환경변수 이름·한계는 docs/IDENTITY_NETWORKS.md, 시장 원천은 docs/MARKET_DISCOVERY.md 참고. 비밀 값은 문서에 없다.

## 최근 수정 — 거래 제한 페어

- lib/markets/matcher.cjs: quote USDT/USDC·ACTIVE·venue/segment/market_type 일치 필수. 현물 limits.buy_enabled=false 제외. OKX 명시적인 non-normal limits.ruleType도 제외해 예전 캐시의 ACTIVE 정규화가 제한을 우회하지 못하게 한다.
- Binance spot는 TRADING이어도 isSpotTradingAllowed=false면 INACTIVE, 누락이면 UNKNOWN으로 보류.
- Gate sellable은 매도만 가능하므로 현물 매수 후보에서 제외. 실제 **MSP_USDT1개**에서 누락 확인. buyable·tradable은 매수 후보로 유지.
- lib/markets/adapters/okx.cjs: state live라도 ruleType pre_market·rebase_contract·미지/빈 룰은 UNKNOWN. normal 또는 필드 없는 기존 응답만 ACTIVE. 실제 SWAP4개 ANTHROPIC/MOONSHOT/OPENAI/OURA-USDT-SWAP가 pre_market였으며 일반 무기한 후보에서 제외. 거래 중단과 별개의 상품 범위 제한이다.
- lib/networks/verify.cjs: 과거 결과의 매수 중단 현물은 SPOT_BUY_DISABLED, OKX non-normal 룰은 RESTRICTED_MARKET_RULE로 경로 통과 보류. CA/망 일치만으로 제한을 우회하지 못한다.
- Bybit/Bitget/Gate 무기한의 중단·거래 전·제한 상태, Hyperliquid isDelisted, Aster 정산, Lighter inactive는 후보에서 제외되는 것을 확인했다. Variational은 상태 UNKNOWN, Lighter는 quote 미확인이라 현재 후보에서 제외. 전 세계 미상장이라는 뜻이 아니다.
- Gate/Bitget 자료에서 이미 폐지·신규 주문 제한 시각을 지난 ACTIVE USDT/USDC 행은 없었다. 별도 예정 시각 필터는 추가하지 않았다. 목록 갱신 사이 실시간 상태를 보장하지 않는다.
- adapter→matcher·예전 캐시·네트워크 보류 회귀 검사는 test/markets-cex-a.test.cjs, test/markets-cex-b.test.cjs, test/network-verify.test.cjs에 있다.

## 실제 검사 근거와 개수

| 기록 | 뜻 |
| --- | --- |
| data/checks/catalog-live-AmgPvO/report.json | 최신 공개 API9곳·20/20상품군 실제 수집 성공 |
| data/checks/catalog-live-AmgPvO/market-status-audit.json | 당시 자료의 현재 정책 검사. NMR 현물5개·무기한5개, Gate1개+OKX4개 제외, 위반0개. OKX raw를 현재 adapter로 재정규화했으며 원본 파일 보존 |
| data/checks/catalog-live-rRRcos/nmr-spot-check.json | Binance 현물 전용 재검사. NMRUSDT1개; NMRUSDC BREAK, NMRTRY는 quote 제외 |
| data/checks/nmr-live-BfgCMG/report.json | 이전 NMR 통합 검사. 필터 적용 전 후보18개, Bitget/Gate 현물3개 페어 CA·Ethereum 일치. Upbit 현재 입금 상태 인증 미조회로 경로0개 통과 |
| data/checks/info-offline-yUYYcj/report.json | 마지막 격리 합성 정보부 전달 검사. 실제 상장/시장 검증이 아님 |
| data/checks/live-FNBsxB/report.json | 이전 무료 피드 READY·feed_free·추가delay_ms3000 확인. 짧은 관찰 중 실제 신규 상장0건 |

NMR 최신 **시장 후보** 개수는 조회 시점 기준. CA·입출금 필터 통과 개수나 현재 주문 가능한 거래소 개수로 설명하지 않는다.

| CEX | NMR 현물 후보 | NMR 무기한 후보 |
| --- | --- | --- |
| Binance | NMR/USDT1개 | NMR/USDT1개 |
| Bybit | 0개 | NMR/USDT1개 |
| OKX | NMR/USDT·NMR/USDC2개 | NMR/USDT1개 |
| Bitget | NMR/USDT1개 | NMR/USDT1개 |
| Gate | NMR/USDT1개 | NMR/USDT1개 |

NMR 알림 링크: https://newlistings.pro/listings/upbit/nmr-104e6va74go?utm_source=tg . 실제 WebSocket 원본 대신 사용자 링크·공식 공지로 통합 검사를 재구성했다. Upbit notice uuid330345227(내부 data.id6642와 다름), Ethereum CA 0x1776e1F26f98b1A5dF9cD347953a26dd3Cb46671. 공식 공개 GET https://pub-info.upbit.com/api/v1/announcements/330345227 로 확인했다. 네이티브 코인의 빈 CA는 검증 근거로 취급하지 않는다.

이전 테스트 개수87→161→164는 단계별 기록이며 마지막 전체 실행은168통과. 무료키 History 미지원으로 과거 실수신 원본은 확보하지 못했다. fixtures의 Full PONS는 공식 문서 예시이지 우리 키가 받은 원본이 아니다. 기존 합성 지연 p50 25.103ms/최대999.187ms는 인터넷·피드 지연을 제외한 기록이고 성능 보장이 아니다.

## 재개 시 주의할 코드 동작

- LOOKUP_PENDING은 접수이며 실제 조회 완료가 아니다. COMPLETE는 후보 검색 완료이며 동일 코인·경로 검증 완료가 아니다.
- LookupWorker terminal은 COMPLETE·WAITING_IDENTITY. 목록 갱신·필터 변경·--retry-failed는 기존 완료 결과를 재검색/재작성하지 않는다. 과거 검사18개를 새 필터가 자동 수정했다고 설명하지 않는다. 재처리 정책은 별도 합의 전 커서/job 삭제로 우회하지 않는다.
- 별도 신원·경로 결과는 시장 결과·네트워크/신원 근거·만료 변화에 따라 재평가. NETWORK_COMPATIBLE_HELD는 CA·망 일치에 불과하고 FILTER_PASSED도 캐시 조건 필터이지 거래 허가가 아니다.
- Binance/Bybit/OKX/Upbit 인증 네트워크 adapter는 오프라인 검증만 했다. AUTH_REQUIRED는 미조회이며 미지원이 아니다. Bitget/Gate 공개 네트워크는 이전 NMR 검사에서 실제 조회.
- Upbit wallet 상태 API는 수 분 지연될 수 있는 참고값이라 키를 붙여도 그것만으로 현재 상태를 자동 통과시키지 않는다. 무기한은 공식 기초자산/지수 매핑 전까지 UNVERIFIED이며 현물 전송 필터는 NOT_APPLICABLE.
- 운영 data/listings.jsonl, data/info-results.jsonl은 인수인계 시 확인한 결과 각각0바이트. 실제 신규상장 원본 수신·전 구간 지연 실측 완료를 주장하지 않는다. 격리 검사는 data/checks/만 사용.
- data/state 함께 보존. 커서·완료 결과 손상·파일 축소/교체는 중단한다. job5만건 상한, 자동 기록 보관/순환 미구현. 같은 PC의 로컬 파일 전달이며 OneDrive PC간 전달·피드 단절 중 자동 복구 미지원.

## 실행 명령 — 현재 실행 요청 아님

```powershell
npm run start:watcher       # 실제 NewListings 수신
npm run start:info          # 목록/네트워크 갱신 + 접수 + 후보/경로 평가
npm run info:once           # API 없이 오프라인 접수만
npm run info:lookup-once    # 공개 목록 갱신 + 미완료 작업1회
node info.cjs --lookup-once --retry-failed
npm run catalog:once       # 목록만. start:info와 같은 잠금이므로 동시 실행 금지
```

Node.js22 이상. config/markets.json: 갱신5분/TTL10분/HTTP timeout10초/상품군 timeout60초/동시상품군3/조회재시도30초·최대5회. 같은 호스트는 직렬·최소200ms간격. npm test, check:info, check:catalog, check:listing, check:replay, check:feed 사용법은 README에 있고 현재 사용자 요청으로 실행을 중단한 상태다.

## 남은 일 — 다음 구현 항목은 사용자와 선택

1. 인증 네트워크 API 실제 계정 범위 연결·검증. 비밀 값 노출 금지.
2. 빗썸 등 다른 공지 형식·체인·여러 종목의 공식 신원 식별 지원.
3. 무기한 기초자산·지수·배수 상품의 검증된 매핑.
4. EVM/Solana DEX 현물 풀·프로토콜 검증·실제 금액 견적. 체인/DEX부터 확정.
5. 이후 전략·한도 합의 → 판단부·모의 실행 → 매매부 → 별도 전송부. 지금 주문·전송 미구현.

AI/Surf는 정보 보충 후보이며 현재 자동 거래 경로에 붙이지 않았다. 처음 보는 코인·풀 자동검증 전체 완료, 실시간 호가·잔고·계정 주문 권한·실제 주문/전송 구현을 주장하지 않는다. 새로운 작업 지시 없이 이 남은 항목을 자동으로 이어서 구현하지 않는다.
