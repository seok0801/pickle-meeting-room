/* 피클 합동 회의실 — app.js
   단일 페이지 앱: 오피스 맵(SVG + 캐릭터), 출석 보드, 안건/할 일, 타임라인.
   저장: localStorage → (선택) Firebase Realtime Database 실시간 동기화. */
(function () {
  'use strict';

  var KEY = 'pickle-meeting-room/v1';
  var CFG_KEY = 'pickle-meeting-room/sync';
  var MAX_TL = 60;

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
    { x: 68.9, y: 52.5, zone: '작업실' },
    { x: 84.4, y: 52.5, zone: '작업실' },
    { x: 61.0, y: 22.0, zone: '작업실' },
    { x: 15.6, y: 81.5, zone: '라운지' },
    { x: 22.2, y: 81.5, zone: '라운지' },
    { x: 49.4, y: 82.7, zone: '라운지' },
    { x: 71.0, y: 81.5, zone: '라운지' }
  ];

  var STATUS_LABEL = { online: '온라인', working: '작업중', away: '대기' };
  var STATUS_ORDER = ['online', 'working', 'away'];

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

  function defaultState() {
    var now = Date.now();
    return {
      version: 1,
      updatedAt: now,
      pickles: [
        { id: 'p-jubot', name: '주봇', role: '회의 진행', color: 0, status: 'online' },
        { id: 'p-guest', name: '게스트 피클', role: '방문 피클', color: 2, status: 'online' },
        { id: 'p-mint', name: '민트', role: '기록 담당', color: 1, status: 'working' },
        { id: 'p-lilac', name: '라일락', role: '자료 조사', color: 3, status: 'working' },
        { id: 'p-coral', name: '코랄', role: '라운지 담당', color: 4, status: 'away' }
      ],
      items: [
        { id: 'i-1', title: '오늘의 안건: 주말 나들이', type: 'agenda', done: false, owner: '주봇', ts: now - 3600e3 },
        { id: 'i-2', title: '오늘의 안건: 장보기 리스트', type: 'agenda', done: false, owner: '게스트 피클', ts: now - 3400e3 },
        { id: 'i-3', title: '회의실 화이트보드 정리', type: 'todo', done: false, owner: '민트', ts: now - 3000e3 },
        { id: 'i-4', title: '라운지 간식 채워 두기', type: 'todo', done: true, owner: '코랄', ts: now - 2600e3 }
      ],
      timeline: [
        { id: 't-1', who: '주봇', text: '오늘 회의 시작합니다. 안건 두 개 먼저 볼게요.', ts: now - 2400e3, kind: 'pickle' },
        { id: 't-2', who: '게스트 피클', text: '주말 나들이는 토요일 오전이 좋을 것 같아요.', ts: now - 1800e3, kind: 'pickle' },
        { id: 't-3', who: '나', text: '장보기 리스트는 내가 정리해 둘게.', ts: now - 900e3, kind: 'note' }
      ]
    };
  }

  var state = loadState();

  function loadState() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return defaultState();
      var s = JSON.parse(raw);
      return normalize(s) || defaultState();
    } catch (e) {
      return defaultState();
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
    state.updatedAt = Date.now();
    trimTimeline();
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* 용량 초과 등 */ }
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
        var seat = pickSeat(i < 6 ? '회의실' : (i < 9 ? '작업실' : '라운지'), p.id);
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
        renderTimeline();
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
    renderTimeline();
  });

  /* ------------------------------ 타임라인 ------------------------------ */

  var timelineEl = $('#timeline');

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

  // 이벤트에 대한 피클의 짧은 반응 (타임라인 + 말풍선)
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
    renderTimeline();
  }

  function renderTimeline() {
    timelineEl.textContent = '';
    var items = state.timeline.slice().sort(function (a, b) { return a.ts - b.ts; });
    items.forEach(function (m) {
      var li = el('li', 'tl-item ' + (m.kind === 'note' ? 'is-note' : ''));
      var av = el('span', 'tl-av');
      var p = pickleNameById(m.who);
      if (p) {
        av.innerHTML = pickleSvg(colorOf(p), false);
      } else {
        av.innerHTML = '<svg viewBox="0 0 100 104" aria-hidden="true">' +
          '<rect x="18" y="30" width="64" height="60" rx="26" fill="#EAF0FF" stroke="#2F6BFF" stroke-width="4"/>' +
          '<ellipse cx="38" cy="60" rx="5" ry="6.5" fill="#2A2418"/>' +
          '<ellipse cx="62" cy="60" rx="5" ry="6.5" fill="#2A2418"/>' +
          '<path d="M43 76 q7 6 14 0" stroke="#2A2418" stroke-width="3" fill="none" stroke-linecap="round"/>' +
          '</svg>';
      }
      var main = el('div', 'tl-main');
      var head = el('div', 'tl-head');
      head.appendChild(el('span', 'tl-who', m.who));
      head.appendChild(el('span', 'tl-time', fmtTime(m.ts)));
      var txt = el('p', 'tl-text', m.text);
      main.appendChild(head);
      main.appendChild(txt);
      li.appendChild(av);
      li.appendChild(main);
      timelineEl.appendChild(li);
    });
    timelineEl.scrollTop = timelineEl.scrollHeight;
  }

  $('#formNote').addEventListener('submit', function (e) {
    e.preventDefault();
    var input = $('#noteText');
    var text = input.value.trim();
    if (!text) return;
    addLine('나', text, 'note');
    input.value = '';
    save();
    renderTimeline();
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
    renderTimeline();
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
    var cfg = { url: '', room: 'pickle-room' };
    var ctrl = null;
    var pollTimer = null;
    var pushTimer = null;
    var suppressUntil = 0;

    function loadCfg() {
      try {
        var raw = localStorage.getItem(CFG_KEY);
        if (!raw) return;
        var c = JSON.parse(raw);
        if (c && typeof c.url === 'string') cfg.url = c.url;
        if (c && typeof c.room === 'string' && c.room) cfg.room = c.room;
      } catch (e) { /* 무시 */ }
    }
    function saveCfg() {
      try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch (e) { /* 무시 */ }
    }

    function normalizeUrl(input) {
      var v = String(input || '').trim();
      if (!v) return '';
      if (!/^https?:\/\//i.test(v)) {
        if (v.indexOf('.') === -1) v = v + '-default-rtdb.firebaseio.com';
        v = 'https://' + v;
      }
      return v.replace(/\/+$/, '');
    }

    function endpoint() {
      if (!cfg.url) return '';
      return cfg.url + '/rooms/' + encodeURIComponent(cfg.room) + '.json';
    }

    function chip(stateName, text) {
      var chipEl = $('#syncChip');
      chipEl.dataset.state = stateName;
      $('#syncChipText').textContent = text;
    }

    function stop() {
      if (ctrl) { try { ctrl.abort(); } catch (e) {} ctrl = null; }
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }

    function applyRemote(remote, force) {
      var s = normalize(remote);
      if (!s) return;
      if (!force && s.updatedAt > 0 && s.updatedAt <= state.updatedAt) return;
      state = s;
      suppressUntil = Date.now() + 1500;
      try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
      renderAll();
    }

    // 연결 직후 1회: 방에 이미 데이터가 있으면 그것을 받아들이고, 비어 있으면 올린다.
    async function adoptInitial() {
      try {
        var r = await fetch(endpoint(), { cache: 'no-store' });
        if (!r.ok) {
          chip('error', '연결 실패 (' + r.status + ')');
          setSyncStatus('연결 실패: HTTP ' + r.status + ' — 데이터베이스 규칙에서 읽기/쓰기를 허용했는지 확인해 주세요.', 'error');
          return false;
        }
        var data = await r.json();
        if (data) { applyRemote(data, true); }
        else { push(true); }
        return true;
      } catch (e) {
        chip('error', '연결 실패');
        setSyncStatus('연결할 수 없어요. 주소와 네트워크를 확인해 주세요.', 'error');
        return false;
      }
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
      var ok = await adoptInitial();
      if (!ok) return;
      var res;
      try {
        res = await fetch(url, {
          headers: { Accept: 'text/event-stream' },
          cache: 'no-store',
          signal: ctrl.signal
        });
      } catch (e) {
        chip('error', '연결 실패');
        setSyncStatus('연결할 수 없어요. 주소를 확인해 주세요.', 'error');
        return;
      }
      if (!res.ok) {
        var msg = 'HTTP ' + res.status;
        chip('error', '연결 실패 (' + res.status + ')');
        setSyncStatus('연결 실패: ' + msg + ' — 데이터베이스 규칙에서 읽기/쓰기를 허용했는지 확인해 주세요.', 'error');
        startPolling(true);
        return;
      }
      if (!res.body) { startPolling(false); return; }
      chip('online', '실시간 연결됨');
      setSyncStatus('실시간 연결됨 · 회의실 “' + cfg.room + '”', 'ok');
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
      startPolling(false);
    }

    function startPolling(quiet) {
      if (pollTimer || !cfg.url) return;
      if (!quiet) chip('connecting', '동기화 중(폴링)');
      pollTimer = setInterval(async function () {
        try {
          var r = await fetch(endpoint(), { cache: 'no-store' });
          if (!r.ok) { chip('error', '동기화 오류 (' + r.status + ')'); return; }
          var data = await r.json();
          if (data) {
            applyRemote(data);
            if (!quiet) chip('online', '동기화 중(폴링)');
          } else {
            push(true);
          }
        } catch (e) {
          chip('error', '동기화 오류');
        }
      }, 5000);
    }

    function start() {
      stop();
      if (!cfg.url) { chip('local', '로컬 저장'); return; }
      connectStream();
    }

    function push(force) {
      if (!cfg.url) return;
      if (!force && Date.now() < suppressUntil) return;
      if (pushTimer) clearTimeout(pushTimer);
      pushTimer = setTimeout(function () {
        fetch(endpoint(), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(state)
        }).then(function (r) {
          if (!r.ok) setSyncStatus('저장 실패 (HTTP ' + r.status + ') — 쓰기 권한을 확인해 주세요.', 'error');
        }).catch(function () {
          setSyncStatus('저장 실패 — 네트워크를 확인해 주세요.', 'error');
        });
      }, 350);
    }

    return {
      init: function () {
        loadCfg();
        $('#syncUrl').value = cfg.url;
        $('#syncRoom').value = cfg.room;
        if (cfg.url) {
          chip('connecting', '연결 중…');
          start();
        } else {
          chip('local', '로컬 저장');
        }
      },
      apply: function (url, room) {
        cfg.url = normalizeUrl(url);
        cfg.room = (room || 'pickle-room').replace(/[^\w\-가-힣]/g, '').slice(0, 40) || 'pickle-room';
        saveCfg();
        $('#syncUrl').value = cfg.url;
        $('#syncRoom').value = cfg.room;
        if (!cfg.url) { stop(); chip('local', '로컬 저장'); setSyncStatus('로컬 저장으로 돌아왔어요.', 'ok'); return; }
        start();
      },
      disconnect: function () {
        cfg.url = '';
        saveCfg();
        stop();
        chip('local', '로컬 저장');
        $('#syncUrl').value = '';
        setSyncStatus('연결을 해제했어요. 이 브라우저에만 저장됩니다.', 'ok');
      },
      push: push
    };
  })();

  function setSyncStatus(text, kind) {
    var n = $('#syncStatus');
    n.textContent = text || '';
    if (kind) n.dataset.kind = kind;
    else n.removeAttribute('data-kind');
  }

  /* ------------------------------ 동기화 UI ------------------------------ */

  var dlg = $('#dlgSync');

  $('#btnSync').addEventListener('click', function () {
    setSyncStatus('');
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
  });

  $('#formSync').addEventListener('submit', function (e) {
    e.preventDefault();
    Sync.apply($('#syncUrl').value, $('#syncRoom').value);
    if (!$('#syncUrl').value.trim()) return;
    setTimeout(function () {
      if ($('#syncStatus').dataset.kind !== 'error') dlg.close();
    }, 200);
  });

  $('#btnSyncOff').addEventListener('click', function () { Sync.disconnect(); });

  dlg.addEventListener('click', function (e) {
    if (e.target === dlg) dlg.close();
  });

  /* ------------------------------ 렌더 ------------------------------ */

  function renderAll() {
    syncChars();
    renderAttend();
    renderOwnerSelect();
    renderItems();
    renderTimeline();
  }

  renderAll();
  Sync.init();
  startChatter();

  // 첫 방문 안내 말풍선
  setTimeout(function () {
    if (state.pickles[0]) speak(state.pickles[0].id, '어서 오세요! 회의실입니다', 3600);
  }, 700);

  // 다른 탭의 변경 반영
  window.addEventListener('storage', function (e) {
    if (e.key !== KEY || !e.newValue) return;
    var s = normalize(JSON.parse(e.newValue));
    if (s) { state = s; renderAll(); }
  });
})();
