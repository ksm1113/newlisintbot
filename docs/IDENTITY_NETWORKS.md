# 동일 토큰·현물 경로 필터

2026-10-06 구현. 주문·출금·전송은 없다.

> 최신 정책·검증 개수는 [README](../README.md)와 [인수인계](../SESSION_CONTEXT.md)를 우선한다. 아래 NMR 현물3개 페어는 초기 CA·망 검사의 대상이며 현재 USDT/USDC·ACTIVE 시장 후보 개수가 아니다. 매수 중단·OKX non-normal 룰은 경로 필터에서도 보류한다. 마지막 전체 테스트168/168 통과 이후 추가 테스트는 사용자 요청으로 중단했다.

## 속도와 역할

시장 목록과 통화별 네트워크 목록은 별도 캐시로 5분마다 갱신한다. 이벤트가 들어오면 기존 `LookupWorker`가 로컬 시장 후보를 바로 기록한다. `EnrichmentWorker`는 그 결과 파일을 읽어 로컬 CA·체인·입출금 상태를 평가한다. 시장 결과 생성은 공지 확인·네트워크 API를 기다리지 않는다.

처음 보는 업비트 공식 공지는 별도 큐에서 공식 공개 API로 확인한다. 캐시에 없을 때만 확인하고 동일 공지 결과는 7일간 재사용한다. 동시에 최대 2건, 실패는 30초 후 재시도, 미지원 형식은 5분 후 재확인한다. 결과가 없는 동안 `WAITING_OFFICIAL_IDENTITY`다. 모든 신원 API 조회를 생략하면서 처음 보는 토큰까지 검증됐다고 취급하는 기능은 없다.

업비트 지원 파서는 실제 NMR 공지의 단일 종목·Ethereum 표·입출금망 문장·종목에 연결된 전체 CA 문장만 읽는다. 본문에서 첫 주소를 주워 쓰지 않는다. 다중 종목·미지 형식·다른 네트워크·CA 충돌은 보류한다. 빗썸 및 다른 거래소 공식 공지 파서는 아직 없다.

## 저장 파일

| 파일 | 의미 |
|---|---|
| `data/market-results/<event_id>.json` | 기존 후보 조회. 신원 미검증 원본 단계 |
| `data/networks/<venue>.json` | 정상 통화/chain 목록·출처·확인/만료 시각. 실패 시 마지막 자료와 오류 보존 |
| `data/identities/<key>.json` | 공식 공지 확인 큐·확인 근거·다음 조회 시각. 재시작 복구 |
| `data/enrichment-results/<event_id>.json` | 후보별 동일성·경로 상태·보류 사유·필터 통과 현물 목록 |
| `config/verified-listings.json` | 선택 사항. 별도 확인한 공식 근거 anchor 배열. 자동 근거는 data/identities에 저장 |

동일 후보도 시장 ID/표시 통화가 다르면 여러 페어로 기록된다. 따라서 NMR 현물 3개 페어는 Bitget·Gate 두 거래소다. 완료 시장 결과를 네트워크 갱신 때문에 다시 검색하지 않는다. 기존 후보의 경로 조건만 다시 평가한다.

## 조건과 상태

- `VERIFIED`: 유효한 공식 상장 자산 근거와 매수처 통화의 동일 체인·전체 CA 일치. 원천 티커만 같거나 무기한 지수 이름이 같아서는 안 된다.
- `NETWORK_COMPATIBLE_HELD`: CA·입금 지원망 일치, 현재 입출금 상태 등 추가 조건 확인 전.
- `FILTER_PASSED`: 시장 ACTIVE·시장/네트워크 캐시 유효, 출금 활성·입금 활성, 알려진 출금 지연/폐지/CA 충돌 없음. 캐시 조건 필터이며 주문 가능 판정이 아니다.
- `AUTH_REQUIRED`: 인증 없어서 미조회. 해당 거래소가 네트워크를 지원하지 않는다는 뜻이 아니다.
- `NOT_IN_ACCOUNT_SCOPE`: 정상 API 목록에 해당 통화 없음. KYC 법인·계정 범위 제한을 고려하며 전 세계 미지원으로 해석하지 않는다.

모든 결과는 `trading_allowed:false`다. 무기한 후보는 공식 기초자산/지수 매핑 전까지 `UNVERIFIED`, 현물 전송 필터는 `NOT_APPLICABLE`이다. native 코인은 빈 CA를 신원 증거로 인정하지 않으므로 별도 검증 모델 전까지 보류한다. EVM 전체 40자리 hex·Solana 32바이트 mint만 CA 비교를 지원한다. 체인 별칭은 거래소별 정확한 allowlist이며 미지 별칭은 보류한다.

Upbit wallet 상태는 [공식 문서](https://docs.upbit.com/kr/reference/get-service-status)에서 수 분 지연될 수 있는 참고 정보라고 안내한다. 해당 API 값만으로 현재 입금 확정을 자동 통과시키지 않으며 `DESTINATION_STATUS_ADVISORY`로 보류한다. 실제 전송에는 추후 별도 상태 재검증·주소/메모·계정/수량 조건이 필요하다.

## 인증 설정

Bitget/Gate는 공개 네트워크 API를 사용한다. Binance/Bybit/OKX/Upbit는 공식 인증 조회 어댑터를 구현했지만 이번 NMR 실검사는 계정 키 없이 공개 API만 호출했다.

정보부 실행 시 `.env`에서 아래 이름을 읽는다. 실제 값은 문서·로그·결과에 기록하지 않는다.

| 거래소 | 변수 이름 |
|---|---|
| Binance | `BINANCE_API_KEY`, `BINANCE_API_SECRET` |
| Bybit | `BYBIT_API_KEY`, `BYBIT_API_SECRET` |
| OKX | `OKX_API_KEY`, `OKX_API_SECRET`, `OKX_API_PASSPHRASE` |
| Upbit | `UPBIT_API_KEY`, `UPBIT_API_SECRET` |

네트워크 requester는 지정된 6개 metadata GET endpoint만 허용한다. POST·주문·출금 endpoint는 거부한다. 계정 잔고·개인 입금주소·할당량·전체 사설 응답 raw를 저장하지 않는다. API 지원과 계정별 조회 권한 확인은 별개다.

## 공식 출처

- [Binance coin/network config](https://developers.binance.com/en/docs/catalog/core-trading-wallet/api/rest-api/capital)
- [Bybit coin info](https://bybit-exchange.github.io/docs/v5/asset/coin-info)
- [OKX funding currencies](https://my.okx.com/docs-v5/en/#rest-api-funding-get-currencies)
- [Bitget public coins](https://www.bitget.com/zh-CN/docs/catalog/classic-spot-market/classic-spot-market)
- [Gate currencies](https://www.gate.com/docs/developers/apiv4/en/spot/)
- [Upbit NMR 공지](https://upbit.com/service_center/notice?id=330345227), 공식 페이지에서 관측·실조회한 [공개 공지 API](https://pub-info.upbit.com/api/v1/announcements/330345227)
- [Numerai 공식 NMR CA](https://docs.numer.ai/numerai-crypto/staking)

공개 공지 API는 공개 웹페이지에서 발견한 접근점이며 안정성을 보장하는 개발자 계약 API라고 주장하지 않는다. 형식 변경 시 파싱을 중단하고 보류한다.
