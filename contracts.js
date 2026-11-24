/* MANHUNT // PROTOCOL - real GPS verification for runner contracts.
 * Patches the original game at runtime (index.html stays untouched).
 * Rules: no manual claim button; every contract completes only when live GPS proves it.
 */
(function () {
  'use strict';

  var MAX_FOOT_SPEED = 7.5;   // m/s - faster than this is a vehicle or a GPS jump
  var MIN_STEP_M = 10;        // ignore GPS jitter below this
  var EDGE_RING_M = 250;      // edge runner must stay in the outer ring

  function card(id) { return CHALLENGE_DECK.find(function (c) { return c.id === id; }); }
  function inMP() { return window.__mp && window.__mp.active; }
  function isMine(p) { return !inMP() || p.id === window.__mp.myId; }
  function fmt(s) { return formatMMSS(s || 0); }

  /* ---- 1. Re-define cards that were plain timers or had loose rules ---- */
  var den = card('lions_den');
  if (den) {
    den.type = 'den_hold';
    den.desc = 'Get within 100m of a Chaser, then stay inside their 250m Caution radar for 3 full minutes (180s) without being tagged. Leaving the radar resets the clock.';
  }
  var lookout = card('overpass_lookout');
  if (lookout) {              // reuse the built-in strict-stationary logic (timer resets on drift)
    lookout.type = 'stationary_strict';
    lookout.maxDriftMeters = 50;
    lookout.desc = 'Hold position within a 50m radius of a major bridge or crossroads for 10 minutes. Drifting beyond 50m resets the clock.';
  }
  var decoy = card('decoy_gambit');
  if (decoy) {
    decoy.type = 'box_hold';
    decoy.desc = 'Stay inside your current Ping Box for 5 minutes. Needs an active Ping Box (wait for a sweep). Leaving the box resets the clock.';
  }
  var edge = card('edge_runner');
  if (edge) {
    edge.desc = 'Cover 800m on foot while staying in the outer 250m ring of the Safe Zone. Stepping out of bounds resets your progress.';
  }
  var sprint = card('sprint_vector');
  if (sprint) {
    sprint.desc = 'Cover 600m on foot (under ~27 km/h). Activating a Transport Wallet ticket resets your progress.';
  }

  /* ---- 2. No manual claim: the button is gone, GPS decides ---- */
  var btn = document.getElementById('completeChallengeBtn');
  if (btn) {
    btn.style.display = 'none';
    var note = document.createElement('div');
    note.className = 'text-[10px] font-mono text-cyan-300 text-center mt-2';
    note.textContent = 'AUTO-VERIFIED BY LIVE GPS - this contract completes by itself.';
    if (btn.parentNode) btn.parentNode.insertBefore(note, btn);
  }
  document.addEventListener('click', function (e) {
    if (e.target.closest && e.target.closest('#completeChallengeBtn')) {
      e.stopImmediatePropagation(); e.preventDefault();
    }
  }, true);

  /* ---- 3. Distance contracts: own the counting (jitter, speed, ring, transit) ---- */
  function countDistance(p, ch) {
    var now = Date.now();
    var cur = { lat: p.lat, lng: p.lng, t: now };
    if (!ch._cp) { ch._cp = cur; return; }

    var riding = p.activeTransit && p.activeTransit.expiresAt > now;
    if (ch.card.id === 'sprint_vector' && riding) { ch.progressM = 0; ch._cp = cur; return; }

    if (ch.card.id === 'edge_runner') {
      var zd = haversineMeters(p.lat, p.lng, gameState.zone.centerLat, gameState.zone.centerLng);
      var R = gameState.zone.currentRadiusM;
      if (zd > R) { ch.progressM = 0; ch._cp = cur; return; }          // out of bounds: reset
      if (zd < R - EDGE_RING_M) { ch._cp = cur; return; }               // inner area: no credit
    }

    var d = haversineMeters(ch._cp.lat, ch._cp.lng, p.lat, p.lng);
    if (d < MIN_STEP_M) return;                                         // jitter
    var dt = (now - ch._cp.t) / 1000;
    if (dt > 0 && d / dt > MAX_FOOT_SPEED) { ch._cp = cur; return; }   // vehicle / jump
    ch.progressM = (ch.progressM || 0) + d;
    ch._cp = cur;
  }

  var origMove = window.movePlayerToCoordinates;
  window.movePlayerToCoordinates = function (player) {
    var ch = player.team === 'RUNNER' && player.activeChallenge;
    var track = ch && ch.card.type === 'distance';
    var before = track ? (ch.progressM || 0) : 0;
    var r = origMove.apply(this, arguments);
    if (track && player.activeChallenge === ch) {
      ch.progressM = before;        // discard the original naive increment
      countDistance(player, ch);
    }
    return r;
  };

  /* ---- 4. Per-second checks for den_hold and box_hold ---- */
  function customTick(p) {
    if (p.team !== 'RUNNER' || p.status !== 'ACTIVE' || !p.activeChallenge) return;
    var ch = p.activeChallenge, t = ch.card.type;

    if (t === 'den_hold') {
      var d = p.nearestChaserDist;
      if (d == null || !isFinite(d)) { ch.proxHoldSec = 0; ch.denEntered = false; return; }
      if (d <= gameState.radar.dangerM) ch.denEntered = true;
      if (ch.denEntered && d <= gameState.radar.cautionM) {
        ch.proxHoldSec = (ch.proxHoldSec || 0) + 1;
        if (ch.proxHoldSec >= ch.card.durationSec) completeActiveChallenge(p);
      } else {
        ch.proxHoldSec = 0; ch.denEntered = false;
      }
    } else if (t === 'box_hold') {
      var box = gameState.activePingBoxes.find(function (b) { return b.runnerId === p.id && !b.isDecoy; });
      var inside = box && p.lat >= box.bounds[0][0] && p.lat <= box.bounds[1][0] &&
                   p.lng >= box.bounds[0][1] && p.lng <= box.bounds[1][1];
      ch.hasBox = !!box;
      if (inside) {
        ch.boxHoldSec = (ch.boxHoldSec || 0) + 1;
        if (ch.boxHoldSec >= ch.card.durationSec) completeActiveChallenge(p);
      } else {
        ch.boxHoldSec = 0;
      }
    }
  }

  var origTick = window.runGameTick;
  window.runGameTick = function () {
    var r = origTick.apply(this, arguments);
    try {
      gameState.players.forEach(function (p) { if (isMine(p)) customTick(p); });
    } catch (e) { console.error('contract tick', e); }
    return r;
  };

  /* ---- 5. Double Ping Statue must be consecutive ---- */
  var origPing = window.triggerGlobalPingSweep;
  window.triggerGlobalPingSweep = function () {
    try {
      gameState.players.forEach(function (p) {
        var ch = p.activeChallenge;
        if (p.team === 'RUNNER' && ch && ch.card.id === 'double_ping_statue') {
          var drift = haversineMeters(ch.startLat, ch.startLng, p.lat, p.lng);
          if (drift > ch.card.maxDriftMeters) ch.pingsSurvived = 0;
        }
      });
    } catch (e) {}
    return origPing.apply(this, arguments);
  };

  /* ---- 6. Progress display for the custom contract types ---- */
  var origRender = window.renderRunnerChallengesTab;
  window.renderRunnerChallengesTab = function (runner) {
    var r = origRender.apply(this, arguments);
    var ch = runner && runner.activeChallenge;
    if (ch && (ch.card.type === 'den_hold' || ch.card.type === 'box_hold')) {
      var den = ch.card.type === 'den_hold';
      var cur = den ? (ch.proxHoldSec || 0) : (ch.boxHoldSec || 0);
      var pct = Math.min(100, Math.round(cur / ch.card.durationSec * 100));
      var sub;
      if (den) sub = ch.denEntered ? 'Inside Caution radar: ' + fmt(cur) + ' / ' + fmt(ch.card.durationSec)
                                   : 'Get within 100m of a Chaser to start the clock.';
      else sub = ch.hasBox ? 'Inside Ping Box: ' + fmt(cur) + ' / ' + fmt(ch.card.durationSec)
                           : 'No active Ping Box yet - wait for the next sweep.';
      var v = document.getElementById('activeCardProgressValue');
      var b = document.getElementById('activeCardProgressBar');
      var s = document.getElementById('activeCardSubTelemetry');
      if (v) v.textContent = pct + '%';
      if (b) b.style.width = pct + '%';
      if (s) s.textContent = sub;
    }
    return r;
  };
})();
