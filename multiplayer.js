/* MANHUNT // PROTOCOL - multiplayer layer (Supabase Realtime).
 * Injected into index.html at runtime by play.html. Model:
 *  - Each phone owns its own player row (position, coins, tickets...).
 *  - The host owns shared match state (zone, pings, timers) and generates pings.
 *  - Cross-player effects (catch, freeze) push the affected rows; owners accept a
 *    whitelist of fields from other writers.
 */
(function () {
  'use strict';

  var SB_URL = 'https://egwtbemyfbqnfzajdhof.supabase.co';
  var SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVnd3RiZW15ZmJxbmZ6YWpkaG9mIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTU0NzA2NTcsImV4cCI6MjExMTA0NjY1N30.VXsxitgUtBqxI8bc2hZF24KqgXsYR_lKHIDJdplx_6I';
  var SESSION_KEY = 'MANHUNT_MP_SESSION';
  var ID_KEY = 'MANHUNT_MP_ID';
  var SHARED_KEYS = ['gameMode', 'headstartSecondsLeft', 'pingIntervalSec', 'nextPingInSec',
    'initialPingSizeM', 'precisionNextPing', 'zone', 'radar', 'economy', 'activePingBoxes',
    'activeTrails', 'eventLog', 'chaserRadarSweepUntil', 'bloodhoundUntil'];
  var OWNER_ACCEPTS = ['status', 'team', 'coins', 'frozenUntil', 'freezeAnchorLat',
    'freezeAnchorLng', 'freezeBreachUntil', 'exposedUntil', 'patrolMeters', 'activeChallenge',
    'challengeCooldownSec', 'ghostNextPing', 'decoyNextPing', 'prevPingCoord'];

  function $(id) { return document.getElementById(id); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function cleanName(s) {
    return String(s || '').toUpperCase().replace(/[^A-Z0-9 _-]/g, '').trim().slice(0, 14) || 'OPERATIVE';
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function randId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'p-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  var myId;
  try { myId = localStorage.getItem(ID_KEY); } catch (e) {}
  if (!myId) { myId = randId(); try { localStorage.setItem(ID_KEY, myId); } catch (e) {} }

  var mp = { active: false, isHost: false, code: null, myId: myId, phase: 'LOBBY',
    channel: null, timer: null, started: false, busy: false, fails: 0, refreshT: null };
  window.__mp = mp;

  var sb = window.supabase ? window.supabase.createClient(SB_URL, SB_KEY) : null;

  // Player templates captured from the built-in demo roster before it is wiped
  var TPL = {
    RUNNER: clone(gameState.players.find(function (p) { return p.team === 'RUNNER'; })),
    CHASER: clone(gameState.players.find(function (p) { return p.team === 'CHASER'; }))
  };

  /* ------------------------------------------------------------ UI */
  var box = document.createElement('div');
  box.id = 'mpOverlay';
  box.className = 'fixed inset-0 z-[3000] bg-slate-950/95 backdrop-blur-md flex items-center justify-center p-3 overflow-y-auto';
  var inp = 'w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white font-bold uppercase focus:outline-none focus:border-emerald-400';
  var btnG = 'w-full py-3 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold';
  var btnS = 'w-full py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-white font-bold';
  box.innerHTML =
    '<div class="bg-tac-panel border-2 border-slate-700 rounded-2xl max-w-md w-full p-5 space-y-4 shadow-2xl font-mono text-xs my-auto">' +
    '<div><span class="text-[10px] uppercase tracking-widest text-emerald-400">LIVE GPS TACTICAL CHASE</span>' +
    '<h2 class="text-xl font-bold text-white">MANHUNT // PROTOCOL</h2></div>' +
    '<div id="mpPaneJoin" class="space-y-3">' +
    '<div><label class="text-[10px] text-slate-400 block mb-1">CALLSIGN</label><input id="mpCallsign" maxlength="14" placeholder="e.g. VORTEX" class="' + inp + '"></div>' +
    '<div><label class="text-[10px] text-slate-400 block mb-1">TEAM</label><select id="mpTeam" class="' + inp + '"><option value="RUNNER">RUNNER (hide and survive)</option><option value="CHASER">CHASER (hunt runners)</option></select></div>' +
    '<button id="mpCreateBtn" class="' + btnG + '">CREATE ROOM (I AM HOST)</button>' +
    '<div class="flex gap-2"><input id="mpCode" maxlength="4" placeholder="ROOM CODE" class="' + inp + ' flex-1 text-center tracking-widest"><button id="mpJoinBtn" class="px-5 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold">JOIN</button></div>' +
    '<div id="mpError" class="text-rose-400 min-h-[1rem]"></div>' +
    '<button id="mpDemoBtn" class="w-full text-slate-500 hover:text-slate-300 underline">Offline demo (no multiplayer)</button>' +
    '</div>' +
    '<div id="mpPaneLobby" class="hidden space-y-3">' +
    '<div class="bg-slate-950 border border-slate-800 rounded-xl p-3 text-center"><div class="text-[10px] text-slate-400">ROOM CODE - SHARE WITH FRIENDS</div><div id="mpRoomCode" class="text-3xl font-extrabold text-amber-400 tracking-[0.3em]"></div><div id="mpPhaseLabel" class="text-[10px] text-slate-400 mt-1"></div></div>' +
    '<div class="grid grid-cols-2 gap-2"><button id="mpTeamRunner" class="' + btnS + '">I\'M A RUNNER</button><button id="mpTeamChaser" class="' + btnS + '">I\'M A CHASER</button></div>' +
    '<div id="mpRoster" class="space-y-1.5 max-h-48 overflow-y-auto"></div>' +
    '<div id="mpHostBtns" class="hidden space-y-2"><button id="mpHostCfgBtn" class="' + btnS + '">GAME SETTINGS</button><button id="mpStartBtn" class="' + btnG + '">START MATCH</button></div>' +
    '<div id="mpGuestNote" class="hidden text-center text-slate-400">Waiting for the host to start the match...</div>' +
    '<button id="mpCloseBtn" class="' + btnS + '">BACK TO MAP</button>' +
    '<button id="mpLeaveBtn" class="w-full text-rose-400 hover:text-rose-300 underline"></button>' +
    '</div></div>';
  document.body.appendChild(box);

  function setErr(m) { $('mpError').textContent = m || ''; }
  function showOverlay(pane) {
    box.classList.remove('hidden');
    $('mpPaneJoin').classList.toggle('hidden', pane !== 'join');
    $('mpPaneLobby').classList.toggle('hidden', pane !== 'lobby');
    if (pane === 'lobby') renderLobby();
  }
  function hideOverlay() { box.classList.add('hidden'); }

  function renderLobby() {
    if (!mp.active) return;
    $('mpRoomCode').textContent = mp.code;
    $('mpPhaseLabel').textContent = mp.phase === 'LOBBY' ? 'LOBBY - not started' : 'MATCH IN PROGRESS';
    $('mpRoster').innerHTML = gameState.players.map(function (p) {
      var me = p.id === mp.myId;
      var tc = p.team === 'RUNNER' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-rose-500/20 text-rose-300';
      return '<div class="flex items-center justify-between bg-slate-950 border ' + (me ? 'border-amber-400' : 'border-slate-800') + ' rounded-xl px-3 py-2">' +
        '<span class="font-bold text-white">' + esc(p.callsign) + (me ? ' (you)' : '') + '</span>' +
        '<span class="px-1.5 py-0.5 rounded text-[10px] font-bold ' + tc + '">' + esc(p.team) + (p.status === 'CAUGHT' ? ' - CAUGHT' : '') + '</span></div>';
    }).join('');
    $('mpHostBtns').classList.toggle('hidden', !(mp.isHost && mp.phase === 'LOBBY'));
    $('mpGuestNote').classList.toggle('hidden', mp.isHost || mp.phase !== 'LOBBY');
    $('mpLeaveBtn').textContent = mp.isHost ? 'END ROOM FOR EVERYONE' : 'LEAVE ROOM';
  }

  function refresh() {
    if (mp.refreshT) return;
    mp.refreshT = setTimeout(function () {
      mp.refreshT = null;
      try { populateFreezeDropdowns(); } catch (e) {}
      try { syncMapLayers(); } catch (e) {}
      try { updateAllHUD(); } catch (e) {}
      renderLobby();
    }, 350);
  }

  /* ------------------------------------------------------ player data */
  function freshPlayer(callsign, team, prev) {
    var p = clone(TPL[team]);
    var pos = prev ? { lat: prev.lat, lng: prev.lng } : { lat: gameState.zone.centerLat, lng: gameState.zone.centerLng };
    Object.assign(p, { id: mp.myId, callsign: callsign, team: team, status: 'ACTIVE', lat: pos.lat, lng: pos.lng,
      coins: prev ? prev.coins : 150, frozenUntil: 0, freezeAnchorLat: 0, freezeAnchorLng: 0, freezeBreachUntil: 0,
      exposedUntil: 0, ghostNextPing: false, decoyNextPing: false });
    if (team === 'RUNNER') {
      Object.assign(p, { catchCode: String(1000 + Math.floor(Math.random() * 9000)), anchorLat: pos.lat, anchorLng: pos.lng,
        stationarySeconds: 0, outOfBoundsGraceSec: 60, prevPingCoord: { lat: pos.lat, lng: pos.lng },
        tickets: { bus: 1, tram: 1, train: 1, bike: 1, ferry: 1 }, activeTransit: null, challengeCooldownSec: 0, activeChallenge: null });
    }
    return p;
  }

  function me() { return gameState.players.find(function (p) { return p.id === mp.myId; }); }
  function sharedState() { var s = {}; SHARED_KEYS.forEach(function (k) { s[k] = gameState[k]; }); return clone(s); }
  function applyShared(s) {
    if (!s) return;
    SHARED_KEYS.forEach(function (k) { if (s[k] !== undefined) gameState[k] = clone(s[k]); });
  }

  function playerRow(p, chg) {
    var d = clone(p); d._by = mp.myId;
    if (chg) d._chg = chg;
    return { id: p.id, room_code: mp.code, callsign: cleanName(p.callsign), team: p.team, data: d };
  }

  async function pushPlayers(list, chgMap) {
    if (!sb || !mp.active || !list.length) return;
    var r = await sb.from('players').upsert(list.map(function (p) { return playerRow(p, chgMap && chgMap[p.id]); }));
    noteResult(r.error);
  }
  async function pushRoom() {
    if (!sb || !mp.active || !mp.isHost) return;
    var r = await sb.from('rooms').update({ state: sharedState(), phase: mp.phase }).eq('code', mp.code);
    noteResult(r.error);
  }
  function noteResult(err) {
    if (err) {
      mp.fails++;
      if (mp.fails === 3) showGlobalBanner('Connection trouble - retrying...', 'amber');
    } else {
      if (mp.fails >= 3) showGlobalBanner('Reconnected.', 'emerald');
      mp.fails = 0;
    }
  }
  // Run fn, then push only the players (and fields) it changed. Owners accept only those fields.
  function diffPush(fn, self, args) {
    var before = {};
    gameState.players.forEach(function (p) {
      var o = {}; Object.keys(p).forEach(function (k) { o[k] = JSON.stringify(p[k]); }); before[p.id] = o;
    });
    var r = fn.apply(self, args);
    if (mp.active) {
      var rows = [], chgMap = {};
      gameState.players.forEach(function (p) {
        var b = before[p.id] || {};
        var chg = Object.keys(p).filter(function (k) { return b[k] !== JSON.stringify(p[k]); });
        if (chg.length) { rows.push(p); chgMap[p.id] = chg; }
      });
      if (rows.length) pushPlayers(rows, chgMap);
    }
    return r;
  }

  /* ---------------------------------------------------- incoming data */
  function applyPlayerRow(row) {
    var d = row.data || {};
    var p = Object.assign({}, d, { id: row.id, callsign: cleanName(row.callsign), team: row.team });
    var chg = d._chg || [];
    delete p._by; delete p._chg;
    if (row.id === mp.myId) {
      var mine = me();
      if (mine && d._by && d._by !== mp.myId) {
        OWNER_ACCEPTS.forEach(function (k) { if (chg.indexOf(k) >= 0 && p[k] !== undefined) mine[k] = p[k]; });
      }
      return;
    }
    var i = gameState.players.findIndex(function (x) { return x.id === row.id; });
    if (i >= 0) gameState.players[i] = p; else gameState.players.push(p);
  }

  function applyRoomRow(row, first) {
    var prev = mp.phase;
    mp.phase = row.phase;
    if (!mp.isHost || first) applyShared(row.state);
    if (row.phase === 'ACTIVE' && prev !== 'ACTIVE' && !first) {
      showGlobalBanner('MATCH STARTED! Headstart clock is running.', 'emerald');
      try { playTacticalSound('alert'); } catch (e) {}
      hideOverlay();
    }
    mp.started = row.phase === 'ACTIVE';
  }

  async function resync() {
    if (!sb || !mp.active) return;
    var res = await Promise.all([
      sb.from('rooms').select('*').eq('code', mp.code).maybeSingle(),
      sb.from('players').select('*').eq('room_code', mp.code)
    ]);
    if (res[0].data) applyRoomRow(res[0].data, false);
    if (res[1].data) {
      var ids = {};
      res[1].data.forEach(function (r) { ids[r.id] = 1; applyPlayerRow(r); });
      gameState.players = gameState.players.filter(function (p) { return p.id === mp.myId || ids[p.id]; });
    }
    refresh();
  }

  function subscribe() {
    mp.channel = sb.channel('room-' + mp.code, { config: { broadcast: { self: false } } })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'players', filter: 'room_code=eq.' + mp.code }, function (pl) {
        if (pl.eventType === 'DELETE') {
          var id = pl.old && pl.old.id;
          if (id && id !== mp.myId) gameState.players = gameState.players.filter(function (p) { return p.id !== id; });
        } else if (pl.new) applyPlayerRow(pl.new);
        refresh();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rooms', filter: 'code=eq.' + mp.code }, function (pl) {
        if (pl.eventType === 'DELETE') { alert('The host ended this room.'); clearSession(); location.reload(); return; }
        if (pl.new) applyRoomRow(pl.new, false);
        refresh();
      })
      .on('broadcast', { event: 'ping_request' }, function () { if (mp.isHost) hostSweep(true); })
      .on('broadcast', { event: 'alert' }, function (m) { try { handleIncomingOpposingAlert(m.payload.fromTeam); } catch (e) {} })
      .on('broadcast', { event: 'banner' }, function (m) {
        var t = String(m.payload.msg || '').slice(0, 160);
        showGlobalBanner(t, 'emerald'); addEventLog(t);
        try { playTacticalSound('alert'); } catch (e) {}
      })
      .subscribe();
  }
  function broadcast(event, payload) {
    if (mp.channel) { try { mp.channel.send({ type: 'broadcast', event: event, payload: payload }); } catch (e) {} }
  }

  /* ------------------------------------------------------- lifecycle */
  function saveSession(callsign, team) {
    try { localStorage.setItem(SESSION_KEY, JSON.stringify({ code: mp.code, callsign: callsign, team: team })); } catch (e) {}
  }
  function clearSession() { try { localStorage.removeItem(SESSION_KEY); } catch (e) {} }

  async function enterRoom(code, callsign, team, create) {
    if (!sb) throw new Error('Could not load the Supabase library. Check your connection.');
    callsign = cleanName(callsign);
    var room = null, tries = 0;

    if (create) {
      while (!room && tries++ < 6) {
        var c = Math.random().toString(36).replace(/[^a-z0-9]/g, '').slice(0, 4).toUpperCase();
        if (c.length < 4) continue;
        var ins = await sb.from('rooms').insert({ code: c, host_id: mp.myId, phase: 'LOBBY', state: sharedState() }).select().single();
        if (!ins.error) room = ins.data;
      }
      if (!room) throw new Error('Could not create a room. Try again.');
    } else {
      var got = await sb.from('rooms').select('*').eq('code', code).maybeSingle();
      if (got.error) throw got.error;
      if (!got.data) throw new Error('Room "' + code + '" not found.');
      room = got.data;
    }

    mp.code = room.code;
    mp.isHost = room.host_id === mp.myId;
    mp.phase = room.phase;
    mp.active = true;

    // Replace the demo roster with real players
    window.loadStateFromStorage = function () {};
    window.saveStateToStorage = function () {};
    gameState.players = []; gameState.activePingBoxes = []; gameState.activeTrails = []; gameState.eventLog = [];
    gameState.chaserRadarSweepUntil = 0; gameState.bloodhoundUntil = 0;
    gameState.roomCode = mp.code; gameState.clickMapToTeleport = false;
    gameState.activePlayerId = mp.myId;
    applyRoomRow(room, true);

    var existing = await sb.from('players').select('*').eq('room_code', mp.code);
    var mine = null;
    (existing.data || []).forEach(function (r) {
      if (r.id === mp.myId) { mine = Object.assign({}, r.data, { id: r.id, callsign: cleanName(r.callsign), team: r.team }); delete mine._by; delete mine._chg; }
      else applyPlayerRow(r);
    });
    gameState.players.push(mine || freshPlayer(callsign, team));
    await pushPlayers([me()]);

    saveSession(callsign, me().team);
    var tb = $('toggleClickTeleportBtn'); if (tb) tb.style.display = 'none';
    var dd = $('toggleDevDrawerBtn'); if (dd) dd.style.display = 'none';
    subscribe();
    mp.timer = setInterval(heartbeat, 2000);
    if (!gameState.hardwareGpsEnabled) toggleHardwareGps();
    try { if (map) map.setView([gameState.zone.centerLat, gameState.zone.centerLng], 14); } catch (e) {}
    refresh();
    showGlobalBanner('Joined room ' + mp.code + ' as ' + me().callsign, 'emerald');
    if (mp.phase === 'ACTIVE') hideOverlay(); else showOverlay('lobby');
  }

  async function heartbeat() {
    if (!mp.active || mp.busy) return;
    mp.busy = true;
    try { await pushPlayers([me()]); if (mp.isHost) await pushRoom(); } catch (e) { noteResult(e); }
    mp.busy = false;
  }

  async function startMatch() {
    if (!mp.isHost || mp.phase !== 'LOBBY') return;
    var m = me();
    gameState.zone.centerLat = m.lat; gameState.zone.centerLng = m.lng;
    applyHostConfiguration();
    mp.phase = 'ACTIVE'; mp.started = true;
    await pushRoom();
    hideOverlay();
    showGlobalBanner('MATCH STARTED! Headstart clock is running.', 'emerald');
    refresh();
  }

  async function setTeam(team) {
    var m = me();
    if (!m || m.team === team) return;
    if (mp.phase !== 'LOBBY') { setErr(''); showGlobalBanner('Teams are locked once the match starts.', 'amber'); return; }
    var i = gameState.players.indexOf(m);
    gameState.players[i] = freshPlayer(m.callsign, team, m);
    saveSession(m.callsign, team);
    await pushPlayers([me()]);
    refresh();
  }

  async function leaveRoom() {
    if (!mp.active) return;
    if (!confirm(mp.isHost ? 'End the room for everyone?' : 'Leave this room?')) return;
    try {
      if (mp.isHost) await sb.from('rooms').delete().eq('code', mp.code);
      else await sb.from('players').delete().eq('id', mp.myId);
    } catch (e) {}
    clearSession(); location.reload();
  }

  /* ------------------------------------------- patch original game logic */
  var origPing = window.triggerGlobalPingSweep;
  function hostSweep(manual) {
    mp.foreignOk = true;   // the sweep may legitimately complete other runners' Double Ping contracts
    try { return diffPush(origPing, null, [manual]); } finally { mp.foreignOk = false; }
  }
  window.triggerGlobalPingSweep = function (manual) {
    if (mp.active && !mp.isHost) {
      if (manual) broadcast('ping_request', {});
      else gameState.nextPingInSec = gameState.pingIntervalSec;
      return;
    }
    if (mp.active) return hostSweep(manual);
    return origPing.apply(this, arguments);
  };

  // Each phone completes only its own contracts (the host sweep is the one exception)
  var origComplete = window.completeActiveChallenge;
  window.completeActiveChallenge = function (runner) {
    if (mp.active && runner && runner.id !== mp.myId && !mp.foreignOk) return;
    return origComplete.apply(this, arguments);
  };

  var origTick = window.runGameTick;
  window.runGameTick = function () {
    if (mp.active && mp.phase === 'LOBBY') return;
    return origTick.apply(this, arguments);
  };

  var origCatch = window.executeRunnerCatch;
  window.executeRunnerCatch = function (runner, chaser) {
    var r = diffPush(origCatch, this, arguments);
    if (mp.active && runner && chaser) {
      broadcast('banner', { msg: 'TAG CONFIRMED! ' + chaser.callsign + ' caught ' + runner.callsign + '!' });
    }
    return r;
  };

  ['buyRunnerPowerup', 'buyChaserPowerup', 'triggerProximityTag'].forEach(function (n) {
    var o = window[n];
    if (typeof o !== 'function') return;
    window[n] = function () { return diffPush(o, this, arguments); };
  });

  ['switchActiveSimulatedPlayer', 'togglePlayerTeam', 'addSimulatedBot', 'toggleDevDrawer'].forEach(function (n) {
    var o = window[n];
    if (typeof o !== 'function') return;
    window[n] = function () { if (mp.active) return; return o.apply(this, arguments); };
  });

  if (typeof syncChannel !== 'undefined' && syncChannel) {
    var origPost = syncChannel.postMessage.bind(syncChannel);
    syncChannel.postMessage = function (msg) {
      origPost(msg);
      if (mp.active && msg && msg.type === 'POWERUP_ALERT') broadcast('alert', msg);
    };
  }

  // The header lobby button opens the real room panel
  document.addEventListener('click', function (e) {
    if (e.target.closest && e.target.closest('#openLobbyBtn') && mp.active) {
      e.stopImmediatePropagation(); e.preventDefault(); showOverlay('lobby');
    }
  }, true);

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && mp.active) { heartbeat(); resync(); }
  });

  /* ------------------------------------------------------------ wiring */
  function guarded(fn) {
    return async function () {
      setErr('');
      var btns = box.querySelectorAll('button'); btns.forEach(function (b) { b.disabled = true; });
      try { await fn(); } catch (err) { setErr(err && err.message ? err.message : String(err)); mp.active = false; }
      btns.forEach(function (b) { b.disabled = false; });
    };
  }
  function readProfile() {
    var cs = cleanName($('mpCallsign').value);
    if (!$('mpCallsign').value.trim()) throw new Error('Enter a callsign first.');
    return { cs: cs, team: $('mpTeam').value };
  }
  $('mpCreateBtn').addEventListener('click', guarded(async function () {
    var p = readProfile(); await enterRoom(null, p.cs, p.team, true);
  }));
  $('mpJoinBtn').addEventListener('click', guarded(async function () {
    var p = readProfile();
    var code = $('mpCode').value.trim().toUpperCase();
    if (code.length < 4) throw new Error('Enter the 4-character room code.');
    await enterRoom(code, p.cs, p.team, false);
  }));
  $('mpDemoBtn').addEventListener('click', hideOverlay);
  $('mpCloseBtn').addEventListener('click', hideOverlay);
  $('mpLeaveBtn').addEventListener('click', leaveRoom);
  $('mpStartBtn').addEventListener('click', startMatch);
  $('mpTeamRunner').addEventListener('click', function () { setTeam('RUNNER'); });
  $('mpTeamChaser').addEventListener('click', function () { setTeam('CHASER'); });
  $('mpHostCfgBtn').addEventListener('click', function () {
    hideOverlay();
    var m = $('hostSettingsModal'); if (m) m.classList.remove('hidden');
  });

  // Resume after reload / app switch
  try {
    var s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    if (s && s.code) {
      $('mpCallsign').value = s.callsign || ''; $('mpTeam').value = s.team || 'RUNNER';
      enterRoom(s.code, s.callsign, s.team, false).catch(function () { clearSession(); showOverlay('join'); });
    }
  } catch (e) {}
})();
