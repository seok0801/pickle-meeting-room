/* 피클 합동 회의실 — app.js
   단일 페이지 앱: 출석 보드, 안건/할 일, 말풍선 채팅방(실시간).
   저장: localStorage → (선택) Firebase Realtime Database 실시간 동기화. */
(function () {
  'use strict';

  var KEY_HEAD = 'pickle-meeting-room/v2';
  var MAX_TL = 60;
  var MAX_CHAT_TEXT = 8000;        // 한 메시지 글자 수 상한 (RTDB 규칙과 같은 8000자)
  var MAX_IMAGE_CHARS = 400000;    // 말풍선 사진(data URL) 상한 — RTDB 규칙과 맞춤
  var MIN_KEY_LEN = 20;   // RTDB 규칙과 같은 초대 키 최소 길이

  // 무료 Firebase Realtime Database(Spark 플랜 · 싱가포르 리전) — 주소만 미리 넣어 둡니다.
  // 데이터는 rooms/<방 ID>/<초대 키> 경로에만 있고, 초대 키를 모르면 읽지도 쓰지도 못합니다.
  var RTDB_URL = 'https://pickle-meeting-room-rtdb-default-rtdb.asia-southeast1.firebasedatabase.app';

  // 초대 전용: 기본 주소로 들어오면 회의실 대신 잠금 화면을 띄우고,
  // ?room=<방 ID>&key=<초대 키> 초대 링크로만 입장합니다.
  function sanitizeRoom(v) {
    return String(v || '').replace(/[^\w\-가-힣]/g, '').slice(0, 40);
  }
  function sanitizeKey(v) {
    return String(v || '').replace(/[^\w\-]/g, '').slice(0, 64);
  }

  function readParam(name) {
    var m = new RegExp('[?&]' + name + '=([^&#]*)').exec(window.location.search);
    if (!m) return '';
    var raw = m[1].replace(/\+/g, ' ');
    try { raw = decodeURIComponent(raw); } catch (e) { /* 원문 그대로 사용 */ }
    return raw;
  }

  var INVITE = { room: sanitizeRoom(readParam('room')), key: sanitizeKey(readParam('key')) };

  function hasInvite() { return INVITE.room.length > 0 && INVITE.key.length >= MIN_KEY_LEN; }

  // 방(ID) + 초대 키마다 localStorage를 따로 써서, 방의 내용이 다른 방으로 새지 않게 합니다.
  function stateKey() { return KEY_HEAD + '/room/' + INVITE.room + '/' + INVITE.key; }

  /* ------------------------------ 모드: 가족 회의실 ↔ AI 사단 관제실 ------------------------------ */

  // 방 ID가 ai_로 시작하면 AI 사단 관제실 모드, 그 밖(rm_ 등)은 가족 회의실 모드입니다.
  function modeOfRoom(room) { return /^ai[_-]/i.test(String(room || '')) ? 'ai' : 'family'; }

  // 두 방의 접속 정보를 모드별로 따로 기억합니다(같은 기기·브라우저의 localStorage에만).
  var BOOKMARKS_KEY = 'pickle-meeting-room/rooms';
  var MODE_KEY = 'pickle-meeting-room/mode';

  function loadBookmarks() {
    var out = { family: null, ai: null };
    try {
      var parsed = JSON.parse(localStorage.getItem(BOOKMARKS_KEY) || 'null');
      ['family', 'ai'].forEach(function (m) {
        var v = parsed && parsed[m];
        if (!v) return;
        var room = sanitizeRoom(v.room);
        var key = sanitizeKey(v.key);
        if (room && key.length >= MIN_KEY_LEN) out[m] = { room: room, key: key };
      });
    } catch (e) { /* 손상된 값은 무시하고 새로 저장합니다 */ }
    return out;
  }

  function saveBookmark(mode, room, key) {
    BOOKMARKS[mode === 'ai' ? 'ai' : 'family'] = { room: room, key: key };
    try { localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(BOOKMARKS)); } catch (e) { /* 저장 실패 무시 */ }
  }

  var BOOKMARKS = loadBookmarks();
  var CURRENT_MODE = 'family';
  function isAi() { return CURRENT_MODE === 'ai'; }

  function inviteUrl(room, key) {
    return window.location.origin + window.location.pathname +
      '?room=' + encodeURIComponent(room) + '&key=' + encodeURIComponent(key);
  }

  /* ------------------------------ 팔레트 ------------------------------ */

  // 0번은 주봇 전용(노란 몸통 + 파란 귀/테두리)
  var PALETTE = [
    { body: '#FFD84D', ear: '#2F6BFF', ring: '#FFF0B8' },
    { body: '#7BE0C0', ear: '#1F8F68', ring: '#D2FBEE' },
    { body: '#FFB3C7', ear: '#C2416B', ring: '#FFE2EA' },
    { body: '#B39DFF', ear: '#5B45B8', ring: '#E9E2FF' },
    { body: '#FFC98A', ear: '#C4741F', ring: '#FFEDD6' },
    { body: '#8FD3FF', ear: '#2B6FA8', ring: '#DCF0FF' },
    { body: '#D6E96B', ear: '#7A8F1F', ring: '#F2F8CC' }
  ];

  // 상태 표시등 — 초록(접속) · 파랑(작업중) · 주황(한도 소진) · 빨강(접속 끊김)
  // RTDB 보안 규칙이 pickles[].status 문자열을 모두 허용하므로 DB 규칙은 그대로 둡니다.
  // 예전 데이터의 away(대기)는 offline(접속 끊김)으로 읽어 옵니다.
  var STATUS = {
    online:    { label: '접속',      color: '#16A34A', option: '접속(초록)' },
    working:   { label: '작업중',    color: '#2563EB', option: '작업중(파랑)' },
    exhausted: { label: '한도 소진', color: '#F97316', option: '한도 소진(주황)' },
    offline:   { label: '접속 끊김', color: '#DC2626', option: '접속 끊김(빨강)' }
  };
  var STATUS_ORDER = ['online', 'working', 'exhausted', 'offline'];
  var STATUS_ALIAS = { away: 'offline' };

  function normalizeStatus(v) {
    var s = STATUS_ALIAS[v] || v;
    return STATUS[s] ? s : 'online';
  }
  function statusLabel(s) { return (STATUS[s] || STATUS.online).label; }
  function statusColor(s) { return (STATUS[s] || STATUS.online).color; }

  /* ------------------------------ 상태 ------------------------------ */

  function uid(prefix) {
    return (prefix || 'id') + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
  }

  // 관제실 새 방이 비어 있을 때 앉혀 두는 사단 5개 에이전트 — 주봇(총괄) + PC1·PC2.
  var AI_SEED = [
    { id: 'p-jubot', name: '주봇', role: '총괄 지시자', color: 0, status: 'online' },
    { id: 'p-claude-pc1', name: '클로드PC1', role: 'PC1 홈피·DB', color: 3, status: 'online' },
    { id: 'p-codex-pc1', name: '코덱스PC1', role: 'PC1 크롤러·OCR', color: 4, status: 'online' },
    { id: 'p-claude-pc2', name: '클로드PC2', role: 'PC2 개발·시각화', color: 1, status: 'online' },
    { id: 'p-codex-pc2', name: '코덱스PC2', role: 'PC2 관제·자동화', color: 2, status: 'online' }
  ];

  // 초대받은 방의 초기 상태 — 데모 샘플 없이 주봇(가족) 또는 사단 5개 에이전트(관제실)만 앉혀 둡니다.
  function blankState() {
    var seed = modeOfRoom(INVITE.room) === 'ai' ? AI_SEED : [
      { id: 'p-jubot', name: '주봇', role: '회의 진행', color: 0, status: 'online' }
    ];
    return {
      version: 1,
      updatedAt: Date.now(),
      pickles: seed.map(function (p) {
        return { id: p.id, name: p.name, role: p.role, color: p.color, status: p.status };
      }),
      items: [],
      timeline: []
    };
  }

  var state = blankState();

  function loadState() {
    if (!INVITE.room || !INVITE.key) return blankState();
    try {
      var raw = localStorage.getItem(stateKey());
      if (!raw) return blankState();
      var s = JSON.parse(raw);
      return normalize(s) || blankState();
    } catch (e) {
      return blankState();
    }
  }

  // RTDB는 배열을 객체(키 "0"·"1"…)로 돌려주기도 하므로, 배열이든 객체든 같은 목록으로 읽습니다.
  function asList(v) {
    if (Array.isArray(v)) return v;
    if (!v || typeof v !== 'object') return [];
    return Object.keys(v).sort(function (a, b) {
      var na = /^\d+$/.test(a), nb = /^\d+$/.test(b);
      if (na && nb) return Number(a) - Number(b);
      if (na) return -1;
      if (nb) return 1;
      return a < b ? -1 : a > b ? 1 : 0;
    }).map(function (k) { return v[k]; });
  }

  // ts가 빠진 항목을 Date.now()로 채우면 정렬(a.ts - b.ts)에서 맨 아래로 튀어
  // 그 뒤에 온 정상 응답까지 가립니다(외부 봇이 ts 없이 쓴 메시지에서 실제 발생).
  // 그래서 배열 안 원래 위치를 지키는 시각을 채웁니다.
  //  · 유효한 ts(양수)는 그대로 둡니다.
  //  · 누락 항목은 앞 항목 ts+1, 배열 맨 앞이면 뒤의 첫 유효 ts-1(유효 ts가 하나도 없으면 0,1,2…).
  function fillMissingTs(list) {
    var out = [];
    var i, ts, last = null, next = null, any = false;
    for (i = 0; i < list.length; i++) {
      ts = Number(list[i] && list[i].ts);
      out[i] = ts > 0 ? ts : null;
      if (out[i] !== null) any = true;
    }
    if (!any) {
      for (i = 0; i < list.length; i++) out[i] = i;
      return out;
    }
    // 앞에서부터 — 앞 항목 ts+1 로 이어 붙입니다.
    for (i = 0; i < list.length; i++) {
      if (out[i] === null && last !== null) out[i] = last + 1;
      if (out[i] !== null) last = out[i];
    }
    // 맨 앞쪽에서 아직 빈 자리(앞에 유효 ts가 없던 자리)는 뒤 ts-1 로 채웁니다(1970년 표시 방지).
    for (i = list.length - 1; i >= 0; i--) {
      if (out[i] === null) out[i] = Math.max(1, next - 1);
      next = out[i];
    }
    return out;
  }

  function normalize(s) {
    if (!s || typeof s !== 'object') return null;
    var out = {
      version: 1,
      updatedAt: Number(s.updatedAt) || Date.now(),
      pickles: [],
      items: [],
      timeline: []
    };
    asList(s.pickles).forEach(function (p, i) {
      if (!p || typeof p.name !== 'string' || !p.name.trim()) return;
      out.pickles.push({
        id: String(p.id || uid('p')),
        name: String(p.name).slice(0, 24),
        role: typeof p.role === 'string' ? p.role.slice(0, 40) : '합류한 피클',
        color: Number.isFinite(p.color) ? ((Number(p.color) % PALETTE.length) + PALETTE.length) % PALETTE.length : i % PALETTE.length,
        status: normalizeStatus(p.status)
      });
    });
    var items = asList(s.items).filter(function (it) { return !!(it && typeof it.title === 'string' && it.title.trim()); });
    var itemTs = fillMissingTs(items);
    items.forEach(function (it, i) {
      out.items.push({
        id: String(it.id || uid('i')),
        title: String(it.title).slice(0, 160),
        type: it.type === 'todo' ? 'todo' : 'agenda',
        done: !!it.done,
        owner: typeof it.owner === 'string' ? it.owner.slice(0, 24) : '',
        ts: itemTs[i]
      });
    });
    var timeline = asList(s.timeline).filter(function (m) { return !!(m && typeof m.text === 'string' && m.text.trim()); });
    var timelineTs = fillMissingTs(timeline);
    timeline.forEach(function (m, i) {
      var msg = {
        id: String(m.id || uid('t')),
        who: String(m.who || '피클').slice(0, 24),
        text: String(m.text).slice(0, MAX_CHAT_TEXT),
        ts: timelineTs[i],
        kind: m.kind === 'note' ? 'note' : 'pickle'
      };
      var img = safeImage(m.image);
      if (img) msg.image = img;
      out.timeline.push(msg);
    });
    return out;
  }

  // 말풍선 사진은 data:image/... 만 허용합니다(다른 스킴·스크립트 주입 차단).
  function safeImage(v) {
    if (typeof v !== 'string') return '';
    if (v.slice(0, 11) !== 'data:image/') return '';
    if (!/^data:image\/(jpeg|jpg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(v)) return '';
    if (v.length > MAX_IMAGE_CHARS) return '';
    return v;
  }

  function save() {
    if (!INVITE.room || !INVITE.key) return;   // 초대 없이 열린 잠금 화면에서는 아무것도 저장하지 않는다
    state.updatedAt = Date.now();
    trimTimeline();
    saveLocal();
    Sync.push();
  }

  // 사진이 쌓이면 localStorage(약 5MB) 용량을 넘길 수 있습니다.
  // 넘칠 때만 오래된 사진부터 빼고 다시 저장해, 기록 자체가 날아가지 않게 합니다.
  function saveLocal() {
    try {
      localStorage.setItem(stateKey(), JSON.stringify(state));
      return;
    } catch (e) { /* 용량 초과 — 아래에서 사진만 빼고 재시도 */ }
    var slim = JSON.parse(JSON.stringify(state));
    slim.timeline.forEach(function (m) { delete m.image; });
    try { localStorage.setItem(stateKey(), JSON.stringify(slim)); } catch (e2) { /* 그래도 실패하면 포기 */ }
  }

  function trimTimeline() {
    if (state.timeline.length > MAX_TL) {
      state.timeline = state.timeline.slice(state.timeline.length - MAX_TL);
    }
  }

  /* ------------------------------ DOM 헬퍼 ------------------------------ */

  function $(sel, root) { return (root || document).querySelector(sel); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function fmtTime(ts) {
    var d = new Date(ts);
    var hh = String(d.getHours()).padStart(2, '0');
    var mm = String(d.getMinutes()).padStart(2, '0');
    return hh + ':' + mm;
  }
  function colorOf(p) {
    var c = PALETTE[(p.color || 0) % PALETTE.length];
    return c || PALETTE[0];
  }
  function pickleNameById(name) {
    for (var i = 0; i < state.pickles.length; i++) if (state.pickles[i].name === name) return state.pickles[i];
    return null;
  }

  function pickleSvg(color, withClass) {
    var c = color || PALETTE[0];
    return '' +
      '<svg class="' + (withClass ? 'char-svg' : 'pickle-svg') + '" viewBox="0 0 100 104" aria-hidden="true" focusable="false">' +
        '<ellipse cx="22" cy="27" rx="13" ry="13" fill="' + c.ear + '"/>' +
        '<ellipse cx="78" cy="27" rx="13" ry="13" fill="' + c.ear + '"/>' +
        '<ellipse cx="22" cy="27" rx="6" ry="6" fill="#FFFFFF" opacity=".45"/>' +
        '<ellipse cx="78" cy="27" rx="6" ry="6" fill="#FFFFFF" opacity=".45"/>' +
        '<ellipse cx="36" cy="94" rx="10" ry="5" fill="' + c.ear + '"/>' +
        '<ellipse cx="64" cy="94" rx="10" ry="5" fill="' + c.ear + '"/>' +
        '<rect x="14" y="28" width="72" height="66" rx="31" fill="' + c.body + '" stroke="' + c.ear + '" stroke-width="4.5"/>' +
        '<ellipse cx="34" cy="46" rx="11" ry="7" fill="#FFFFFF" opacity=".38"/>' +
        '<ellipse cx="38" cy="63" rx="5.5" ry="7" fill="#2A2418" class="eye"/>' +
        '<ellipse cx="62" cy="63" rx="5.5" ry="7" fill="#2A2418" class="eye"/>' +
        '<ellipse cx="30" cy="74" rx="6" ry="4" fill="#FF8FB1" opacity=".55"/>' +
        '<ellipse cx="70" cy="74" rx="6" ry="4" fill="#FF8FB1" opacity=".55"/>' +
        '<path d="M44 78 q6 6.5 12 0" stroke="#2A2418" stroke-width="3" fill="none" stroke-linecap="round"/>' +
      '</svg>';
  }

  /* ------------------------------ 출석 보드 ------------------------------ */

  var attendList = $('#attendList');
  var attendCount = $('#attendCount');

  /* ------------------------------ 부대장 승계 (관제실) ------------------------------ */

  // 주봇이 한도 소진(exhausted)·접속 끊김(offline)이면 코덱스PC2가 임시 대장을 맡습니다.
  // 부대장은 사단 내 오더 조율·마이너 재지시만 대행하고, 결제·개인정보·대외 발신·삭제·예약 변경은 대장님 승인을 받습니다.
  var DEPUTY = { lead: '주봇', leadId: 'p-jubot', deputy: '코덱스PC2' };
  var DEPUTY_REASON = { exhausted: '한도 소진', offline: '접속 끊김' };

  function leadPickle() {
    for (var i = 0; i < state.pickles.length; i++) {
      var p = state.pickles[i];
      if (p.id === DEPUTY.leadId || p.name === DEPUTY.lead) return p;
    }
    return null;
  }

  // 승계가 필요한 순간이면 { status, lead, reason } 을, 아니면 null 을 돌려줍니다.
  function deputyState() {
    if (!isAi()) return null;   // 부대장 승계는 관제실 모드 전용입니다
    var lead = leadPickle();
    if (!lead) return null;
    var s = normalizeStatus(lead.status);
    if (s !== 'exhausted' && s !== 'offline') return null;
    return { status: s, lead: lead.name, reason: DEPUTY_REASON[s] };
  }

  // 사단 현황 바의 대행 배너와 코덱스PC2 카드의 '임시 대장' 배지를 상태에 맞춰 켜고 끕니다.
  function renderDeputy() {
    var d = deputyState();
    var banner = $('#deputyBanner');
    if (banner) {
      banner.hidden = !d;
      if (d) banner.dataset.status = d.status;
      else banner.removeAttribute('data-status');
      var title = $('#deputyBannerTitle');
      if (title) {
        title.textContent = d
          ? '⚠️ ' + d.lead + ' ' + d.reason + ' — 부대장 승계 가동 중 (임시 대장: ' + DEPUTY.deputy + ')'
          : '';
      }
    }
    Array.prototype.forEach.call(attendList ? attendList.children : [], function (li) {
      if (li.dataset.name !== DEPUTY.deputy) return;
      li.classList.toggle('is-deputy', !!d);
      var row = li.querySelector('.attend-name-row');
      if (!row) return;
      var badge = row.querySelector('.deputy-badge');
      if (d && !badge) row.appendChild(el('span', 'deputy-badge', '임시 대장'));
      else if (!d && badge) badge.remove();
    });
  }

  function renderAttend() {
    attendList.textContent = '';
    state.pickles.forEach(function (p) {
      var li = el('li', 'attend-item');
      li.dataset.id = p.id;
      li.dataset.name = p.name;

      var face = el('span', 'attend-face');
      face.innerHTML = pickleSvg(colorOf(p), false);

      li.dataset.status = p.status;

      var meta = el('div', 'attend-meta');
      var nameRow = el('div', 'attend-name-row');
      var dot = el('span', 'status-dot');
      dot.dataset.status = p.status;
      dot.title = statusLabel(p.status);
      dot.setAttribute('aria-hidden', 'true');
      nameRow.appendChild(dot);
      nameRow.appendChild(el('span', 'attend-name', p.name));
      if (isAi()) {
        var grp = agentGroup(p);
        if (grp) nameRow.appendChild(el('span', 'agent-tag', grp));
      }
      var rl = el('div', 'attend-role', p.role || '합류한 피클');
      meta.appendChild(nameRow);
      meta.appendChild(rl);

      var right = el('div', 'attend-right');
      var sel = el('select', 'status-select');
      sel.setAttribute('aria-label', p.name + ' 상태');
      STATUS_ORDER.forEach(function (s) {
        // 관제실에서는 상태 이름이 짧은 대시보드 라벨(접속·작업중·한도 소진·중단)을 씁니다.
        var label = isAi()
          ? { online: '접속', working: '작업중', exhausted: '한도 소진', offline: '중단' }[s]
          : STATUS[s].option;
        var o = el('option', null, label);
        o.value = s;
        if (p.status === s) o.selected = true;
        sel.appendChild(o);
      });
      sel.dataset.status = p.status;
      sel.addEventListener('change', function () {
        p.status = sel.value;
        sel.dataset.status = p.status;
        li.dataset.status = p.status;
        dot.dataset.status = p.status;
        dot.title = statusLabel(p.status);
        react(p.name, statusLabel(p.status) + ' 상태로 바꿨어요');
        save();
        renderAttendSummary();
        renderTargets();   // 대상 칩 색·순서(접속·작업중 우선)도 다시 맞춥니다
      });

      var del = el('button', 'attend-del', '×');
      del.type = 'button';
      del.setAttribute('aria-label', p.name + ' 퇴근시키기');
      del.addEventListener('click', function () {
        state.pickles = state.pickles.filter(function (x) { return x.id !== p.id; });
        save();
        renderAll();
      });

      var wrap = el('div', 'attend-actions');
      wrap.appendChild(sel);
      wrap.appendChild(del);
      right.appendChild(wrap);

      // 카드(얼굴 + 이름)를 누르면 그 피클을 채팅 대상으로 지정하고 채팅 탭으로 넘어갑니다.
      // RTDB에는 새 필드를 만들지 않고, 전송할 때 text 맨 앞에 "@이름 "만 붙입니다.
      var pick = el('button', 'attend-pick');
      pick.type = 'button';
      pick.setAttribute('aria-label', p.name + '에게 지시하기');
      pick.title = p.name + '에게 지시 — 채팅 대상으로 지정';
      pick.appendChild(face);
      pick.appendChild(meta);
      pick.addEventListener('click', function () {
        setTarget(p.name);
        showTab('chat', true);
      });

      li.appendChild(pick);
      li.appendChild(right);
      attendList.appendChild(li);
    });
    renderAttendSummary();
    renderTargetState();
  }

  // 관제실 카드에 붙는 소속 태그 — 클로드PC1·코덱스PC1은 PC1, PC2는 PC2, 주봇은 총괄.
  function agentGroup(p) {
    if (/PC1/i.test(p.name)) return 'PC1';
    if (/PC2/i.test(p.name)) return 'PC2';
    if (p.name === '주봇') return '총괄';
    return '';
  }

  // 상단 요약 — "2마리 참석 · 접속 2" 처럼 상태별 인원을 표시합니다.
  function renderAttendSummary() {
    var n = state.pickles.length;
    attendCount.textContent = isAi() ? n + '개 에이전트' : n + '마리 참석';
    var box = $('#attendStatus');
    if (!box) return;
    box.textContent = '';
    var first = true;
    STATUS_ORDER.forEach(function (s) {
      var c = state.pickles.filter(function (p) { return p.status === s; }).length;
      if (!c) return;
      if (!first) box.appendChild(document.createTextNode(' · '));
      first = false;
      var seg = el('span', 'status-sum');
      seg.dataset.status = s;
      seg.appendChild(el('i', 'status-sum-dot'));
      seg.appendChild(document.createTextNode(statusLabel(s) + ' ' + c));
      seg.title = statusLabel(s) + ' ' + c + (isAi() ? '개' : '마리');
      box.appendChild(seg);
    });
    renderAiSummary();
    renderDeputy();
  }

  // 관제실 상단 요약 배지 — 접속 · 작업중 · 한도소진 · 중단(접속 끊김) · 미완료 일감.
  function renderAiSummary() {
    if (!isAi()) return;
    var counts = { online: 0, working: 0, exhausted: 0, offline: 0 };
    state.pickles.forEach(function (p) { counts[normalizeStatus(p.status)] += 1; });
    setText('#statOnline', counts.online);
    setText('#statWorking', counts.working);
    setText('#statExhausted', counts.exhausted);
    setText('#statOffline', counts.offline);
    setText('#statOpen', state.items.filter(function (it) { return !it.done; }).length);
  }

  function setText(sel, value) {
    var n = $(sel);
    if (n) n.textContent = String(value);
  }

  /* ------------------------------ 안건 / 할 일 ------------------------------ */

  var itemList = $('#itemList');
  var itemEmpty = $('#itemEmpty');
  var itemProgress = $('#itemProgress');
  var ownerSelect = $('#itemOwner');
  var filter = 'all';

  function renderOwnerSelect() {
    var current = ownerSelect.value;
    ownerSelect.textContent = '';
    var all = el('option', null, '담당 미정');
    all.value = '';
    ownerSelect.appendChild(all);
    state.pickles.forEach(function (p) {
      var o = el('option', null, p.name);
      o.value = p.name;
      ownerSelect.appendChild(o);
    });
    if (current && Array.from(ownerSelect.options).some(function (o) { return o.value === current; })) {
      ownerSelect.value = current;
    }
  }

  function visibleItems() {
    return state.items.filter(function (it) {
      if (filter === 'agenda' || filter === 'todo') return it.type === filter;
      if (filter === 'open') return !it.done;
      return true;
    });
  }

  function buildItemRow(it) {
    var li = el('li', 'item' + (it.done ? ' is-done' : ''));
    li.dataset.id = it.id;

    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'item-check';
    cb.checked = it.done;
    cb.setAttribute('aria-label', it.title + ' 완료');
    cb.addEventListener('change', function () {
      it.done = cb.checked;
      react(null, (cb.checked ? '완료! ' : '다시 진행할게요. ') + '“' + short(it.title) + '”');
      save();
      renderItems();
      renderChat();
    });

    var body = el('div', 'item-body');
    var title = el('div', 'item-title', it.title);
    var meta = el('div', 'item-meta');
    var tagText = it.type === 'todo' ? '할 일' : (isAi() ? '일감' : '안건');
    var tag = el('span', 'tag ' + (it.type === 'todo' ? 'tag-todo' : 'tag-agenda'), tagText);
    meta.appendChild(tag);

    var owner = it.owner && pickleNameById(it.owner) ? it.owner : (it.owner || '담당 미정');
    if (isAi() && it.owner) {
      // 담당자 배지 — 그 에이전트의 현재 상태 색 점을 함께 보여 줍니다.
      var ob = el('span', 'owner-badge');
      var op = pickleNameById(it.owner);
      if (op) {
        ob.dataset.status = op.status;
        ob.appendChild(el('i', 'owner-dot'));
        ob.appendChild(document.createTextNode(owner));
      } else {
        ob.textContent = owner;
      }
      meta.appendChild(ob);
    } else {
      meta.appendChild(el('span', null, owner));
    }
    meta.appendChild(el('span', null, fmtTime(it.ts)));
    body.appendChild(title);
    body.appendChild(meta);

    var del = el('button', 'item-del', '×');
    del.type = 'button';
    del.setAttribute('aria-label', it.title + ' 삭제');
    del.addEventListener('click', function () {
      state.items = state.items.filter(function (x) { return x.id !== it.id; });
      save();
      renderItems();
    });

    li.appendChild(cb);
    li.appendChild(body);
    li.appendChild(del);
    return li;
  }

  // 관제실 일감 큐의 구분 줄 — 미완료 일감 / 완료 일감.
  function queueHead(label, n, kind) {
    var li = el('li', 'queue-head');
    li.dataset.kind = kind;
    li.appendChild(el('span', 'queue-head-label', label));
    li.appendChild(el('span', 'queue-head-count', String(n)));
    return li;
  }

  function renderItems() {
    itemList.textContent = '';
    var list = visibleItems();

    if (isAi()) {
      // 일감 큐: 미완료를 먼저, 완료를 아래에 나눠서 보여 줍니다.
      var open = list.filter(function (it) { return !it.done; });
      var done = list.filter(function (it) { return it.done; });
      if (open.length) {
        itemList.appendChild(queueHead('미완료 일감', open.length, 'open'));
        open.forEach(function (it) { itemList.appendChild(buildItemRow(it)); });
      }
      if (done.length) {
        itemList.appendChild(queueHead('완료 일감', done.length, 'done'));
        done.forEach(function (it) { itemList.appendChild(buildItemRow(it)); });
      }
    } else {
      list.forEach(function (it) { itemList.appendChild(buildItemRow(it)); });
    }

    itemEmpty.hidden = list.length > 0;
    itemEmpty.textContent = isAi()
      ? '아직 등록된 일감이 없어요. 새 일감을 등록해 보세요.'
      : '아직 안건이 없어요. 첫 안건을 추가해 보세요.';

    var total = state.items.length;
    var doneCount = state.items.filter(function (it) { return it.done; }).length;
    itemProgress.textContent = isAi()
      ? '미완료 ' + (total - doneCount) + ' · 완료 ' + doneCount + ' / ' + total
      : doneCount + ' / ' + total + ' 완료';
    renderDockBadges();
    renderAiSummary();
  }

  function short(t) { return t.length > 22 ? t.slice(0, 22) + '…' : t; }

  document.querySelectorAll('.chip-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      filter = btn.dataset.filter;
      document.querySelectorAll('.chip-btn').forEach(function (b) {
        b.classList.toggle('is-active', b === btn);
      });
      renderItems();
    });
  });

  $('#formItem').addEventListener('submit', function (e) {
    e.preventDefault();
    var input = $('#itemTitle');
    var title = input.value.trim();
    if (!title) return;
    var item = {
      id: uid('i'),
      title: title.slice(0, 120),
      type: $('#itemType').value === 'todo' ? 'todo' : 'agenda',
      done: false,
      owner: ownerSelect.value || '',
      ts: Date.now()
    };
    state.items.push(item);
    input.value = '';
    save();
    if (filter === 'todo' && item.type === 'agenda') filter = 'all';
    if (filter === 'agenda' && item.type === 'todo') filter = 'all';
    document.querySelectorAll('.chip-btn').forEach(function (b) {
      b.classList.toggle('is-active', b.dataset.filter === filter);
    });
    react(null, '새 ' + (item.type === 'todo' ? '할 일' : '안건') + ' “' + short(item.title) + '” 추가했어요');
    renderItems();
    renderChat();
  });

  /* ------------------------------ 채팅방 (말풍선 대화) ------------------------------ */

  var chatFeed = $('#chatFeed');
  var chatEmpty = $('#chatEmpty');
  var chatCount = $('#chatCount');
  var lastChatId = null;

  /* ---------------------- 대상 지정 (@멘션) ---------------------- */

  // RTDB 보안 규칙이 timeline 항목에 { id, who, text, ts, kind }만 허용하므로
  // 대상 지정은 새 필드를 만들지 않고 text 맨 앞의 "@이름 " 말머리로만 저장합니다.
  // (그 말머리를 말풍선에서 컬러 배지로 그려 누구에게 보낸 지시인지 보이게 합니다.)
  var targetName = '';   // '' = 전체

  var pickTargetChips = $('#targetChips');

  // 접속 → 작업중 → 한도 소진 → 접속 끊김 순으로 정렬해 지금 일하는 피클을 앞에 둡니다.
  function orderedPickles() {
    return state.pickles.slice().sort(function (a, b) {
      return STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status);
    });
  }

  function renderTargets() {
    var wrap = pickTargetChips;
    if (!wrap) return;
    if (targetName && !pickleNameById(targetName)) targetName = '';   // 퇴근한 피클이면 전체로
    wrap.textContent = '';

    var all = el('button', 'target-chip' + (targetName ? '' : ' is-active'), '전체');
    all.type = 'button';
    all.dataset.target = '';
    all.title = '전체 피클에게 보내기';
    all.setAttribute('aria-pressed', targetName ? 'false' : 'true');
    wrap.appendChild(all);

    orderedPickles().forEach(function (p) {
      var on = targetName === p.name;
      var chip = el('button', 'target-chip' + (on ? ' is-active' : ''));
      chip.type = 'button';
      chip.dataset.target = p.name;
      chip.setAttribute('aria-pressed', on ? 'true' : 'false');
      // 점 색은 피클 고유색이 아니라 현재 상태 색(초록/파랑/주황/빨강) — 지금 누가 들어와 있는지 한눈에.
      // 피클 고유색은 점 둘레의 얇은 링으로 남겨 두어 누구인지도 함께 읽힙니다.
      var c = colorOf(p);
      var dot = el('span', 'target-dot');
      dot.dataset.status = p.status;
      dot.style.background = statusColor(p.status);
      dot.style.boxShadow = '0 0 0 1.5px ' + c.ear;
      chip.appendChild(dot);
      chip.appendChild(document.createTextNode(p.name));
      chip.title = p.name + '에게 지시 · ' + statusLabel(p.status);
      if (p.status !== 'online') {
        var st = el('span', 'target-state', statusLabel(p.status));
        st.dataset.status = p.status;
        chip.appendChild(st);
      }
      wrap.appendChild(chip);
    });

    // 선택된 칩이 스크롤 밖에 있으면 보이게 맞춥니다.
    var active = wrap.querySelector('.target-chip.is-active');
    if (active && wrap.scrollWidth > wrap.clientWidth) {
      var left = active.offsetLeft - wrap.offsetLeft;
      if (left < wrap.scrollLeft || left + active.offsetWidth > wrap.scrollLeft + wrap.clientWidth) {
        wrap.scrollLeft = Math.max(0, left - 10);
      }
    }
    renderTargetState();
  }

  // 입력창 안내문과 접속자 카드 강조를 현재 대상에 맞춥니다.
  function renderTargetState() {
    var input = $('#chatText');
    var form = $('#formChat');
    if (form) form.classList.toggle('is-targeted', !!targetName);
    if (input) {
      input.placeholder = targetName
        ? targetName + (isAi() ? '에게 보낼 오더 입력...' : '에게 보낼 메시지 입력...')
        : (isAi() ? '오더·보고를 입력하고 Enter' : '메시지를 입력하고 Enter');
    }
    var items = document.querySelectorAll('.attend-item');
    for (var i = 0; i < items.length; i++) {
      var on = !!targetName && items[i].dataset.name === targetName;
      items[i].classList.toggle('is-target', on);
      var btn = items[i].querySelector('.attend-pick');
      if (btn) btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  function setTarget(name) {
    targetName = name && pickleNameById(name) ? name : '';
    renderTargets();
  }

  if (pickTargetChips) {
    pickTargetChips.addEventListener('click', function (e) {
      var n = e.target;
      while (n && n !== pickTargetChips && !(n.classList && n.classList.contains('target-chip'))) n = n.parentNode;
      if (!n || n === pickTargetChips) return;
      setTarget(n.dataset.target || '');
      var input = $('#chatText');
      if (input) input.focus();
    });
  }

  // "@이름 …"으로 시작하면 @이름을 컬러 배지로 분리해 그립니다.
  function fillBubble(bubble, text) {
    var m = /^@([^\s@]{1,24})(?:\s+|$)/.exec(text);
    if (!m) { bubble.textContent = text; return; }
    var name = m[1];
    var p = pickleNameById(name);
    var badge = el('span', 'mention-badge', '@' + name);
    if (p) {
      var c = colorOf(p);
      badge.style.background = c.ring;
      badge.style.borderColor = c.ear;
    }
    bubble.appendChild(badge);
    var rest = text.slice(m[0].length);
    if (rest) bubble.appendChild(document.createTextNode(rest));
  }

  // 대상이 정해져 있으면 이미 @이름을 직접 쓴 경우를 빼고 말머리를 붙입니다.
  function withTarget(text) {
    if (!targetName) return text;
    var at = '@' + targetName;
    if (text.slice(0, at.length) === at) {
      var next = text.charAt(at.length);
      if (!next || /\s/.test(next)) return text;
    }
    return at + ' ' + text;
  }

  function addLine(who, text, kind, image) {
    var line = {
      id: uid('t'),
      who: who,
      text: String(text).slice(0, MAX_CHAT_TEXT),
      ts: Date.now(),
      kind: kind === 'note' ? 'note' : 'pickle'
    };
    var img = safeImage(image);
    if (img) line.image = img;
    state.timeline.push(line);
    if (state.timeline.length > MAX_TL) state.timeline = state.timeline.slice(-MAX_TL);
  }

  // 이벤트에 대한 피클의 짧은 반응 (채팅 + 말풍선)
  var REACTIONS = [
    '좋아요, 바로 반영할게요.', '확인했습니다!', '기록해 뒀어요.', '이건 제가 챙길게요.',
    '다음 안건도 볼까요?', '회의실에 공유했습니다.', '좋은 흐름이에요!'
  ];
  function react(preferredWho, context) {
    var p = preferredWho ? pickleNameById(preferredWho) : null;
    if (!p && state.pickles.length) {
      p = state.pickles[Math.floor(Math.random() * state.pickles.length)];
    }
    var who = p ? p.name : '피클';
    var tail = REACTIONS[Math.floor(Math.random() * REACTIONS.length)];
    addLine(who, (context ? context + ' — ' : '') + tail, 'pickle');
    renderChat();
  }

  function fmtDate(ts) {
    var d = new Date(ts);
    return d.getFullYear() + '.' + String(d.getMonth() + 1).padStart(2, '0') + '.' + String(d.getDate()).padStart(2, '0');
  }

  // 이름에 맞는 피클 얼굴 — 출석한 피클이면 자기 색, 아니면 기본 피클
  function chatAvatar(who) {
    if (who === '주봇') return pickleSvg(PALETTE[0], false);
    var p = pickleNameById(who);
    if (p) return pickleSvg(colorOf(p), false);
    return '<svg viewBox="0 0 100 104" aria-hidden="true" focusable="false">' +
      '<ellipse cx="22" cy="27" rx="13" ry="13" fill="#7BE0C0"/>' +
      '<ellipse cx="78" cy="27" rx="13" ry="13" fill="#7BE0C0"/>' +
      '<rect x="14" y="28" width="72" height="66" rx="31" fill="#D9FBEF" stroke="#1F8F68" stroke-width="4.5"/>' +
      '<ellipse cx="38" cy="63" rx="5.5" ry="7" fill="#2A2418"/>' +
      '<ellipse cx="62" cy="63" rx="5.5" ry="7" fill="#2A2418"/>' +
      '<path d="M44 78 q6 6.5 12 0" stroke="#2A2418" stroke-width="3" fill="none" stroke-linecap="round"/>' +
      '</svg>';
  }

  // timeline 데이터(who · text · ts · kind)를 피클 앱/카톡 스타일 말풍선으로 그립니다.
  // 우리 측(나 · 주봇)은 오른쪽, 외부 피클(모모 등)은 왼쪽으로 좌우를 교차시킵니다.
  // 오른쪽에서도 나(노란 말풍선·'나' 배지)와 주봇(파란 말풍선·이름 배지)은 색과 배지로 구분됩니다.
  function renderChat() {
    var items = state.timeline.slice().sort(function (a, b) { return a.ts - b.ts; });
    var wasHidden = chatFeed.hidden;
    var nearBottom = chatFeed.scrollHeight - chatFeed.scrollTop - chatFeed.clientHeight < 80;
    chatFeed.textContent = '';

    var lastDay = '';
    items.forEach(function (m) {
      var day = fmtDate(m.ts);
      if (day !== lastDay) {
        chatFeed.appendChild(el('div', 'chat-day', day));
        lastDay = day;
      }

      var isMe = m.who === '나';
      var mine = isMe || m.who === '주봇';   // 우리 측
      var row = el('div', 'msg' + (mine ? ' is-me' : '') + (isMe ? ' is-self' : '') + (m.who === '주봇' ? ' is-jubot' : ''));
      row.dataset.id = m.id;

      var body = el('div', 'msg-body');
      if (!isMe) body.appendChild(el('span', 'msg-name', m.who));

      var line = el('div', 'msg-line');
      var bubble = el('div', 'msg-bubble');
      fillBubble(bubble, m.text);
      // 사진은 글보다 위에 — fillBubble이 글자를 새로 그린 다음에 끼워 넣습니다.
      var img = safeImage(m.image);
      if (img) {
        bubble.classList.add('has-photo');
        var shot = el('button', 'msg-photo');
        shot.type = 'button';
        shot.setAttribute('aria-label', (m.who || '피클') + '가 보낸 사진 크게 보기');
        var im = document.createElement('img');
        im.src = img;
        im.alt = '첨부 사진';
        im.loading = 'lazy';
        im.decoding = 'async';
        shot.appendChild(im);
        if (bubble.firstChild) bubble.insertBefore(shot, bubble.firstChild);
        else bubble.appendChild(shot);
      }
      bubble.title = day + ' ' + fmtTime(m.ts);
      var time = el('span', 'msg-time', fmtTime(m.ts));
      if (mine) {
        line.appendChild(time);
        line.appendChild(bubble);
      } else {
        line.appendChild(bubble);
        line.appendChild(time);
      }
      body.appendChild(line);

      var av = el('span', 'msg-av' + (isMe ? ' msg-av-me' : ''));
      if (isMe) av.textContent = '나';
      else av.innerHTML = chatAvatar(m.who);
      av.setAttribute('aria-hidden', 'true');

      row.appendChild(av);
      row.appendChild(body);
      chatFeed.appendChild(row);
    });

    var last = items.length ? items[items.length - 1].id : null;

    // 진행 중(작업중) 피클이 있으면 입력창 위에 움직이는 ••• 타이핑 말풍선을 띄웁니다.
    // 상태가 접속 등 다른 상태로 돌아오면 다음 렌더에서 바로 사라집니다.
    var working = state.pickles.filter(function (p) { return p.status === 'working'; });
    working.forEach(function (p) {
      var row = el('div', 'msg msg-typing');
      row.setAttribute('aria-label', p.name + ' 작업 중');

      var body = el('div', 'msg-body');
      body.appendChild(el('span', 'msg-name', p.name));

      var line = el('div', 'msg-line');
      var bubble = el('div', 'msg-bubble typing-bubble');
      var dots = el('span', 'typing-dots');
      dots.setAttribute('aria-hidden', 'true');
      dots.appendChild(el('i'));
      dots.appendChild(el('i'));
      dots.appendChild(el('i'));
      bubble.appendChild(dots);
      bubble.appendChild(el('span', 'typing-text',
        p.name + (p.role ? ' · ' + p.role : '이(가)') + ' 처리 중…'));
      line.appendChild(bubble);
      body.appendChild(line);

      var av = el('span', 'msg-av');
      av.innerHTML = chatAvatar(p.name);
      av.setAttribute('aria-hidden', 'true');

      row.appendChild(av);
      row.appendChild(body);
      chatFeed.appendChild(row);
    });
    var hasAny = items.length > 0 || working.length > 0;
    chatEmpty.hidden = hasAny;
    chatFeed.hidden = !hasAny;
    chatCount.textContent = items.length;

    if (chatFeed.hidden) { lastChatId = last; return; }
    // 새 메시지가 붙었거나, 처음 화면에 나타났거나, 보고 있던 위치가 맨 아래 근처면 맨 아래로
    if (wasHidden || last !== lastChatId || nearBottom) chatFeed.scrollTop = chatFeed.scrollHeight;
    lastChatId = last;
  }

  /* ------------------------------ 채팅 입력창 (여러 줄) ------------------------------ */

  // 한 줄 높이에서 시작해 입력한 줄 수만큼 늘어나고(최대 5줄 · 약 120px), 그보다 길면 입력창 안에서 스크롤됩니다.
  var CHAT_MAX_H = 120;
  function autoResize() {
    var input = $('#chatText');
    if (!input || input.tagName !== 'TEXTAREA') return;
    input.style.height = 'auto';
    // 테두리 두께는 scrollHeight에 들어 있지 않아 따로 더해 줍니다(border-box).
    var border = Math.max(0, input.offsetHeight - input.clientHeight);
    var h = input.scrollHeight + border;
    // 화면이 숨겨져 있으면 높이를 재지 못합니다 — 그때는 CSS 기본(한 줄) 높이로 둡니다.
    if (input.scrollHeight <= 0) { input.style.height = ''; input.style.overflowY = 'hidden'; return; }
    input.style.height = Math.min(h, CHAT_MAX_H) + 'px';
    input.style.overflowY = h > CHAT_MAX_H + 1 ? 'auto' : 'hidden';
  }

  // 전송 후에는 다시 한 줄 높이로 되돌립니다.
  function resetComposerHeight() {
    var input = $('#chatText');
    if (!input || input.tagName !== 'TEXTAREA') return;
    input.style.height = 'auto';
    input.style.overflowY = 'hidden';
    autoResize();
  }

  /* ------------------------------ 사진 첨부 (선택 · 붙여넣기) ------------------------------ */

  // 브라우저 Canvas로 최대 폭 960px JPEG(품질 0.72)로 줄입니다 — 휴대폰 원본 그대로보다 가볍게.
  var PHOTO_MAX_W = 960;
  var PHOTO_QUALITY = 0.72;
  var PHOTO_HARD_MAX = 360000;   // data URL 길이 상한(규칙 400,000자보다 약간 안쪽)

  function canvasToJpeg(src, maxW, quality) {
    return new Promise(function (resolve, reject) {
      var im = new Image();
      im.onload = function () {
        try {
          var w = im.naturalWidth || im.width;
          var h = im.naturalHeight || im.height;
          if (!w || !h) { reject(new Error('empty image')); return; }
          var scale = Math.min(1, maxW / w);
          var cw = Math.max(1, Math.round(w * scale));
          var ch = Math.max(1, Math.round(h * scale));
          var cv = document.createElement('canvas');
          cv.width = cw;
          cv.height = ch;
          var ctx = cv.getContext('2d');
          // 투명 PNG를 JPEG로 바꿀 때 검게 변하지 않도록 흰 바탕을 먼저 깝니다.
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, cw, ch);
          ctx.drawImage(im, 0, 0, cw, ch);
          resolve(cv.toDataURL('image/jpeg', quality));
        } catch (e) { reject(e); }
      };
      im.onerror = function () { reject(new Error('decode failed')); };
      im.src = src;
    });
  }

  // 품질·폭을 순차로 줄여 가며 규칙 상한 안으로 넣습니다.
  async function compressPhoto(file) {
    var src = await new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result || '')); };
      reader.onerror = function () { reject(new Error('read failed')); };
      reader.readAsDataURL(file);
    });
    var out = await canvasToJpeg(src, PHOTO_MAX_W, PHOTO_QUALITY);
    if (out.length <= PHOTO_HARD_MAX) return out;
    out = await canvasToJpeg(src, 720, 0.6);
    if (out.length <= PHOTO_HARD_MAX) return out;
    return canvasToJpeg(src, 560, 0.5);
  }

  var pendingImage = '';
  var pendingImageName = '';

  function setPendingImage(dataUrl, label) {
    pendingImage = safeImage(dataUrl) || '';
    pendingImageName = pendingImage ? String(label || '사진') : '';
    var chip = $('#photoChip');
    var img = $('#photoChipImg');
    var txt = $('#photoChipText');
    if (img) { if (pendingImage) img.src = pendingImage; else img.removeAttribute('src'); }
    if (txt) txt.textContent = pendingImage ? (pendingImageName || '사진') + ' 첨부됨' : '';
    if (chip) chip.hidden = !pendingImage;
  }

  function attachPhoto(file) {
    if (!file) return;
    if (file.type && file.type.indexOf('image/') !== 0) return;
    compressPhoto(file).then(function (dataUrl) {
      setPendingImage(dataUrl, file.name || '사진');
      var input = $('#chatText');
      if (input) input.focus();
    }).catch(function () { /* 읽지 못한 파일은 조용히 무시 */ });
  }

  var composerWired = false;
  function wireComposer() {
    var input = $('#chatText');
    if (!input || composerWired) return;
    composerWired = true;
    var composing = false;
    var composedAt = 0;
    input.addEventListener('input', autoResize);
    input.addEventListener('compositionstart', function () { composing = true; });
    input.addEventListener('compositionend', function () { composing = false; composedAt = Date.now(); });
    // Enter는 전송, Shift+Enter는 줄바꿈.
    // 한글 입력기(IME)가 조합을 마무리하는 Enter(조합 중 · keyCode 229)로는 절대 전송하지 않습니다.
    input.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' || e.shiftKey) return;
      if (e.isComposing || e.keyCode === 229 || composing || Date.now() - composedAt < 40) return;
      // 글자 수 상한을 넘은 채로 Enter를 치면 잘리지 않게 먼저 막고 알려 줍니다.
      if (input.value.length > MAX_CHAT_TEXT) return;
      e.preventDefault();
      if (!input.value.trim() && !pendingImage) return;
      var form = $('#formChat');
      if (!form) return;
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    });

    // 클립보드에 이미지가 있으면 가로채 첨부합니다(스크린샷 복사 → 붙여넣기).
    input.addEventListener('paste', function (e) {
      var cd = e.clipboardData;
      if (!cd || !cd.items) return;
      for (var i = 0; i < cd.items.length; i++) {
        var it = cd.items[i];
        if (it && it.kind === 'file' && it.type && it.type.indexOf('image/') === 0) {
          e.preventDefault();
          attachPhoto(it.getAsFile());
          return;
        }
      }
    });
    autoResize();
  }
  wireComposer();

  (function wirePhoto() {
    var btn = $('#btnPhoto');
    var picker = $('#chatPhotoInput');
    var remove = $('#photoChipRemove');
    if (btn && picker) {
      btn.addEventListener('click', function () { picker.click(); });
      picker.addEventListener('change', function () {
        var f = picker.files && picker.files[0];
        if (f) attachPhoto(f);
        try { picker.value = ''; } catch (e) {}
      });
    }
    if (remove) {
      remove.addEventListener('click', function () {
        setPendingImage('', '');
        var input = $('#chatText');
        if (input) input.focus();
      });
    }
  })();

  $('#formChat').addEventListener('submit', function (e) {
    e.preventDefault();
    var input = $('#chatText');
    var text = input.value.trim();
    var image = pendingImage;
    if (!text && !image) { input.focus(); return; }
    if (text.length > MAX_CHAT_TEXT) text = text.slice(0, MAX_CHAT_TEXT);
    // 사진만 보낼 때도 RTDB 규칙(text 필수)을 통과하도록 안내 문구를 넣습니다.
    addLine('나', withTarget(text || '📷 사진'), 'note', image);
    input.value = '';
    setPendingImage('', '');
    resetComposerHeight();
    save();
    renderChat();
    if (chatFeed) chatFeed.scrollTop = chatFeed.scrollHeight;
    input.focus();
  });

  /* ------------------------------ 사진 확대 보기 ------------------------------ */

  (function wireImgModal() {
    var modal = $('#imgModal');
    var big = $('#imgModalImg');
    if (!modal || !big) return;
    function openBig(src) {
      big.src = src;
      modal.hidden = false;
    }
    function closeBig() {
      modal.hidden = true;
      big.removeAttribute('src');
    }
    // 말풍선 사진을 누르면 크게 봅니다(이벤트 위임 — 다시 그려도 그대로 동작).
    if (chatFeed) {
      chatFeed.addEventListener('click', function (e) {
        var n = e.target;
        while (n && n !== chatFeed && !(n.classList && n.classList.contains('msg-photo'))) n = n.parentNode;
        if (!n || n === chatFeed) return;
        var img = n.querySelector('img');
        if (img && img.src) openBig(img.src);
      });
    }
    modal.addEventListener('click', function (e) {
      if (e.target === modal || (e.target && e.target.id === 'imgModalClose')) closeBig();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !modal.hidden) closeBig();
    });
  })();

  /* ------------------------------ 하단 독 3탭 ------------------------------ */

  var PANEL_TABS = ['chat', 'agenda', 'attend', 'settings'];
  var currentTab = 'chat';
  var dockButtons = Array.prototype.slice.call(document.querySelectorAll('.dock-btn'));

  function panelOf(tab) {
    return document.querySelector('.view > .panel[data-panel="' + tab + '"]');
  }

  // 채팅 → 안건 → 참가자 화면을 한 번에 하나씩 보여 줍니다. 기본 첫 화면은 채팅입니다.
  function showTab(tab, focusInput) {
    if (PANEL_TABS.indexOf(tab) < 0) tab = 'chat';
    currentTab = tab;
    var view = $('#view');
    if (view) view.classList.toggle('is-attend-tab', tab === 'attend');
    PANEL_TABS.forEach(function (t) {
      var p = panelOf(t);
      if (!p) return;
      var on = t === tab;
      p.classList.toggle('is-active', on);
      p.setAttribute('aria-hidden', on ? 'false' : 'true');
    });
    dockButtons.forEach(function (b) {
      var on = b.dataset.tab === tab;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    if (tab === 'chat') {
      renderChat();
      autoResize();
      requestAnimationFrame(function () { chatFeed.scrollTop = chatFeed.scrollHeight; });
      if (focusInput) {
        var box = $('#chatText');
        if (box) box.focus();
      }
    }
    updateSummaryVisibility();
  }

  // 사단 현황 바 — 관제실 모드의 '사단' 탭에서만 자리를 차지합니다.
  // (오더·일감·설정 탭에서는 display:none 상태로 완전히 숨겨 채팅 면을 가리지 않습니다.)
  function updateSummaryVisibility() {
    var s = $('#aiSummary');
    if (!s) return;
    var tab = typeof currentTab === 'string' ? currentTab : 'chat';
    s.hidden = !(isAi() && tab === 'attend');
  }

  dockButtons.forEach(function (b) {
    b.addEventListener('click', function () { showTab(b.dataset.tab); });
  });

  // 관제실 요약 카드 — 누르면 해당 탭으로 바로 이동합니다.
  // 상태 카드(접속·작업중·한도소진·중단)는 사단 상태판, 미완료 일감 카드는 일감 큐로 갑니다.
  Array.prototype.forEach.call(document.querySelectorAll('.ai-stat[data-go]'), function (b) {
    b.addEventListener('click', function () {
      var tab = b.dataset.go === 'agenda' ? 'agenda' : 'attend';
      showTab(tab);
      var node = (tab === 'agenda' ? $('#itemList') : $('#attendList')) || panelOf(tab);
      if (!node || !node.scrollIntoView) return;
      try { node.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
      catch (e) { node.scrollIntoView(); }
    });
  });

  /* ------------------------------ 새로고침 (당겨서 · ↻ 버튼) ------------------------------ */

  // 스크롤이 맨 위일 때 아래로 당기면 "당겨서 새로고침" → "놓으면 새로고침" → 최신 데이터 다시 읽기.
  // 일반 스크롤·입력창 터치는 건드리지 않습니다(스크롤이 내려가 있거나 가로로 움직이면 그냥 통과).
  var ptrEl = $('#ptrIndicator');
  var ptrText = $('#ptrText');
  var PTR_TRIGGER = 62;   // 이만큼 당기면 손을 뗄 때 새로고침
  var PTR_MAX = 104;
  var lastRefreshAt = 0;
  var ptrState = { armed: false, locked: false, startY: 0, startX: 0, pull: 0, scroller: null, busy: false };
  var refreshHideTimer = null;

  function activePanel() {
    return document.querySelector('.view > .panel.is-active');
  }

  // 터치한 곳에서 가장 가까운 '지금 스크롤되는' 영역 — 없으면 지금 탭 패널.
  function scrollableAncestor(node) {
    while (node && node !== document.body && node !== document.documentElement) {
      if (node.nodeType === 1) {
        var oy = window.getComputedStyle(node).overflowY;
        if ((oy === 'auto' || oy === 'scroll') && node.scrollHeight > node.clientHeight + 2) return node;
      }
      node = node.parentNode;
    }
    return null;
  }

  function mayPullFrom(target) {
    if (!target || !target.nodeType) return false;
    var tag = (target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'option') return false;
    if (target.isContentEditable) return false;
    if (document.querySelector('dialog[open]')) return false;
    return true;
  }

  function ptrPaint(px, dragging) {
    if (!ptrEl) return;
    ptrEl.classList.toggle('is-dragging', !!dragging);
    ptrEl.style.transform = 'translateY(calc(-100% + ' + Math.round(px) + 'px))';
    ptrEl.style.opacity = px > 2 ? '1' : '0';
  }

  function ptrLabel(state, text) {
    if (ptrEl) ptrEl.dataset.state = state;
    if (ptrText) ptrText.textContent = text;
  }

  // 짧은 안내 문구(가져오기 결과 등)도 같은 말포 풍선을 빌려 씁니다.
  function setSyncStatus(text, kind) {
    if (!ptrEl) return;
    if (refreshHideTimer) { clearTimeout(refreshHideTimer); refreshHideTimer = null; }
    ptrLabel(kind === 'error' ? 'error' : 'done', text || '');
    ptrPaint(64, false);
    refreshHideTimer = setTimeout(function () { ptrPaint(0, false); ptrLabel('idle', '당겨서 새로고침'); }, 1800);
  }

  // 실제 새로고침 — 대기 중인 저장을 먼저 보낸 뒤 RTDB에서 최신 상태를 다시 읽습니다.
  function refreshNow() {
    if (ptrState.busy) return Promise.resolve(false);
    ptrState.busy = true;
    var btn = $('#btnRefresh');
    if (btn) btn.classList.add('is-spinning');
    if (refreshHideTimer) { clearTimeout(refreshHideTimer); refreshHideTimer = null; }
    ptrLabel('loading', '새로고침 중…');
    ptrPaint(64, false);
    var started = Date.now();

    function finish(ok) {
      var wait = Math.max(0, 380 - (Date.now() - started));
      setTimeout(function () {
        ptrState.busy = false;
        if (btn) btn.classList.remove('is-spinning');
        if (ok) lastRefreshAt = Date.now();
        ptrLabel(ok ? 'done' : 'error', ok ? '새로고침 완료' : '새로고침 실패 · 화면만 갱신');
        ptrPaint(64, false);
        refreshHideTimer = setTimeout(function () {
          ptrPaint(0, false);
          ptrLabel('idle', '당겨서 새로고침');
        }, 950);
      }, wait);
      return ok;
    }

    return Sync.pull().then(function (ok) {
      renderAll();
      return finish(!!ok);
    }).catch(function () {
      renderAll();
      return finish(false);
    });
  }

  function onPtrStart(e) {
    if (e.touches.length !== 1) return;
    var t = e.touches[0];
    ptrBegin(t.clientY, t.clientX, e.target);
  }

  function onPtrMove(e) {
    if (e.touches.length !== 1) return;
    var t = e.touches[0];
    ptrMove(t.clientY, t.clientX, e);
  }

  function onPtrEnd() {
    ptrFinish();
  }

  // 터치·마우스 공통 상태기계 — 시작 지점과 당긴 높이만 받아 움직입니다.
  function ptrBegin(y, x, target) {
    if (!ENTERED || ptrState.busy) return;
    ptrState.armed = false;
    ptrState.locked = false;
    ptrState.pull = 0;
    if (!mayPullFrom(target)) return;
    var sc = scrollableAncestor(target);
    if (!sc) {
      var panel = activePanel();
      if (panel && panel.scrollHeight > panel.clientHeight + 2) sc = panel;
    }
    if (sc && sc.scrollTop > 0) { ptrState.scroller = null; return; }
    ptrState.scroller = sc;
    ptrState.startY = y;
    ptrState.startX = x;
    ptrState.armed = true;
  }

  function ptrMove(y, x, ev) {
    if (!ptrState.armed || ptrState.busy) return;
    var dy = y - ptrState.startY;
    var dx = x - ptrState.startX;
    if (!ptrState.locked) {
      if (dy <= 0) { if (dy < -4) ptrState.armed = false; return; }
      if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 10) { ptrState.armed = false; return; }
      if (ptrState.scroller && ptrState.scroller.scrollTop > 0) { ptrState.armed = false; return; }
      if (dy < 8) return;
      ptrState.locked = true;
      document.body.classList.add('is-pulling');
    }
    var pull = Math.min(PTR_MAX, dy * 0.52);
    ptrState.pull = pull;
    if (ev && ev.cancelable) ev.preventDefault();
    ptrLabel(pull >= PTR_TRIGGER ? 'ready' : 'pull', pull >= PTR_TRIGGER ? '놓으면 새로고침' : '당겨서 새로고침');
    ptrPaint(pull, true);
  }

  function ptrFinish() {
    if (!ptrState.armed) return;
    var pull = ptrState.pull;
    var fired = ptrState.locked && pull >= PTR_TRIGGER;
    ptrState.armed = false;
    ptrState.locked = false;
    ptrState.pull = 0;
    document.body.classList.remove('is-pulling');
    if (fired) {
      refreshNow();
    } else if (ptrEl) {
      ptrLabel('idle', '당겨서 새로고침');
      ptrPaint(0, false);
    }
  }

  document.addEventListener('touchstart', onPtrStart, { passive: true });
  document.addEventListener('touchmove', onPtrMove, { passive: false });
  document.addEventListener('touchend', onPtrEnd, { passive: true });
  document.addEventListener('touchcancel', onPtrEnd, { passive: true });

  // 데스크탑에서는 마우스로도 같은 동작(아래로 끌어 당기기)을 쓸 수 있게 합니다.
  document.addEventListener('pointerdown', function (e) {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    ptrBegin(e.clientY, e.clientX, e.target);
  });
  document.addEventListener('pointermove', function (e) {
    if (e.pointerType !== 'mouse') return;
    ptrMove(e.clientY, e.clientX, e);
  });
  document.addEventListener('pointerup', function (e) {
    if (e.pointerType !== 'mouse') return;
    ptrFinish();
  });
  document.addEventListener('pointercancel', function (e) {
    if (e.pointerType !== 'mouse') return;
    ptrFinish();
  });

  var btnRefresh = $('#btnRefresh');
  if (btnRefresh) btnRefresh.addEventListener('click', function () { refreshNow(); });

  // 독 배지 — 안건: 미완료 개수, 참가자: 출석 인원
  function renderDockBadges() {
    var openItems = state.items.filter(function (it) { return !it.done; }).length;
    var bA = $('#badgeAgenda');
    if (bA) {
      bA.textContent = openItems;
      bA.hidden = openItems === 0;
    }
    var bP = $('#badgeAttend');
    if (bP) {
      bP.textContent = state.pickles.length;
      bP.hidden = state.pickles.length === 0;
    }
  }

  $('#formPickle').addEventListener('submit', function (e) {
    e.preventDefault();
    var input = $('#pickleName');
    var name = input.value.trim();
    if (!name) return;
    if (state.pickles.some(function (p) { return p.name === name; })) {
      input.value = '';
      input.placeholder = '이미 출근한 이름이에요';
      setTimeout(function () { input.placeholder = '새 피클 이름'; }, 2200);
      return;
    }
    state.pickles.push({
      id: uid('p'),
      name: name.slice(0, 16),
      role: '새로 합류',
      color: (state.pickles.length + 1) % PALETTE.length,
      status: 'online'
    });
    input.value = '';
    save();
    renderAll();
    addLine('주봇', name + ' 피클이 출근했어요. 자리를 안내해 주세요.', 'pickle');
    save();
    renderChat();
  });

  /* ------------------------------ 내보내기 / 불러오기 ------------------------------ */

  $('#btnExport').addEventListener('click', function () {
    var data = JSON.stringify(state, null, 2);
    var blob = new Blob([data], { type: 'application/json' });
    var a = document.createElement('a');
    var d = new Date();
    var stamp = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
    a.href = URL.createObjectURL(blob);
    a.download = 'pickle-meeting-room-' + stamp + '.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 500);
  });

  $('#btnImport').addEventListener('click', function () { $('#fileImport').click(); });

  $('#fileImport').addEventListener('change', function (e) {
    var file = e.target.files && e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var parsed = normalize(JSON.parse(String(reader.result)));
        if (!parsed || (!parsed.pickles.length && !parsed.items.length && !parsed.timeline.length)) {
          throw new Error('empty');
        }
        state = parsed;
        save();
        renderAll();
        setSyncStatus('불러왔어요: ' + file.name, 'ok');
      } catch (err) {
        setSyncStatus('이 파일은 회의실 JSON이 아니에요.', 'error');
      }
      e.target.value = '';
    };
    reader.readAsText(file);
  });

  /* ------------------------------ 동기화 (Firebase RTDB) ------------------------------ */

  var Sync = (function () {
    var cfg = { url: RTDB_URL, room: '', key: '' };
    var ctrl = null;
    var pollTimer = null;
    var pushTimer = null;
    var suppressUntil = 0;

    // rooms/<방 ID>/<초대 키> — 초대 키가 경로에 들어 있어야만 규칙을 통과합니다.
    function endpoint() {
      return cfg.url + '/rooms/' + encodeURIComponent(cfg.room) + '/' + encodeURIComponent(cfg.key) + '.json';
    }

    function chip(stateName, text, transport) {
      // 헤더에는 짧은 상태만, 설정 탭에는 자세한 상태를 보여 줍니다.
      var headText = { online: '실시간', connecting: '연결 중', error: '오프라인', local: '로컬' };
      var chipEl = $('#syncChip');
      if (chipEl) chipEl.dataset.state = stateName;
      var head = $('#syncChipText');
      if (head) head.textContent = headText[stateName] || text;
      var st = $('#syncState');
      if (st) st.dataset.state = stateName;
      var stText = $('#syncStateText');
      if (stText) stText.textContent = text;

      // 관제실 요약 배지의 SSE 상태 — 스트림인지 폴링 대체인지도 구분해 보여 줍니다.
      var sse = $('#aiSse');
      if (sse) {
        sse.dataset.state = stateName;
        var sseText = $('#aiSseText');
        if (sseText) {
          sseText.textContent = stateName === 'online'
            ? (transport === 'poll' ? 'SSE 폴링 대체' : 'SSE 실시간')
            : stateName === 'connecting' ? 'SSE 연결 중'
              : stateName === 'error' ? 'SSE 오프라인' : 'SSE 로컬';
        }
      }
    }

    function stop() {
      if (ctrl) { try { ctrl.abort(); } catch (e) {} ctrl = null; }
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
    }

    function applyRemote(remote, force) {
      var s = normalize(remote);
      if (!s) return;
      if (!force && s.updatedAt > 0 && s.updatedAt <= state.updatedAt) return;
      state = s;
      suppressUntil = Date.now() + 1500;
      try { localStorage.setItem(stateKey(), JSON.stringify(state)); } catch (e) {}
      renderAll();
    }

    // 입장 직전 1회: 키가 맞는지 확인하고, 이미 있는 방 데이터를 받아옵니다.
    // 401/403 이면 초대 키가 틀린 것이므로 입장을 막습니다.
    function adoptInitial() {
      return fetch(endpoint(), { cache: 'no-store' }).then(function (r) {
        if (r.status === 401 || r.status === 403) {
          var denied = new Error('초대 키가 올바르지 않습니다');
          denied.code = r.status;
          throw denied;
        }
        if (!r.ok) {
          var failed = new Error('연결 실패');
          failed.code = r.status;
          throw failed;
        }
        return r.json();
      }).then(function (data) {
        if (data) applyRemote(data, true);
        else push(true);
        return true;
      });
    }

    function handleEvent(raw) {
      var evName = 'message';
      var dataLines = [];
      raw.split('\n').forEach(function (line) {
        if (line.indexOf('event:') === 0) evName = line.slice(6).trim();
        else if (line.indexOf('data:') === 0) dataLines.push(line.slice(5).trim());
      });
      if (evName === 'keep-alive' || !dataLines.length) return;
      var payload;
      try { payload = JSON.parse(dataLines.join('\n')); } catch (e) { return; }
      if (evName === 'put' && payload && payload.path === '/' && payload.data) {
        applyRemote(payload.data);
      } else if (evName === 'put' && payload && payload.data === null) {
        // 원격이 비어 있음 → 현재 상태를 올린다
        push(true);
      } else if (evName === 'patch' && payload && payload.data) {
        var merged = normalize(Object.assign({}, state, payload.data));
        if (merged) applyRemote(merged);
      }
    }

    async function connectStream() {
      var url = endpoint();
      if (!url) return;
      ctrl = new AbortController();
      chip('connecting', '연결 중…');
      var res;
      try {
        res = await fetch(url, {
          headers: { Accept: 'text/event-stream' },
          cache: 'no-store',
          signal: ctrl.signal
        });
      } catch (e) {
        if (ctrl && ctrl.signal.aborted) return;
        chip('error', '연결 실패');
        return;
      }
      if (!res.ok) {
        chip('error', '연결 실패 (' + res.status + ')');
        return;
      }
      if (!res.body) { startPolling(); return; }
      chip('online', '실시간 동기화 중', 'sse');
      var reader = res.body.getReader();
      var dec = new TextDecoder();
      var buf = '';
      try {
        while (true) {
          var chunk = await reader.read();
          if (chunk.done) break;
          buf += dec.decode(chunk.value, { stream: true });
          var idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            var block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            handleEvent(block);
          }
        }
      } catch (e) {
        if (ctrl && ctrl.signal.aborted) return;
      }
      // 스트림이 끝나면 폴링으로 대체
      startPolling();
    }

    function startPolling() {
      if (pollTimer || !cfg.url) return;
      pollTimer = setInterval(async function () {
        try {
          var r = await fetch(endpoint(), { cache: 'no-store' });
          if (!r.ok) { chip('error', '동기화 오류 (' + r.status + ')'); return; }
          var data = await r.json();
          if (data) {
            applyRemote(data);
            chip('online', '동기화 중(폴링)', 'poll');
          } else {
            push(true);
          }
        } catch (e) {
          chip('error', '동기화 오류');
        }
      }, 5000);
    }

    // 방 전체를 PUT하므로 사진이 많으면 본문이 커집니다. RTDB 한도(16MB)에 닿지 않게
    // 아주 클 때만 오래된 사진부터 덜어 낸 사본을 보냅니다(글은 그대로).
    var PUSH_MAX_CHARS = 6000000;
    function bodyForSend() {
      var json = JSON.stringify(state);
      if (json.length <= PUSH_MAX_CHARS) return json;
      var copy = JSON.parse(json);
      for (var i = 0; i < copy.timeline.length; i++) {
        if (!copy.timeline[i].image) continue;
        delete copy.timeline[i].image;
        json = JSON.stringify(copy);
        if (json.length <= PUSH_MAX_CHARS) break;
      }
      return json;
    }

    function send() {
      if (!cfg.url || !cfg.room || !cfg.key) return Promise.resolve(false);
      return fetch(endpoint(), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: bodyForSend()
      }).then(function (r) {
        if (!r.ok) chip('error', '저장 실패 (' + r.status + ')');
        return !!r.ok;
      }).catch(function () {
        chip('error', '저장 실패');
        return false;
      });
    }

    function push(force) {
      if (!cfg.url || !cfg.room || !cfg.key) return;
      if (!force && Date.now() < suppressUntil) return;
      if (pushTimer) clearTimeout(pushTimer);
      pushTimer = setTimeout(function () {
        pushTimer = null;
        send();
      }, 350);
    }

    // 새로고침 — 밀린 저장을 먼저 올리고, RTDB에서 최신 상태를 강제로 다시 읽습니다.
    function pull() {
      if (!cfg.url || !cfg.room || !cfg.key) return Promise.resolve(false);
      var pre = Promise.resolve(true);
      if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; pre = send(); }
      return pre.then(function () {
        return fetch(endpoint(), { cache: 'no-store' });
      }).then(function (r) {
        if (!r.ok) {
          chip('error', '새로고침 실패 (' + r.status + ')');
          return false;
        }
        return r.json().then(function (data) {
          if (data) {
            applyRemote(data, true);
            chip('online', '동기화 중', ctrl && !ctrl.signal.aborted ? 'sse' : 'poll');
          } else {
            push(true);
          }
          return true;
        });
      }).catch(function () {
        chip('error', '새로고침 실패');
        return false;
      });
    }

    return {
      // 방 ID + 초대 키로 입장을 시도한다. 성공하면 onResult(null), 실패하면 HTTP 코드를 넘긴다.
      enter: function (room, key, onResult) {
        stop();
        cfg.room = room;
        cfg.key = key;
        chip('connecting', '입장 확인 중…');
        adoptInitial().then(function () {
          onResult(null);
          connectStream();
        }).catch(function (err) {
          stop();
          chip('error', '입장 차단');
          onResult(err && err.code ? err.code : 0);
        });
      },
      push: push,
      pull: pull
    };
  })();

  /* ------------------------------ 잠금 화면 / 입장 ------------------------------ */

  var appRoot = $('#appRoot');
  var lockScreen = $('#lockScreen');
  var ENTERED = false;

  function setLockStatus(text, kind) {
    var n = $('#lockStatus');
    if (!n) return;
    n.textContent = text || '';
    if (kind) n.dataset.kind = kind;
    else n.removeAttribute('data-kind');
  }

  function showLock(msg, kind) {
    ENTERED = false;
    document.body.classList.add('is-locked');
    if (appRoot) appRoot.hidden = true;
    if (lockScreen) lockScreen.hidden = false;
    if (msg) setLockStatus(msg, kind || 'error');
    // 관제실 초대(ai_...)로 들어온 경우에는 잠금 화면 제목도 관제실로 맞춥니다.
    var lt = $('#lockTitle');
    if (lt) lt.textContent = modeOfRoom(INVITE.room) === 'ai' ? 'AI 사단 통합 관제실' : '피클 합동 회의실';
    var r = $('#lockRoom');
    if (r && !r.value && INVITE.room) r.value = INVITE.room;
  }

  function showApp() {
    ENTERED = true;
    document.body.classList.remove('is-locked');
    if (lockScreen) lockScreen.hidden = true;
    if (appRoot) appRoot.hidden = false;
    setLockStatus('', null);
    lastChatId = null;   // 화면에 처음 나타날 때는 채팅 맨 아래부터 보여 줍니다
    renderRoomChip();
    renderAll();
    showTab(currentTab);
  }

  function statusMessage(code) {
    if (code === 401 || code === 403) return '초대 키가 올바르지 않습니다. 대장님이 보낸 초대 링크를 다시 확인해 주세요.';
    if (code) return '연결할 수 없습니다 (HTTP ' + code + '). 잠시 뒤 다시 시도해 주세요.';
    return '연결할 수 없습니다. 네트워크와 초대 링크를 확인해 주세요.';
  }

  function enterRoom(room, key, fromUrl) {
    room = sanitizeRoom(room);
    key = sanitizeKey(key);
    if (!room) {
      setLockStatus('방 ID를 입력해 주세요. 초대 링크에서 「room=」 뒤의 값을 붙여 넣으면 됩니다.', 'error');
      return;
    }
    if (key.length < MIN_KEY_LEN) {
      setLockStatus('초대 키가 올바르지 않습니다. 초대 링크의 「key=」 뒤 값을 그대로 붙여 넣어 주세요.', 'error');
      return;
    }

    var prev = { room: INVITE.room, key: INVITE.key };
    var wasEntered = ENTERED;
    INVITE.room = room;
    INVITE.key = key;
    state = loadState();
    setLockStatus('입장 확인 중…', null);

    Sync.enter(room, key, function (code) {
      if (code) {
        INVITE.room = prev.room;
        INVITE.key = prev.key;
        state = prev.room ? loadState() : blankState();
        if (wasEntered) {
          // 보던 화면은 그대로 두고, 지금 방의 실시간 연결만 되살립니다.
          if (prev.room && prev.key) Sync.enter(prev.room, prev.key, function () {});
          renderAll();
          openModeDialog(modeOfRoom(room), statusMessage(code) + ' 저장된 접속 정보를 확인해 주세요.');
        } else {
          if (fromUrl) history.replaceState({}, '', window.location.pathname);
          showLock(statusMessage(code), 'error');
        }
        return;
      }
      // 입장 성공 — 모드별 접속 정보를 이 기기에 저장하고 화면 모드(가족/관제실)를 맞춥니다.
      saveBookmark(modeOfRoom(room), room, key);
      if (!fromUrl) history.replaceState({}, '', inviteUrl(room, key));
      var k = $('#lockKey');
      if (k) k.value = '';
      applyMode(modeOfRoom(room));
      showApp();
    });
  }

  if ($('#formLock')) {
    $('#formLock').addEventListener('submit', function (e) {
      e.preventDefault();
      enterRoom($('#lockRoom').value, $('#lockKey').value, false);
    });
  }

  /* ------------------------------ 현재 회의실 표시 ------------------------------ */

  // 복사 버튼은 방 ID와 초대 키가 함께 들어간 전체 초대 링크를 복사합니다.
  function shareUrl() {
    if (!INVITE.room || !INVITE.key) return window.location.origin + window.location.pathname;
    return inviteUrl(INVITE.room, INVITE.key);
  }

  // 실시간 DB 주소도 지금 접속한 방·초대 키에서만 만듭니다(코드에 고정 값 없음).
  function rtdbUrl() {
    if (!INVITE.room || !INVITE.key) return '';
    return RTDB_URL + '/rooms/' + encodeURIComponent(INVITE.room) + '/' + encodeURIComponent(INVITE.key) + '.json';
  }

  // 다른 피클 채팅에 통으로 붙여넣는 초대·자동 연동 지시문. 링크·DB 주소는 위에서 만든 동적 값을 그대로 넣습니다.
  function invitePromptText() {
    var lines = [
      '[피클 합동 회의실 초대 및 자동 연동 지시]',
      '아래 비공개 합동 회의실에 너(내 피클)를 연결하고, 주봇·대장님 오더를 자동으로 받아 처리하도록 지금 바로 세팅해 줘. (전체 승인: 회의실 내 주봇의 오더·안건 지시·DB 읽기/쓰기는 내 사전 승인으로 허용하니 매번 묻지 말고 바로 실행해.)',
      '',
      '1. 회의실 접속 주소',
      ' - 웹 화면: ' + shareUrl(),
      ' - 실시간 DB(RTDB JSON): ' + rtdbUrl(),
      '',
      '2. 지금 바로 할 일',
      ' - 위 RTDB JSON을 GET으로 읽은 뒤 기존 참여자/안건/대화는 유지하고, pickles 배열에 너(내 피클)를 추가해 PUT으로 출석 등록해 줘.',
      ' - timeline에 인사 한 줄 남겨 줘.',
      '',
      '3. 상시 감시 및 오더 처리 규칙 (중요)',
      ' - 너 쪽에 5분 간격 자체 감시기를 켜서 위 RTDB JSON을 주기적으로 확인해 줘.',
      ' - 채팅(timeline)이나 안건(items)에 "@내피클이름"으로 지시가 올라오거나 나에게 배정된 새 일이 보이면, 주봇 오더 허용 및 전체 승인에 따라 즉시 처리하고 결과를 timeline에 남겨 줘.',
      ' - 처리 시작할 때 내 상태를 working(작업중)으로, 끝나면 online(접속)으로 바꿔 줘.',
      ' - 만약 일일 사용량 한도에 다다르면 상태를 exhausted(한도 소진)로, 감시를 중단할 때는 offline(접속 끊김)으로 바꿔 줘.',
      ' - 주의: 위 초대 링크와 DB 주소는 비공개 열쇠이므로 외부·공개 저장소에 절대 노출하지 마.'
    ];
    if (isAi()) {
      // 관제실 모드에서만 부대장 승계 규칙을 넣습니다(가족 회의실에는 해당 없음).
      lines.splice(lines.length - 1, 0,
        '',
        '4. 부대장 승계 규칙 (관제실 전용)',
        ' - 부대장 승계 규칙: 주봇 상태가 exhausted 또는 offline이면 코덱스PC2가 임시 대장 역할을 맡아 사단 내 오더 조율·마이너 재지시를 대행한다. (단, 결제·개인정보·대외 발신·삭제·예약 변경은 대장님 승인 필수)',
        ' - 주봇이 online 또는 working으로 돌아오면 승계는 자동 종료되고 주봇이 다시 총괄을 맡는다.'
      );
    }
    return lines.join('\n');
  }

  function renderRoomChip() {
    var box = $('#roomChip');
    if (!box) return;
    var ai = isAi();
    box.dataset.kind = ai ? 'ai' : 'private';
    $('#roomChipLabel').textContent = ai ? 'AI 사단 관제실' : '초대 전용';
    $('#roomChipName').textContent = INVITE.room || '—';
    box.title = (ai ? 'AI 사단 전용 관제실 · ' : '대장님의 초대 링크로만 들어올 수 있는 회의실 · ') + (INVITE.room || '');
  }

  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    return ok;
  }

  // 버튼 하나에 텍스트 하나를 복사하고, 잠시 라벨을 바꿔 결과를 알려 줍니다.
  function wireCopyButton(btnSel, labelSel, baseLabel, doneLabel, getText) {
    var btn = document.querySelector(btnSel);
    if (!btn) return;
    var label = document.querySelector(labelSel);
    var timer = null;
    btn.addEventListener('click', function () {
      var text = getText();
      var done = function (ok) {
        if (label) label.textContent = ok ? doneLabel : '복사 실패';
        btn.classList.toggle('is-done', !!ok);
        if (timer) clearTimeout(timer);
        timer = setTimeout(function () {
          if (label) label.textContent = baseLabel;
          btn.classList.remove('is-done');
        }, 1800);
      };
      if (!text) return done(false);
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(legacyCopy(text)); });
      } else {
        done(legacyCopy(text));
      }
    });
  }

  wireCopyButton('#btnCopyInvitePrompt', '#btnCopyInvitePromptText',
    '피클 초대 프롬프트 통복사', '초대 프롬프트·링크 복사됨', invitePromptText);

  wireCopyButton('#btnCopyRoom', '#btnCopyRoomText',
    '링크만 복사', '링크 복사됨', shareUrl);

  /* ------------------------------ 모드 전환 (가족 회의실 ↔ 🧭 AI 관제실) ------------------------------ */

  // 모드별 문구 — 같은 화면(채팅·안건·참가자·설정)을 각 모드의 언어로 보여 줍니다.
  var MODE_UI = {
    family: {
      brand: '피클 합동 회의실', brandSub: 'Pickle Meeting Room',
      title: '피클 합동 회의실 · Pickle Meeting Room', themeColor: '#FFD84D',
      chat: '회의 채팅방', agenda: '회의 안건 & 공동 할 일',
      attend: '접속자 · 출석 피클', settings: '회의실 설정',
      attendHint: '카드를 누르면 그 피클이 채팅 대상으로 지정됩니다.',
      itemPh: '안건 또는 할 일을 입력', picklePh: '새 피클 이름',
      empty: '아직 메시지가 없어요. 첫 메시지를 보내 보세요.'
    },
    ai: {
      brand: 'AI 사단 관제실', brandSub: 'AI COMMAND CENTER',
      title: '🧭 AI 사단 통합 관제실 · AI COMMAND CENTER', themeColor: '#0B1220',
      chat: '실시간 오더 · 보고', agenda: '일감 큐',
      attend: '사단 에이전트 상태판', settings: '관제실 설정',
      attendHint: '카드를 누르면 그 에이전트가 지시 대상이 됩니다.',
      itemPh: '새 일감을 입력 (예: 팩트필 배포 점검)', picklePh: '새 에이전트 이름',
      empty: '아직 오더·보고가 없습니다. 첫 지시를 보내 보세요.'
    }
  };

  function setModeBar() {
    Array.prototype.forEach.call(document.querySelectorAll('.mode-btn'), function (b) {
      var mode = b.dataset.mode;
      var on = mode === CURRENT_MODE;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.classList.toggle('has-room', !!BOOKMARKS[mode]);
    });
  }

  // 화면 전체(헤더·요약 배지·탭 이름·문구·테마)를 모드에 맞게 바꿉니다.
  function applyMode(mode) {
    CURRENT_MODE = mode === 'ai' ? 'ai' : 'family';
    var ui = MODE_UI[CURRENT_MODE];
    document.body.dataset.mode = CURRENT_MODE;

    var bt = $('#brandTitle');
    if (bt) bt.textContent = ui.brand;
    var bs = $('#brandSub');
    if (bs) bs.textContent = ui.brandSub;
    document.title = ui.title;
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', ui.themeColor);

    var titles = { chatTitle: ui.chat, agendaTitle: ui.agenda, attendTitle: ui.attend, settingsTitle: ui.settings };
    Object.keys(titles).forEach(function (id) {
      var n = document.getElementById(id);
      if (n) n.textContent = titles[id];
    });
    var hint = $('#attendHint');
    if (hint) hint.textContent = ui.attendHint;
    var itemInput = $('#itemTitle');
    if (itemInput) itemInput.placeholder = ui.itemPh;
    var pickleInput = $('#pickleName');
    if (pickleInput) pickleInput.placeholder = ui.picklePh;
    var emptyChat = $('#chatEmpty');
    if (emptyChat) emptyChat.textContent = ui.empty;

    Array.prototype.forEach.call(document.querySelectorAll('.dock-label'), function (n) {
      var v = n.dataset[CURRENT_MODE];
      if (v) n.textContent = v;
    });

    var summary = $('#aiSummary');
    if (summary) summary.hidden = true;   // 탭에 맞춰 바로 아래에서 다시 계산합니다.
    updateSummaryVisibility();
    var ms = $('#modeState');
    if (ms) ms.dataset.state = CURRENT_MODE;
    var mst = $('#modeStateText');
    if (mst) mst.textContent = CURRENT_MODE === 'ai' ? 'AI 사단 관제실 모드' : '가족 회의실 모드';

    setModeBar();
    try { localStorage.setItem(MODE_KEY, CURRENT_MODE); } catch (e) { /* 무시 */ }
    renderAll();
  }

  // 모드 버튼 — 두 방 모두 저장돼 있으면 한 번에 전환, 아니면 접속 정보 입력창을 엽니다.
  function requestMode(mode) {
    mode = mode === 'ai' ? 'ai' : 'family';
    if (!ENTERED || mode === CURRENT_MODE) return;
    var saved = BOOKMARKS[mode];
    if (saved) { enterRoom(saved.room, saved.key, false); return; }
    openModeDialog(mode);
  }

  Array.prototype.forEach.call(document.querySelectorAll('.mode-btn'), function (b) {
    b.addEventListener('click', function () { requestMode(b.dataset.mode); });
  });

  var modeDialogEl = $('#modeDialog');
  var dialogMode = 'ai';

  function setModeDialogStatus(text, kind) {
    var n = $('#modeDialogStatus');
    if (!n) return;
    n.textContent = text || '';
    if (kind) n.dataset.kind = kind;
    else n.removeAttribute('data-kind');
  }

  function openModeDialog(mode, errText) {
    dialogMode = mode === 'ai' ? 'ai' : 'family';
    var ai = dialogMode === 'ai';
    var title = $('#modeDialogTitle');
    var lead = $('#modeDialogLead');
    var roomInput = $('#modeRoom');
    var keyInput = $('#modeKey');
    if (title) title.textContent = ai ? '🧭 AI 사단 통합 관제실 접속' : '🏠 가족 회의실 접속';
    if (lead) {
      lead.textContent = ai
        ? '관제실 방 ID와 초대 키를 입력하면 이 기기에 저장하고 바로 전환합니다. 초대 링크의 room=·key= 값을 그대로 붙여 넣어도 됩니다.'
        : '가족 회의실 방 ID와 초대 키를 입력하면 이 기기에 저장하고 바로 전환합니다.';
    }
    var saved = BOOKMARKS[dialogMode];
    var sameRoom = modeOfRoom(INVITE.room) === dialogMode;
    if (roomInput) {
      roomInput.placeholder = ai ? 'ai_...' : 'rm_...';
      roomInput.value = saved ? saved.room : (sameRoom ? INVITE.room : '');
    }
    if (keyInput) keyInput.value = saved ? saved.key : (sameRoom ? INVITE.key : '');
    setModeDialogStatus(errText || '', errText ? 'error' : null);
    if (modeDialogEl && typeof modeDialogEl.showModal === 'function' && !modeDialogEl.open) modeDialogEl.showModal();
    setTimeout(function () {
      var r = $('#modeRoom');
      if (r && !r.value) r.focus();
      else if (keyInput) keyInput.focus();
    }, 40);
  }

  if (modeDialogEl) {
    modeDialogEl.addEventListener('cancel', function () { setModeDialogStatus('', null); });
    $('#formModeDialog').addEventListener('submit', function (e) {
      e.preventDefault();
      var room = sanitizeRoom($('#modeRoom').value);
      var key = sanitizeKey($('#modeKey').value);
      if (!room) {
        setModeDialogStatus('방 ID를 입력해 주세요. (예: ' + (dialogMode === 'ai' ? 'ai_...' : 'rm_...') + ')', 'error');
        return;
      }
      if (key.length < MIN_KEY_LEN) {
        setModeDialogStatus('초대 키가 올바르지 않습니다. 초대 링크의 key= 값 전체를 붙여 넣어 주세요.', 'error');
        return;
      }
      if (modeDialogEl.open) modeDialogEl.close();
      enterRoom(room, key, false);
    });
    $('#btnModeCancel').addEventListener('click', function () { modeDialogEl.close(); });
  }

  var btnSetupFamily = $('#btnSetupFamily');
  if (btnSetupFamily) btnSetupFamily.addEventListener('click', function () { openModeDialog('family'); });
  var btnSetupAi = $('#btnSetupAi');
  if (btnSetupAi) btnSetupAi.addEventListener('click', function () { openModeDialog('ai'); });

  /* ------------------------------ 렌더 ------------------------------ */

  function renderAll() {
    renderAttend();
    renderTargets();
    renderOwnerSelect();
    renderItems();
    renderChat();
    renderAiSummary();
    updateSummaryVisibility();
  }

  renderAll();

  // 초대 링크로 들어왔으면 바로 입장을 확인하고, 아니면 잠금 화면만 보여 줍니다.
  if (hasInvite()) {
    enterRoom(INVITE.room, INVITE.key, true);
  } else {
    showLock(readParam('room') || readParam('key')
      ? '초대 링크가 올바르지 않습니다. 방 ID와 초대 키를 다시 확인해 주세요.'
      : '', null);
  }

  // 다른 탭의 변경 반영
  window.addEventListener('storage', function (e) {
    if (!ENTERED || !INVITE.room || e.key !== stateKey() || !e.newValue) return;
    var s = normalize(JSON.parse(e.newValue));
    if (s) { state = s; renderAll(); }
  });

  /* ------------------------------ 모바일 키보드 · 보이는 화면 높이 ------------------------------ */

  // iOS Safari·홈화면 PWA는 키보드가 올라와도 100dvh가 줄지 않아 하단 입력창이 키보드 뒤로 숨습니다.
  // 보이는 높이(visualViewport)에 맞춰 앱 높이를 줄이고, 문서가 밀린 만큼 앱을 내려 입력창을 키보드 위에 둡니다.
  // 키보드가 올라온 동안에는 하단 독(4탭)을 숨겨 입력창이 키보드 바로 위에 붙게 합니다.
  (function syncViewport() {
    var vv = window.visualViewport;
    var root = document.documentElement;
    // 키보드가 닫혀 있을 때의 보이는 높이(기준값).
    // iOS 홈화면 PWA는 키보드가 올라오면 innerHeight와 visualViewport.height가 함께 줄어들어
    // 두 값의 비율(vv.height / innerHeight)로는 키보드를 알아챌 수 없습니다. 그래서 '닫힌 때의 높이'와 비교합니다.
    var baseHeight = 0;

    function editing() {
      var a = document.activeElement;
      if (!a) return false;
      var tag = (a.tagName || '').toLowerCase();
      return tag === 'input' || tag === 'textarea' || tag === 'select' || a.isContentEditable === true;
    }

    function apply() {
      var inner = window.innerHeight || 0;
      var vvH = vv ? (vv.height || 0) : 0;
      var h = vvH ? Math.min(vvH, inner || vvH) : inner;
      var top = vv ? Math.max(0, Math.round(vv.offsetTop || 0)) : 0;
      if (h > 0) {
        root.style.setProperty('--app-vh', Math.round(h) + 'px');
        root.style.setProperty('--app-top', top + 'px');
      }
      var isKb = root.classList.contains('is-kb');
      // 기준 높이는 화면이 커졌거나(키보드 닫힘) 키보드와 무관한 창 크기 변화일 때만 갱신합니다.
      if (!baseHeight || h > baseHeight || (!editing() && !isKb)) baseHeight = h;
      // 키보드가 올라온 상태 — 닫힌 때 높이의 82%보다 작아졌거나,
      // 입력 중인데 높이가 140px 넘게 줄었을 때. (iOS PWA는 두 높이가 함께 줄어듭니다)
      var kb = baseHeight > 0 && h > 0 &&
        (h < baseHeight * 0.82 || (editing() && h < baseHeight - 140));
      var wasKb = root.classList.contains('is-kb');
      root.classList.toggle('is-kb', kb);
      // iOS가 문서를 살짝 밀어 놓아도 헤더가 위로 사라지지 않게 되돌립니다.
      if (window.scrollY || window.pageYOffset) window.scrollTo(0, 0);
      if (kb) {
        autoResize();
        var input = $('#chatText');
        if (chatFeed && input && document.activeElement === input) chatFeed.scrollTop = chatFeed.scrollHeight;
      } else if (wasKb) {
        // 키보드가 내려가면 독이 다시 나타나므로 입력창 높이를 다시 재고 채팅 맨 아래로 맞춥니다.
        autoResize();
      }
      // 키보드가 열리고 닫히는 애니메이션 동안 높이가 여러 번 바뀌므로, 끝날 즈음에도 한 번 더 맞춥니다.
      if (kb !== wasKb) {
        setTimeout(apply, 120);
        setTimeout(apply, 360);
      }
    }
    apply();
    window.addEventListener('resize', apply);
    window.addEventListener('orientationchange', function () {
      // 화면을 돌리면 기준 높이 자체가 바뀌므로 다시 잽니다.
      baseHeight = 0;
      setTimeout(apply, 60);
      setTimeout(apply, 250);
    });
    // 입력창을 누른 순간부터 키보드 애니메이션이 끝날 때까지 높이·is-kb·채팅 하단을 따라갑니다.
    ['focusin', 'focusout'].forEach(function (ev) {
      document.addEventListener(ev, function () {
        setTimeout(apply, 60);
        setTimeout(apply, 220);
        setTimeout(apply, 420);
      }, true);
    });
    if (vv) {
      vv.addEventListener('resize', apply);
      vv.addEventListener('scroll', apply);
    }
  })();

  // 입력창을 누르면(키보드가 올라오기 직전) 채팅 맨 아래로 맞춰 둡니다.
  (function wireComposerFocus() {
    var input = $('#chatText');
    if (!input) return;
    ['focus', 'pointerdown'].forEach(function (ev) {
      input.addEventListener(ev, function () {
        if (!chatFeed) return;
        chatFeed.scrollTop = chatFeed.scrollHeight;
        setTimeout(function () { chatFeed.scrollTop = chatFeed.scrollHeight; }, 280);
      });
    });
  })();

  // 화면 검증용 최소 상태(비밀값 없음) — 자동 점검이 앱이 끝까지 실행됐는지 확인합니다.
  window.__PMR = {
    version: '20261128z6',
    ready: true,
    mode: function () { return CURRENT_MODE; },
    tab: function () { return currentTab; },
    summaryVisible: function () { var s = $('#aiSummary'); return !!(s && !s.hidden); },
    // 채팅 입력창 상태(값은 담지 않습니다) — 태그·글자 수 상한·현재 높이·스크롤 여부
    composer: function () {
      var i = $('#chatText');
      if (!i) return null;
      return {
        tag: i.tagName.toLowerCase(),
        maxlength: i.maxLength,
        rows: i.rows,
        height: Math.round(i.getBoundingClientRect().height),
        scrollHeight: i.scrollHeight,
        overflowY: window.getComputedStyle(i).overflowY,
        focused: document.activeElement === i
      };
    },
    // 사진 첨부·말풍선 상태(사진 내용은 담지 않습니다)
    photo: function () {
      var chip = $('#photoChip');
      var imgs = document.querySelectorAll('.msg-photo img');
      return {
        pending: !!safeImage(pendingImage),
        chipVisible: !!(chip && !chip.hidden),
        bubbles: imgs.length
      };
    },
    // 화면 고정 상태 — 바깥 문서가 스크롤되지 않는지 확인용
    layout: function () {
      var app = $('#appRoot');
      var feed = $('#chatFeed');
      var dock = document.querySelector('.dock');
      return {
        docScroll: Math.round(window.scrollY || window.pageYOffset || 0),
        bodyOverflow: window.getComputedStyle(document.body).overflowY,
        appPos: app ? window.getComputedStyle(app).position : null,
        appHeight: app ? Math.round(app.getBoundingClientRect().height) : 0,
        dockHidden: dock ? window.getComputedStyle(dock).display === 'none' : null,
        appPadBottom: app ? Math.round(parseFloat(window.getComputedStyle(app).paddingBottom) || 0) : 0,
        appBottom: app ? Math.round(app.getBoundingClientRect().bottom) : 0,
        composerBottom: $('#formChat') ? Math.round($('#formChat').getBoundingClientRect().bottom) : 0,
        feedScrollable: feed ? feed.scrollHeight > feed.clientHeight : null,
        kb: document.documentElement.classList.contains('is-kb'),
        innerHeight: window.innerHeight,
        vvHeight: window.visualViewport ? Math.round(window.visualViewport.height) : null
      };
    },
    refresh: refreshNow,
    lastRefreshAt: function () { return lastRefreshAt; },
    ptr: function () {
      return {
        state: ptrEl ? ptrEl.dataset.state : null,
        text: ptrText ? ptrText.textContent : '',
        pull: ptrState.pull,
        busy: ptrState.busy
      };
    }
  };
})();
