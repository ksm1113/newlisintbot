# 재생 입력

`replay-feed.jsonl`은 **합성(SYNTHETIC) 테스트 데이터**다. 실제 피드 캡처나 과거 상장 기록이 아니다. 거래소는 `test-exchange`, 링크는 접근용이 아닌 `.invalid` 주소다.

제어 메시지, 비상장 공지, 현물, 선물, 로드맵, 다중 자산, 자산 누락, 중복 재수신, tweet을 포함한다. 총 9개 메시지에서 상장 7개를 기록하고 고유 이벤트 6개를 조회 대기로 접수해야 한다.

```powershell
node scripts/replay.cjs
node scripts/replay.cjs --file "경로\feed.jsonl"
```

`--file`은 한 줄에 하나의 JSON 메시지가 있는 파일을 받는다. 프로젝트 `listings.jsonl`처럼 `schema_version: 1`, `event: listing`, `raw`가 있는 기록은 `raw`를 추출한다. 빈 줄은 무시하고, 마지막 줄바꿈이 없는 완성 JSON도 허용한다. 입력은 16 MiB, 한 줄은 2 MiB, 메시지는 20,000개로 제한한다. 사용자 제공 파일이 진짜 피드 원본인지는 이 도구가 보증하지 않는다.

프로젝트에 포함된 `official-full-example.jsonl`을 명시하면 보고서에 `DOCUMENTATION_EXAMPLE`로 구분한다. 출처·한계는 `official-full-example.md`에서 확인한다. 직접 수신한 피드 원본으로 표시하지 않는다.

매회 `data/checks/replay-*` 아래 별도 `data/`, `state/`, `report.json`을 보존한다. 운영 중인 `data/listings.jsonl`, `data/info-results.jsonl`, `state/info-consumer.json`에 테스트 기록을 추가하지 않는다. 외부 피드에 접속하지 않으며 주문·전송도 없다.

정보부의 파일 감지와 1초 보완 확인을 실행한 상태에서 자동 접수를 기다린다. 재생 후 강제 읽기로 성공 처리하지 않는다. 보고서의 p50/최대 지연은 가짜 소켓 수신부터 로컬 조회 대기 결과·커서 저장까지이며, 메시지를 기록 속도에 맞춰 순서대로 재생한다. 외부 피드의 전송 지연이나 최대 처리량을 측정한 수치는 아니다.
