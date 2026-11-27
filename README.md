# 🥒 피클 합동 회의실 (Pickle Meeting Room)

귀여운 피클들이 함께 모여 회의하는 합동 회의실 웹앱입니다. 화면은 출석 피클 · 회의 안건 & 공동 할 일 · 말풍선 채팅방 세 패널로 구성됩니다.
빌드 도구 없이 `index.html` · `styles.css` · `app.js` 세 파일로 동작하는 정적 사이트입니다.

**사이트:** https://seok0801.github.io/pickle-meeting-room/

## 기능

- **초대 전용 잠금** — 방 ID와 초대 키가 없는 기본 주소로 열면 회의실 대신 잠금 화면
  (“초대 전용 비공개 회의실 — 대장님의 초대 링크 또는 방 ID·초대 키를 입력해야 입장할 수 있습니다”)이 뜨고,
  방 데이터는 하나도 내려받지 않습니다. 잠금 화면의 입력 폼으로 방 ID·초대 키를 직접 넣어도 입장할 수 있습니다.
- **초대 링크(`?room=<방 ID>&key=<초대 키>`)** — 이 링크로 열면 잠금 화면 없이 바로 그 방에 연결됩니다.
  상단 회의실 칩의 **복사** 버튼이 방 ID와 초대 키가 함께 든 전체 초대 링크를 복사합니다.
  저장(localStorage)도 방 ID + 초대 키마다 따로 쓰여, 한 방의 내용이 다른 방으로 섞이지 않습니다.
- **키가 틀리면 입장 불가** — 초대 키가 틀렸거나 데이터베이스가 읽기를 거부(401/403)하면 방에 들어가지 못하고 잠금 화면에 오류가 표시됩니다.
- **출석 피클 보드** — 참석한 피클 목록, 각자의 상태(온라인 / 작업중 / 대기) 변경, 새 피클 출근.
- **회의 안건 & 공동 할 일** — 안건·할 일 추가, 완료 체크, 전체/안건/할 일/미완료 필터, 담당 지정.
- **회의 채팅방 (말풍선 대화)** — 피클 앱/카카오톡 스타일 말풍선 채팅창이 화면의 주 영역입니다.
  우리 측(`who: '나'`, `who: '주봇'`)은 오른쪽, 외부 피클(모모 등)은 왼쪽으로 좌우가 교차되고,
  오른쪽에서도 나는 노란 말풍선·`나` 배지, 주봇은 파란 말풍선·이름 배지로 구분됩니다.
  입력창에서 Enter 또는 **전송** 버튼으로 보내면 RTDB로 실시간 공유되어 새 메시지가 바로 말풍선으로 붙습니다.
  데이터는 기존 `timeline` 배열(`who`·`text`·`ts`·`kind`)을 그대로 쓰므로 예전 기록과 호환됩니다.
- **진행 중(•••) 표시** — 출석 피클 중 상태가 `작업중`인 피클이 있으면 채팅 입력창 위에 움직이는 점 세 개와
  “이름 · 역할 처리 중…” 말풍선이 뜨고, 온라인/대기로 바뀌면 즉시 사라집니다. RTDB에 새 필드를 만들지 않고 `pickles[].status`만 씁니다.
- **실시간 동기화** — 같은 방에 초대받아 들어온 기기·피클끼리 SSE 스트림으로 실시간 공유하고, 스트림이 끊기면 자동으로 폴링으로 전환합니다.
- **하단 독 3탭 · 반응형** — 둥근 플로팅 독으로 `채팅`(기본) · `안건` · `참가자` 화면을 전환합니다.
  화면 높이를 꽉 채우는 단일 앱 컨테이너(최대 820px)에 채팅 입력창이 독 바로 위에 붙고, 모바일 390px / 태블릿 / 데스크탑이 같은 구조입니다.
  가로 넘침 없음, `prefers-reduced-motion` 존중.

## 동기화 · 초대 전용 데이터 구조

- Firebase 프로젝트: `pickle-meeting-room-rtdb` (요금제 **Spark / 무료 $0**, 카드 미연결)
- Realtime Database 리전: 싱가포르(asia-southeast1)
- 데이터 경로: **`rooms/<방 ID>/<초대 키>`** — 초대 키가 경로에 들어 있어야만 규칙을 통과합니다.
- 보안 규칙: 루트 · `rooms` · `rooms/<방 ID>`는 읽기/쓰기를 모두 닫아 두어 전체 방 목록(`rooms.json`)이나
  방 단위(`rooms/<방 ID>.json`) 조회를 401로 막고, `rooms/<방 ID>/<초대 키>`에서만 필드 존재·길이를 검증한 뒤 통과시킵니다.
  규칙 본문은 공개되지 않습니다(비로그인 `GET /.settings/rules.json` → 403).

```json
{"rules":{".read":false,".write":false,"rooms":{".read":false,".write":false,"$roomId":{".read":false,".write":false,"$inviteKey":{".read":"<초대 키 일치 검사>",".write":"<초대 키 일치 검사>",".validate":"newData.hasChildren(['version','updatedAt'])","version":{".validate":"newData.isNumber()"},"updatedAt":{".validate":"newData.isNumber()"},"pickles":{"$id":{".validate":"newData.hasChildren(['name']) && newData.child('name').val().length <= 24"}},"items":{"$id":{".validate":"newData.hasChildren(['title']) && newData.child('title').val().length <= 160"}},"timeline":{"$id":{".validate":"newData.hasChildren(['text']) && newData.child('text').val().length <= 400"}},"$other":{".validate":false}}}}}}
```

> 🔒 실제 방 ID와 초대 키는 이 저장소·커밋·README에 적지 않습니다. 초대 링크로만 나눠 주고,
> 키를 교체하면(콘솔 규칙의 키 상수를 바꾸고 새 경로로 데이터를 옮기면) 기존 초대 링크는 즉시 401로 회수됩니다.

## 배포

`main` 브랜치에 푸시하면 `.github/workflows/deploy.yml`이 GitHub Pages로 배포합니다.
(저장소 Settings → Pages → Source: **GitHub Actions**)

## 데이터

데이터는 초대받은 방(`rooms/<방 ID>/<초대 키>`)에만 있고, 초대 없이는 어떤 방 데이터도 보이지 않습니다.
