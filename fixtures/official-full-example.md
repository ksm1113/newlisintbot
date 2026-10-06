# 공식 Full 문서 예시

- 확인 날짜: 2026-10-06 (Asia/Seoul).
- JSON 출처: [NewListings Full — Binance Alpha 2.0 live 예시](https://newlistings.pro/docs/v2/full#alpha-live), `Examples`의 `Listing: live on Binance Alpha 2.0` 절.
- 설명 근거: [NewListings Historical API](https://newlistings.pro/docs/v2/history)의 `How stored events differ from WebSocket events` 절. 이 문서는 위 Alpha Live 예시를 실제 history 응답 예시(`real history response`)로 안내한다.
- `official-full-example.jsonl`에는 해당 PONS 예시의 모든 필드와 값을 그대로 넣었다. JSONL 재생을 위해 공백·들여쓰기만 한 줄로 바꿨다.

이 파일은 **공식 공개 문서 예시**이며, **우리 API 키로 직접 수신한 원본 메시지가 아니다.** History 응답 역시 WebSocket 메시지와 byte-for-byte로 같은 재생본이 아니며, 과거 레코드에는 분류 필드나 ID 형태의 차이가 있을 수 있다.

이 예시에는 프로젝트 이름·metrics·확정 contracts·DEX pairs 등 유료 필드가 포함되어 있다. 무료키의 실제 반환 범위를 검증하는 예시로 취급하지 않는다. [Full 필드별 플랜 안내](https://newlistings.pro/docs/v2/full)

**무료키는 History API를 지원하지 않는다.** 현재 무료키로 과거 Full 메시지를 조회할 수 있다는 의미가 아니다. [History 안내](https://newlistings.pro/docs/v2/history)

재생은 입력 처리·분류 보존·파일 전달을 확인하는 용도다. `alpha-live`를 Binance CEX 현물 거래 가능으로 해석하거나, 문서의 과거 CA·풀·시세를 현재 거래 정보로 취급하지 않는다.
