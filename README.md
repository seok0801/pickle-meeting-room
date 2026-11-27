# 🥒 피클 합동 회의실 (Pickle Meeting Room)

귀여운 피클 캐릭터들이 함께 출근해 회의를 여는 합동 회의실 웹앱입니다.
빌드 도구 없이 `index.html` · `styles.css` · `app.js` 세 파일로 동작하는 정적 사이트입니다.

**사이트:** https://seok0801.github.io/pickle-meeting-room/

## 기능

- **피클 오피스 맵 (SVG)** — 회의실(원탁 테이블) · 작업실(책상·화이트보드) · 라운지(소파) 세 구역.
  둥근 노란 몸통과 파란 귀/테두리의 주봇을 포함한 피클 캐릭터들이 자리에서 움직이고, 짧은 말풍선으로 인사합니다.
  (말풍선을 누르면 인사를 건넵니다.)
- **출석 피클 보드** — 참석한 피클 목록, 각자의 상태(온라인 / 작업중 / 대기) 변경, 새 피클 출근.
- **회의 안건 & 공동 할 일** — 안건·할 일 추가, 완료 체크, 전체/안건/할 일/미완료 필터, 담당 지정.
- **회의 타임라인** — 피클들의 의견 교환과 직접 남긴 메모가 시간순으로 쌓입니다.
- **실시간 동기화(기본 켜짐)** — 무료 Firebase Realtime Database 주소가 앱에 미리 들어 있어, 주소를 넣지 않아도
  여러 기기·피클이 같은 회의실(`rooms/pickle-room`)을 실시간(SSE 스트림)으로 공유합니다. 스트림이 막히면 자동으로 폴링으로 전환합니다.
  상단 **실시간 동기화 설정**에서 다른 주소·회의실 ID로 바꿀 수 있고, **연결 해제**를 누르면 이 브라우저에만 저장됩니다.
- **회의실 링크(`?room=<방 ID>`)** — `?room=` 없이 열면 공용 데모 회의실(`pickle-room`)입니다.
  `https://seok0801.github.io/pickle-meeting-room/?room=<방 ID>` 처럼 방 ID를 붙여 열면 설정 창을 열지 않아도
  그 방(`rooms/<방 ID>`)에 바로 연결되고, 상단에 현재 회의실 이름과 **복사** 버튼이 나옵니다.
  방 ID는 링크를 아는 사람만 알 수 있으므로, 방 ID는 저장소에 적지 말고 링크로만 나눠 주세요.
  저장(localStorage)도 방마다 따로 쓰여 한 방의 내용이 다른 방으로 섞이지 않습니다.
- **반응형** — 375px 모바일 / 태블릿 / 데스크탑 레이아웃, 가로 넘침 없음. `prefers-reduced-motion` 존중.

## 실시간 동기화

기본값은 아래와 같고 `app.js`의 `DEFAULT_SYNC`에 있습니다.

```js
var DEFAULT_SYNC = {
  url: 'https://pickle-meeting-room-rtdb-default-rtdb.asia-southeast1.firebasedatabase.app',
  room: 'pickle-room'
};
```

- Firebase 프로젝트: `pickle-meeting-room` (요금제 **Spark / 무료 $0**, 카드 미연결)
- Realtime Database 리전: 싱가포르(asia-southeast1), 데이터 경로 `rooms/<회의실 ID>`
- 보안 규칙: `rooms` 아래만 읽기/쓰기를 열고, 회의실 키 형식과 필드 존재·길이를 검사합니다.

```json
{"rules":{"rooms":{"$room":{".read":true,".write":true,".validate":"$room.matches(/^[A-Za-z0-9가-힣_-]{1,40}$/)","version":{".validate":"newData.isNumber()"},"updatedAt":{".validate":"newData.isNumber()"},"pickles":{"$id":{".validate":"newData.hasChildren(['name']) && newData.child('name').val().length <= 24"}},"items":{"$id":{".validate":"newData.hasChildren(['title']) && newData.child('title').val().length <= 160"}},"timeline":{"$id":{".validate":"newData.hasChildren(['text']) && newData.child('text').val().length <= 400"}},"$other":{".validate":false}}}}}
```

> ⚠️ 규칙이 공개라 주소를 아는 사람은 누구나 이 회의실을 읽고 쓸 수 있습니다. 실제 개인정보·민감정보는 올리지 마세요.
> 비공개 회의실도 같은 규칙을 쓰므로, 방 ID(링크)를 아는 사람은 그 방을 읽고 쓸 수 있습니다. 링크는 필요한 사람에게만 보내세요.

## 배포

`main` 브랜치에 푸시하면 `.github/workflows/deploy.yml`이 GitHub Pages로 배포합니다.
(저장소 Settings → Pages → Source: **GitHub Actions**)

## 데이터

샘플 데이터는 모두 범용 예시입니다. 개인정보는 포함되어 있지 않습니다.
