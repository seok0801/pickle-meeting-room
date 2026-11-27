/* 피클 합동 회의실 — app.js
   단일 페이지 앱: 오피스 맵(SVG + 캐릭터), 말풍선 채팅방, 출석 보드, 안건/할 일.
   저장: localStorage → (선택) Firebase Realtime Database 실시간 동기화. */
(function () {
  'use strict';

  var KEY_HEAD = 'pickle-meeting-room/v2';
  var MAX_TL = 60;
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

  function inviteUrl(room, key) {
    return window.location.origin + window.location.pathname +
      '?room=' + encodeURIComponent(room) + '&key=' + encodeURIComponent(key);
  }

  /* ------------------------------ 팔레트 / 좌석 ------------------------------ */

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

  // 오피스 맵(900x520) 위 좌석 좌표(%)
  var SEATS = [
    { x: 19.2, y: 24.0, zone: '회의실' },
    { x: 40.8, y: 24.0, zone: '회의실' },
    { x: 13.9, y: 38.3, zone: '회의실' },
    { x: 45.9, y: 38.3, zone: '회의실' },
    { x: 19.2, y: 49.8, zone: '회의실' },
    { x: 40.8, y: 49.8, zone: '회의실' },
    { x: 68.9, y: 58.5, zone: '작업실' },
    { x: 84.4, y: 58.5, zone: '작업실' },
    { x: 13.5, y: 81.5, zone: '라운지' },
    { x: 25.0, y: 81.5, zone: '라운지' },
    { x: 49.4, y: 82.7, zone: '라운지' },
    { x: 71.0, y: 81.5, zone: '라운지' }
  ];

  var STATUS_LABEL = { online: '온라인', working: '작업중', away: '대기' };
  var STATUS_ORDER = ['online', 'working', 'away'];

  // 처음 배치할 때 구역을 골고루 나눠 앉힌다.
  var PREF_ZONES = ['회의실', '회의실', '작업실', '작업실', '라운지', '회의실', '작업실', '라운지'];

  var LINES = {
    주봇: ['회의 시작할까요?', '안건 순서대로 볼게요', '모두 모였네요!', '오늘도 화이팅이에요', '기록은 민트가 맡아요'],
    general: [
      '확인했어요', '좋아요!', '할 일 하나 끝냈어요', '커피 한 잔 충전 중 ☕',
      '주말 나들이 기대돼요', '장보기 리스트 정리했어요', '다음 안건 넘어갈까요?',
      '회의실 정리해 뒀어요', '라운지에 간식 있어요', '안건 하나 더 있어요'
    ]
  };

  /* ------------------------------ 상태 ------------------------------ */

  function uid(prefix) {
    return (prefix || 'id') + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
  }

  // 초대받은 방의 초기 상태 — 데모 샘플을 넣지 않고 주봇만 앉혀 둡니다.
  function blankState() {
    return {
      version: 1,
      updatedAt: Date.now(),
      pickles: [
        { id: 'p-jubot', name: '주봇', role: '회의 진행', color: 0, status: 'online' }
      ],
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

  function normalize(s) {
    if (!s || typeof s !== 'object') return null;
    var out = {
      version: 1,
      updatedAt: Number(s.updatedAt) || Date.now(),
      pickles: [],
      items: [],
      timeline: []
    };
    (Array.isArray(s.pickles) ? s.pickles : []).forEach(function (p, i) {
      if (!p || typeof p.name !== 'string' || !p.name.trim()) return;
      out.pickles.push({
        id: String(p.id || uid('p')),
        name: String(p.name).slice(0, 24),
        role: typeof p.role === 'string' ? p.role.slice(0, 40) : '합류한 피클',
        color: Number.isFinite(p.color) ? ((Number(p.color) % PALETTE.length) + PALETTE.length) % PALETTE.length : i % PALETTE.length,
        status: STATUS_LABEL[p.status] ? p.status : 'online'
      });
    });
    (Array.isArray(s.items) ? s.items : []).forEach(function (it) {
      if (!it || typeof it.title !== 'string' || !it.title.trim()) return;
      out.items.push({
        id: String(it.id || uid('i')),
        title: String(it.title).slice(0, 160),
        type: it.type === 'todo' ? 'todo' : 'agenda',
        done: !!it.done,
        owner: typeof it.owner === 'string' ? it.owner.slice(0, 24) : '',
        ts: Number(it.ts) || Date.now()
      });
    });
    (Array.isArray(s.timeline) ? s.timeline : []).forEach(function (m) {
      if (!m || typeof m.text !== 'string' || !m.text.trim()) return;
      out.timeline.push({
        id: String(m.id || uid('t')),
        who: String(m.who || '피클').slice(0, 24),
        text: String(m.text).slice(0, 400),
        ts: Number(m.ts) || Date.now(),
        kind: m.kind === 'note' ? 'note' : 'pickle'
      });
    });
    return out;
  }

  function save() {
    if (!INVITE.room || !INVITE.key) return;   // 초대 없이 열린 잠금 화면에서는 아무것도 저장하지 않는다
    state.updatedAt = Date.now();
    trimTimeline();
    try { localStorage.setItem(stateKey(), JSON.stringify(state)); } catch (e) { /* 용량 초과 등 */ }
    Sync.push();
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

  /* ------------------------------ 오피스 맵 ------------------------------ */

  var officeChars = $('#officeChars');
  var charEls = new Map();   // id -> element
  var charSeats = new Map(); // id -> seat index
  var speakTimers = new Map();

  function seatFree(idx, exceptId) {
    var taken = false;
    charSeats.forEach(function (seatIdx, id) {
      if (seatIdx === idx && id !== exceptId) taken = true;
    });
    return !taken;
  }

  function pickSeat(preferredZone, exceptId) {
    var pool = [];
    for (var i = 0; i < SEATS.length; i++) {
      if (!seatFree(i, exceptId)) continue;
      pool.push(i);
    }
    if (!pool.length) return -1;
    if (preferredZone) {
      var inZone = pool.filter(function (i) { return SEATS[i].zone === preferredZone; });
      if (inZone.length) return inZone[Math.floor(Math.random() * inZone.length)];
    }
    return pool[Math.floor(Math.random() * pool.length)];
  }

  function placeChar(node, seatIdx) {
    var s = SEATS[seatIdx];
    if (!s) return;
    node.style.left = s.x + '%';
    node.style.top = s.y + '%';
    var bubble = $('.bubble', node);
    if (bubble) {
      bubble.removeAttribute('data-edge');
      if (s.x < 26) bubble.setAttribute('data-edge', 'left');
      else if (s.x > 74) bubble.setAttribute('data-edge', 'right');
    }
  }

  function syncChars() {
    var alive = new Set();
    state.pickles.forEach(function (p, i) {
      alive.add(p.id);
      var node = charEls.get(p.id);
      var color = colorOf(p);
      if (!node) {
        node = document.createElement('button');
        node.type = 'button';
        node.className = 'char';
        node.dataset.id = p.id;
        officeChars.appendChild(node);
        charEls.set(p.id, node);
        var prefZone = PREF_ZONES[i] || ['회의실', '작업실', '라운지'][i % 3];
        var seat = pickSeat(prefZone, p.id);
        if (seat < 0) seat = i % SEATS.length;
        charSeats.set(p.id, seat);
        node.style.transition = 'none';
        placeChar(node, seat);
        // 첫 페인트 후 이동 트랜지션 복원
        requestAnimationFrame(function () { node.style.transition = ''; });
      }
      node.setAttribute('aria-label', p.name + ' — 인사하기');
      node.title = p.name + ' · ' + (STATUS_LABEL[p.status] || '온라인');
      var inner = $('.char-inner', node);
      var svgKey = color.body + '|' + color.ear;
      if (!inner) {
        node.innerHTML = '<span class="char-inner">' + pickleSvg(color, true) +
          '</span><span class="bubble" data-show="0" role="note"></span>';
      } else if (inner.dataset.key !== svgKey) {
        inner.innerHTML = pickleSvg(color, true);
        inner.dataset.key = svgKey;
      }
      var innerNow = $('.char-inner', node);
      if (innerNow && !innerNow.dataset.key) innerNow.dataset.key = svgKey;
    });

    charEls.forEach(function (node, id) {
      if (!alive.has(id)) {
        node.remove();
        charEls.delete(id);
        charSeats.delete(id);
        var t = speakTimers.get(id);
        if (t) { clearTimeout(t); speakTimers.delete(id); }
      }
    });
  }

  function speak(id, text, ms) {
    var node = charEls.get(id);
    if (!node) return;
    var bubble = $('.bubble', node);
    if (!bubble) return;
    bubble.textContent = text;
    bubble.setAttribute('data-show', '1');
    var prev = speakTimers.get(id);
    if (prev) clearTimeout(prev);
    var t = setTimeout(function () {
      bubble.setAttribute('data-show', '0');
      speakTimers.delete(id);
    }, ms || 3400);
    speakTimers.set(id, t);
  }

  function randomLine(p) {
    var pool = LINES[p.name] || LINES.general;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  function startChatter() {
    setInterval(function () {
      if (document.hidden) return;
      if (!state.pickles.length) return;
      var p = state.pickles[Math.floor(Math.random() * state.pickles.length)];
      speak(p.id, randomLine(p), 3600);
    }, 4600);

    setInterval(function () {
      if (document.hidden) return;
      var ids = Array.from(charSeats.keys());
      if (ids.length < 1) return;
      var id = ids[Math.floor(Math.random() * ids.length)];
      var current = charSeats.get(id);
      var s = SEATS[current];
      var zone = s ? s.zone : null;
      // 45%는 같은 구역 안에서 자리만 옮기고, 나머지는 다른 구역으로 이동
      var target = Math.random() < 0.45
        ? SEATS.map(function (v, i) { return i; }).filter(function (i) { return SEATS[i].zone === zone && seatFree(i, id); })
        : null;
      var next;
      if (target && target.length) {
        next = target[Math.floor(Math.random() * target.length)];
      } else {
        var others = ['회의실', '작업실', '라운지'].filter(function (z) { return z !== zone; });
        next = pickSeat(others[Math.floor(Math.random() * others.length)], id);
      }
      if (next == null || next < 0 || next === current) return;
      var node = charEls.get(id);
      if (!node) return;
      charSeats.set(id, next);
      node.dataset.walk = '1';
      placeChar(node, next);
      setTimeout(function () { if (node.dataset.walk === '1') delete node.dataset.walk; }, 2500);
    }, 9000);
  }

  officeChars.addEventListener('click', function (e) {
    var node = e.target.closest('.char');
    if (!node) return;
    var p = state.pickles.find(function (x) { return x.id === node.dataset.id; });
    if (!p) return;
    var greet = p.name === '주봇' ? '어서 오세요, 회의 준비됐어요!' : '안녕하세요, ' + p.name + '예요!';
    speak(p.id, greet, 3200);
  });

  /* ------------------------------ 출석 보드 ------------------------------ */

  var attendList = $('#attendList');
  var attendCount = $('#attendCount');

  function renderAttend() {
    attendList.textContent = '';
    state.pickles.forEach(function (p) {
      var li = el('li', 'attend-item');
      li.dataset.id = p.id;

      var face = el('span', 'attend-face');
      face.innerHTML = pickleSvg(colorOf(p), false);

      var meta = el('div', 'attend-meta');
      var nm = el('div', 'attend-name', p.name);
      var rl = el('div', 'attend-role', p.role || '합류한 피클');
      meta.appendChild(nm);
      meta.appendChild(rl);

      var right = el('div', 'attend-right');
      var sel = el('select', 'status-select');
      sel.setAttribute('aria-label', p.name + ' 상태');
      STATUS_ORDER.forEach(function (s) {
        var o = el('option', null, STATUS_LABEL[s]);
        o.value = s;
        if (p.status === s) o.selected = true;
        sel.appendChild(o);
      });
      sel.dataset.status = p.status;
      sel.addEventListener('change', function () {
        p.status = sel.value;
        sel.dataset.status = p.status;
        var node = charEls.get(p.id);
        if (node) node.title = p.name + ' · ' + STATUS_LABEL[p.status];
        react(p.name, STATUS_LABEL[p.status] + ' 상태로 바꿨어요');
        save();
        renderAttendSummary();
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

      li.appendChild(face);
      li.appendChild(meta);
      li.appendChild(right);
      attendList.appendChild(li);
    });
    renderAttendSummary();
  }

  function renderAttendSummary() {
    var n = state.pickles.length;
    var online = state.pickles.filter(function (p) { return p.status === 'online'; }).length;
    attendCount.textContent = n + '마리 참석';
    $('#attendStatus').textContent = ' · 온라인 ' + online;
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

  function renderItems() {
    itemList.textContent = '';
    var list = visibleItems();
    list.forEach(function (it) {
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
      var tag = el('span', 'tag ' + (it.type === 'todo' ? 'tag-todo' : 'tag-agenda'),
        it.type === 'todo' ? '할 일' : '안건');
      meta.appendChild(tag);
      var owner = it.owner && pickleNameById(it.owner) ? it.owner : (it.owner || '담당 미정');
      meta.appendChild(el('span', null, owner));
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
      itemList.appendChild(li);
    });

    itemEmpty.hidden = list.length > 0;
    var total = state.items.length;
    var done = state.items.filter(function (it) { return it.done; }).length;
    itemProgress.textContent = done + ' / ' + total + ' 완료';
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

  function addLine(who, text, kind) {
    state.timeline.push({
      id: uid('t'),
      who: who,
      text: String(text).slice(0, 400),
      ts: Date.now(),
      kind: kind === 'note' ? 'note' : 'pickle'
    });
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
    if (p) speak(p.id, tail, 2800);
    renderChat();
  }

  function fmtDate(ts) {
    var d = new Date(ts);
    return d.getFullYear() + '.' + String(d.getMonth() + 1).padStart(2, '0') + '.' + String(d.getDate()).padStart(2, '0');
  }

  // 이름에 맞는 피클 얼굴 — 출석한 피클이면 자기 색, 아니면 기본 피클
  function chatAvatar(who) {
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
  // 내 말(who === '나')은 오른쪽 노란 말풍선, 피클 말(주봇·모모 등)은 왼쪽 말풍선.
  function renderChat() {
    var items = state.timeline.slice().sort(function (a, b) { return a.ts - b.ts; });
    var nearBottom = chatFeed.scrollHeight - chatFeed.scrollTop - chatFeed.clientHeight < 80;
    chatFeed.textContent = '';

    var lastDay = '';
    items.forEach(function (m) {
      var day = fmtDate(m.ts);
      if (day !== lastDay) {
        chatFeed.appendChild(el('div', 'chat-day', day));
        lastDay = day;
      }

      var mine = m.who === '나';
      var row = el('div', 'msg' + (mine ? ' is-me' : ''));
      row.dataset.id = m.id;

      var body = el('div', 'msg-body');
      if (!mine) body.appendChild(el('span', 'msg-name', m.who));

      var line = el('div', 'msg-line');
      var bubble = el('div', 'msg-bubble', m.text);
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

      var av = el('span', 'msg-av' + (mine ? ' msg-av-me' : ''));
      if (mine) av.textContent = '나';
      else av.innerHTML = chatAvatar(m.who);
      av.setAttribute('aria-hidden', 'true');

      row.appendChild(av);
      row.appendChild(body);
      chatFeed.appendChild(row);
    });

    var last = items.length ? items[items.length - 1].id : null;
    chatEmpty.hidden = items.length > 0;
    chatFeed.hidden = items.length === 0;
    chatCount.textContent = items.length;

    if (chatFeed.hidden) { lastChatId = last; return; }
    // 새 메시지가 붙었거나 보고 있던 위치가 맨 아래 근처면 자동으로 맨 아래로
    if (last !== lastChatId || nearBottom) chatFeed.scrollTop = chatFeed.scrollHeight;
    lastChatId = last;
  }

  $('#formChat').addEventListener('submit', function (e) {
    e.preventDefault();
    var input = $('#chatText');
    var text = input.value.trim();
    if (!text) { input.focus(); return; }
    addLine('나', text, 'note');
    input.value = '';
    save();
    renderChat();
    input.focus();
  });

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
    var last = state.pickles[state.pickles.length - 1];
    speak(last.id, '안녕하세요! 잘 부탁드려요', 3200);
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

    function chip(stateName, text) {
      var chipEl = $('#syncChip');
      if (!chipEl) return;
      chipEl.dataset.state = stateName;
      $('#syncChipText').textContent = text;
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
      chip('online', '실시간 동기화');
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
            chip('online', '동기화 중(폴링)');
          } else {
            push(true);
          }
        } catch (e) {
          chip('error', '동기화 오류');
        }
      }, 5000);
    }

    function push(force) {
      if (!cfg.url || !cfg.room || !cfg.key) return;
      if (!force && Date.now() < suppressUntil) return;
      if (pushTimer) clearTimeout(pushTimer);
      pushTimer = setTimeout(function () {
        fetch(endpoint(), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(state)
        }).then(function (r) {
          if (!r.ok) chip('error', '저장 실패 (' + r.status + ')');
        }).catch(function () {
          chip('error', '저장 실패');
        });
      }, 350);
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
      push: push
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
    var r = $('#lockRoom');
    if (r && !r.value && INVITE.room) r.value = INVITE.room;
  }

  function showApp() {
    ENTERED = true;
    document.body.classList.remove('is-locked');
    if (lockScreen) lockScreen.hidden = true;
    if (appRoot) appRoot.hidden = false;
    setLockStatus('', null);
    renderRoomChip();
    renderAll();
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
    INVITE.room = room;
    INVITE.key = key;
    state = loadState();
    setLockStatus('입장 확인 중…', null);

    Sync.enter(room, key, function (code) {
      if (code) {
        INVITE.room = prev.room;
        INVITE.key = prev.key;
        if (fromUrl) history.replaceState({}, '', window.location.pathname);
        showLock(statusMessage(code), 'error');
        return;
      }
      if (!fromUrl) history.replaceState({}, '', inviteUrl(room, key));
      var k = $('#lockKey');
      if (k) k.value = '';
      showApp();
      if (state.pickles[0]) speak(state.pickles[0].id, '어서 오세요! 회의실입니다', 3600);
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

  function renderRoomChip() {
    var box = $('#roomChip');
    if (!box) return;
    box.dataset.kind = 'private';
    $('#roomChipLabel').textContent = '초대 전용';
    $('#roomChipName').textContent = INVITE.room || '—';
    box.title = '대장님의 초대 링크로만 들어올 수 있는 회의실 · ' + (INVITE.room || '');
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

  $('#btnCopyRoom').addEventListener('click', function () {
    var url = shareUrl();
    var btn = $('#btnCopyRoom');
    var label = $('#btnCopyRoomText');
    var done = function (ok) {
      label.textContent = ok ? '복사됨' : '복사 실패';
      btn.classList.toggle('is-done', ok);
      setTimeout(function () {
        label.textContent = '복사';
        btn.classList.remove('is-done');
      }, 1800);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function () { done(true); }, function () { done(legacyCopy(url)); });
    } else {
      done(legacyCopy(url));
    }
  });

  /* ------------------------------ 렌더 ------------------------------ */

  function renderAll() {
    syncChars();
    renderAttend();
    renderOwnerSelect();
    renderItems();
    renderChat();
  }

  renderAll();
  startChatter();

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
})();
