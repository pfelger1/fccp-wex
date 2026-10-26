/* FCCP WEX Timekeeping - participant app.
 * Rebuilt 2026-10-24 for FCCP's own site. Same screens and the same Google Apps Script backend
 * (WEXCore.gs doPost actions) as the original ChatGPT-hosted app, with these fixes:
 *   1. Shifts from an earlier pay period that FCCP has not finalized are listed under their own
 *      heading instead of under "This Pay Period".
 *   2. A shift that was never clocked out can be edited (Edit appears whenever the backend allows it).
 *   3. A slow status check can no longer overwrite the screen after a punch.
 *   4. Messages from the backend (for example "Missed shift saved...") are shown as sent.
 */
(function () {
  'use strict';

  var API_URL = (window.WEX_CONFIG && window.WEX_CONFIG.API_URL) || '';
  var IS_TEST = !window.WEX_CONFIG || window.WEX_CONFIG.ENVIRONMENT !== 'production';
  var TOKEN_KEY = 'wex-session-token';
  var CODE_KEY = 'wexParticipantCode';
  var BIO = {
    participantCode: 'wexBiometricParticipantCode', deviceId: 'wexBiometricDeviceId',
    credentialId: 'wexBiometricCredentialId', prfSalt: 'wexBiometricPrfSalt',
    tokenCiphertext: 'wexBiometricTokenCiphertext', tokenIv: 'wexBiometricTokenIv',
    expiresAt: 'wexBiometricExpiresAt'
  };
  var SESSION_EXPIRED = 'Your session has expired. Please sign in again.';
  var ADD_REASONS = ['Missed Punch', 'Forgot to Clock In', 'Forgot to Clock Out', 'App / Technical Issue', 'Supervisor Requested Correction', 'Other'];
  var EDIT_REASONS = ['Missed Punch', 'Forgot to Clock In', 'Forgot to Clock Out', 'Incorrect Punch Time', 'Lunch Punch Error', 'App / Technical Issue', 'Supervisor Requested Correction', 'Other'];

  // ---------------------------------------------------------------- storage (never throws)
  function sGet(store, k) { try { return window[store].getItem(k); } catch (e) { return null; } }
  function sSet(store, k, v) { try { window[store].setItem(k, v); } catch (e) {} }
  function sDel(store, k) { try { window[store].removeItem(k); } catch (e) {} }

  // ---------------------------------------------------------------- state
  var S = {
    view: 'session',          // session | login | activate | forgot | home
    reset: false, notice: '',  // 2026-10-25: Forgot PIN (activate view used to set a new PIN)
    busy: '',                 // which action is running
    error: '',                // main error / notice
    bioMsg: '',
    code: sGet('localStorage', CODE_KEY) || '',
    activation: '', pin: '', pin2: '',
    token: '',
    participant: null,
    status: null,             // statusCore (+ statusDetails merged)
    statusLoaded: false,
    statusFailed: false,
    closedLocal: false,       // set right after a successful submit
    shifts: [], shiftsPeriod: null, shiftsLoaded: false, shiftsError: '',
    sick: [], sickError: '',
    past: [], pastLoaded: false, pastError: '',
    bioAvailable: false, bioSaved: null, offerBio: false,
    modal: null,              // { kind: 'sick'|'missed'|'edit'|'submit', ... }
    tab: sGet('sessionStorage', 'wexTab') || 'clock',
    toast: '', guide: null
  };
  var toastTimer = null;
  function showToast(t) { S.toast = t; render(); clearTimeout(toastTimer); toastTimer = setTimeout(function () { S.toast = ''; render(); }, 3500); }
  function maybeShowGuide(force) { if (force || sGet('localStorage', 'wexGuideSeen') !== 'yes') { S.guide = 0; render(); } }
  function closeGuide() { S.guide = null; sSet('localStorage', 'wexGuideSeen', 'yes'); render(); }
  // 2026-10-25: "Install the app on your phone" card (sign-in, first-time setup, More tab).
  var installEvt = null;
  var UA = navigator.userAgent || '';
  var IS_IOS = /iPhone|iPad|iPod/i.test(UA) || (/Macintosh/.test(UA) && navigator.maxTouchPoints > 1);
  var IS_ANDROID = /Android/i.test(UA);
  // 2026-10-25: pages opened inside another app's built-in browser (Google app, Facebook, Instagram,
  // LinkedIn, Snapchat...) cannot be added to the home screen; they must be opened in Safari first.
  // 2026-10-26: Chrome, Firefox, Edge and Opera on iPhone can't add this app to the home screen either.
  var IN_APP = IS_IOS && /\bGSA\/|FBAN|FBAV|Instagram|LinkedInApp|Snapchat|Line\/|MicroMessenger|TikTok|CriOS|FxiOS|EdgiOS|OPiOS/i.test(UA);
  function isInstalled() { try { return S.installed || window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true; } catch (e) { return S.installed; } }
  function installDismissed() { var t = Number(sGet('localStorage', 'wexInstallLater') || 0); return t && Date.now() - t < 14 * 86400000; }
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); installEvt = e; render(); });
  window.addEventListener('appinstalled', function () { S.installed = true; installEvt = null; render(); });
  function installCard(always) {
    if (isInstalled() || (!always && installDismissed())) return '';
    if (!installEvt && !IS_IOS && !IS_ANDROID) return '';
    var shareIcon = '<svg class="share-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M8 7l4-4 4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 11v9h12v-9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    var body;
    if (installEvt) body = '<p class="small mt1">Put FCCP WEX on your home screen so it opens like an app.</p><button type="button" class="btn btn-go mt3" data-act="install">Install the app</button>';
    else if (IS_IOS) body = '<ol class="install-steps small mt2"><li>Don\u2019t see buttons at the bottom? Tap the web address at the bottom of the screen.</li>' +
      '<li>Tap the <b>Share</b> button ' + shareIcon + '. (On newer iPhones, tap <b>&#8226;&#8226;&#8226;</b> first, then <b>Share</b>.)</li>' +
      '<li>Scroll down, tap <b>Add to Home Screen</b>, then <b>Add</b>.</li></ol>' +
      '<p class="xs mt2">Don\u2019t see <b>Add to Home Screen</b>? You may be in a Private tab. In Safari, tap the tabs button (two squares), switch from <b>Private</b> to a regular tab, then open this page again.</p>';
    else if (!IS_IOS) body = '<ol class="install-steps small mt2"><li>Tap the browser menu <b>&#8942;</b> (top or bottom corner).</li><li>Tap <b>Install app</b> or <b>Add to Home screen</b>.</li></ol>';
    if (IN_APP && !installEvt) body = '<p class="small mt1">To install the app on an iPhone, this page must be open in <b>Safari</b>.</p>' +
      '<ol class="install-steps small mt2"><li>Tap <b>Copy link</b> below.</li><li>Open <b>Safari</b> (the blue compass icon).</li><li>Tap the address bar, paste, and go.</li><li>Then follow the steps here to add it to your home screen.</li></ol>' +
      '<button type="button" class="btn mt3" data-act="copyLink">' + (S.linkCopied ? 'Link copied \u2713' : 'Copy link') + '</button>';
    return '<div class="install-card"><p class="strong">&#128241; Install the app on your phone</p>' + body +
      (always ? '' : '<button type="button" class="link mt3" data-act="installLater">Not now</button>') + '</div>';
  }
  function doInstall() {
    if (!installEvt) return;
    var e = installEvt; installEvt = null;
    try {
      e.prompt();
      e.userChoice.then(function (c) { if (c && c.outcome === 'accepted') { S.installed = true; if (S.view === 'home') showToast('App installed. Open it from your home screen.'); else render(); } else render(); }).catch(function () { render(); });
    } catch (err) { render(); }
  }
  var statusSeq = 0;          // fix 3: only the newest status request may update the screen
  var pollTimer = null;

  // ---------------------------------------------------------------- helpers
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function errText(r, fallback) { return (r && (r.error || r.message)) || fallback; }
  function isExpired(resp, r) {
    return (resp && resp.status === 401) || (r && r.sessionExpired === true) ||
      /expired|session|sign in|not authorized/i.test((r && (r.error || r.message)) || '');
  }
  function hrs(v) { if (v == null || v === '') return null; var n = Number(v); return isFinite(n) ? n.toFixed(2) : String(v); }
  function todayKey(d) { d = d || new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function pad(n) { return String(n).padStart(2, '0'); }
  function parseDay(s) {
    if (!s) return null;
    var a = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/), b = String(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (a) return new Date(+a[1], +a[2] - 1, +a[3]);
    if (b) return new Date(+b[3], +b[1] - 1, +b[2]);
    var d = new Date(s); return isNaN(d.getTime()) ? null : d;
  }
  function dayNum(s) { var d = parseDay(s); return d ? Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) : 0; }
  function fmtMDY(s) { var m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? m[2] + '/' + m[3] + '/' + m[1] : (s || '—'); }
  function fmtShort(s) { var d = parseDay(s); return d ? new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).format(d) : (s || '—'); }
  function fmtLong(s) { var d = parseDay(s); return d ? new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric' }).format(d) : (s || '—'); }
  function fmtStamp(s) { if (!s) return ''; var d = new Date(s); return isNaN(d.getTime()) ? s : new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Los_Angeles' }).format(d); }
  function fmtToday() { return new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date()); }
  // "14:05" / "2:05 PM" / ISO -> "2:05 PM"
  function fmtTime(v) {
    if (!v) return '—';
    var t = String(v).trim();
    if (/^\d{4}-\d{2}-\d{2}[T\s].*(Z|[+-]\d{2}:?\d{2})$/i.test(t)) {
      var d = new Date(t);
      if (!isNaN(d.getTime())) return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/Los_Angeles' }).format(d);
    }
    var m = t.match(/(?:T|\s)?(\d{1,2}):(\d{2})\s*([AP]M)?/i);
    if (!m) return t;
    var h = Number(m[1]), ap = m[3] && m[3].toUpperCase();
    return ap ? h + ':' + m[2] + ' ' + ap : (h % 12 || 12) + ':' + m[2] + ' ' + (h >= 12 ? 'PM' : 'AM');
  }
  // any time text -> "HH:mm" (24h) or ''
  function to24(v) {
    if (!v) return '';
    var t = String(v).trim();
    if (/^\d{4}-\d{2}-\d{2}[T\s].*(Z|[+-]\d{2}:?\d{2})$/i.test(t)) {
      var d = new Date(t);
      if (!isNaN(d.getTime())) {
        var p = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Los_Angeles' }).formatToParts(d);
        var hh = (p.find(function (x) { return x.type === 'hour'; }) || {}).value, mm = (p.find(function (x) { return x.type === 'minute'; }) || {}).value;
        if (hh && mm) return (hh === '24' ? '00' : hh) + ':' + mm;
      }
    }
    var m = t.match(/(?:T|\s)?(\d{1,2}):(\d{2})(?::\d{2})?\s*([AP]M)?/i);
    if (!m) return '';
    var h = Number(m[1]), ap = m[3] && m[3].toUpperCase();
    if (ap) h = h % 12 + (ap === 'PM' ? 12 : 0);
    return pad(h) + ':' + m[2];
  }
  function mins(t) { return Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)); }
  function workedHours(start, lo, li, end) {
    if (!start || !end) return null;
    var a = mins(end) - mins(start); if (a < 0) a += 1440;
    if (lo && li) { var l = mins(li) - mins(lo); if (l < 0) l += 1440; a -= l; }
    return Math.max(0, a) / 60;
  }
  function stateLabel(s) {
    var t = String(s || '').toUpperCase();
    if (t === 'OPEN' || t === 'WORKING') return 'Working';
    if (t === 'LUNCH' || t === 'AT_LUNCH') return 'At Lunch';
    if (t === 'OFF_CLOCK' || t === 'OFF CLOCK' || t === 'OFF' || t === 'CLOSED') return 'Off Clock';
    return s || '—';
  }
  // "Regular w/Lunch Penalty" -> plain words for participants
  function hasMealPremium(e) { return /lunch penalty/i.test(String((e && e.type) || '')); }
  function typeLabel(t) { return /lunch penalty/i.test(String(t || '')) ? 'Regular + meal premium' : (t || ''); }
  function mealChip(e) { return hasMealPremium(e) ? '<p class="meal-note">Meal premium: +1 hour of pay. You worked over 5 hours without a 30-minute lunch.</p>' : ''; }
  function isSuperseded(e) { return e.superseded === true || e.cancelled === true || [e.status, e.correctionStatus].some(function (s) { return ['SUPERSEDED', 'CANCELLED', 'CANCELED'].indexOf(String(s || '').toUpperCase()) >= 0; }); }
  function isClosed() { return (S.status && S.status.timecard && S.status.timecard.closed === true) || S.closedLocal; }
  function allowed() { return ((S.status && S.status.allowedActions) || []).map(function (a) { return String(a).toUpperCase(); }); }

  // ---------------------------------------------------------------- API
  function api(body) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, (body.action === 'timecardReview' || body.action === 'submitTimecard') ? 90000 : 25000); // 2026-10-26: signing can take longer than 25 seconds
    return fetch(API_URL, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body), redirect: 'follow', signal: ctrl.signal
    }).catch(function (e) {
      throw new Error(e && e.name === 'AbortError' ? 'The timekeeping service did not respond. Please try again.' : 'Unable to connect to the timekeeping service. Please try again.');
    }).then(function (resp) {
      return resp.json().catch(function () { throw new Error('The timekeeping service returned an invalid response. Please try again.'); })
        .then(function (r) { return { resp: resp, r: r }; });
    }).finally(function () { clearTimeout(timer); });
  }

  // ---------------------------------------------------------------- Face ID / fingerprint (same scheme as before)
  function rand(n) { var a = new Uint8Array(n); crypto.getRandomValues(a); return a; }
  function b64u(buf) { var a = buf instanceof Uint8Array ? buf : new Uint8Array(buf), s = ''; a.forEach(function (x) { s += String.fromCharCode(x); }); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
  function unb64u(s) { var t = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4), b = atob(t); return Uint8Array.from(b, function (c) { return c.charCodeAt(0); }); }
  function uuid() { return typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : b64u(rand(16)); }
  function deviceLabel() { var u = navigator.userAgent; return /iPhone/i.test(u) ? 'iPhone' : /iPad/i.test(u) ? 'iPad' : /Android/i.test(u) ? 'Android device' : /Windows/i.test(u) ? 'Windows device' : /Macintosh|Mac OS/i.test(u) ? 'Mac' : 'Web browser'; }
  function clearBio() { try { Object.keys(localStorage).filter(function (k) { return k.indexOf('wexBiometric') === 0; }).forEach(function (k) { localStorage.removeItem(k); }); } catch (e) {} }
  function savedBio(code) {
    if (!code) return null;
    var o = {}; Object.keys(BIO).forEach(function (k) { o[k] = sGet('localStorage', BIO[k]); });
    if (o.participantCode !== code || Object.keys(o).some(function (k) { return !o[k]; }) || isNaN(Date.parse(o.expiresAt)) || Date.parse(o.expiresAt) <= Date.now()) return null;
    return o;
  }
  function bioSupported() {
    if (!window.isSecureContext || !window.PublicKeyCredential || !navigator.credentials || !crypto.subtle) return Promise.resolve(false);
    try {
      var p = window.PublicKeyCredential.getClientCapabilities ? window.PublicKeyCredential.getClientCapabilities() : Promise.resolve({});
      return Promise.resolve(p).then(function (c) { return !c || c.prf !== false; }).catch(function () { return false; });
    } catch (e) { return Promise.resolve(false); }
  }
  function isCancel(e) { return e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'AbortError'); }
  function prfKey(credentialId, salt) {
    return navigator.credentials.get({ publicKey: { challenge: rand(32), rpId: location.hostname, allowCredentials: [{ id: unb64u(credentialId), type: 'public-key' }], userVerification: 'required', extensions: { prf: { eval: { first: salt } } } } })
      .then(function (cred) {
        if (!cred) throw new Error('Device verification was not completed.');
        var r = cred.getClientExtensionResults(); r = r && r.prf && r.prf.results && r.prf.results.first;
        if (!r) throw new Error('PRF_UNAVAILABLE');
        return new Uint8Array(r);
      });
  }
  function encrypt(text, key) {
    var iv = rand(12);
    return crypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['encrypt'])
      .then(function (k) { return crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, k, new TextEncoder().encode(text)); })
      .then(function (c) { return { ciphertext: b64u(c), iv: b64u(iv) }; });
  }
  function decrypt(ct, iv, key) {
    return crypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['decrypt'])
      .then(function (k) { return crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64u(iv) }, k, unb64u(ct)); })
      .then(function (p) { return new TextDecoder().decode(p); });
  }
  function refreshBio(code) {
    if (!code) { S.bioAvailable = false; S.bioSaved = null; return Promise.resolve(); }
    return bioSupported().then(function (ok) { S.bioAvailable = ok; S.bioSaved = ok ? savedBio(code) : null; });
  }

  // ---------------------------------------------------------------- session
  function resetTo(view, msg) {
    sDel('sessionStorage', TOKEN_KEY);
    statusSeq++;
    S.token = ''; S.participant = null; S.status = null; S.statusLoaded = false; S.statusFailed = false; S.closedLocal = false;
    S.shifts = []; S.shiftsPeriod = null; S.shiftsLoaded = false; S.shiftsError = '';
    S.sick = []; S.sickError = ''; S.past = []; S.pastLoaded = false; S.pastError = '';
    S.offerBio = false; S.bioMsg = ''; S.modal = null; S.pin = ''; S.pin2 = ''; S.tab = 'clock'; S.guide = null; sDel('sessionStorage', 'wexTab');
    S.view = view || 'login'; S.error = msg || '';
    stopPolling();
    if (S.view === 'login') refreshBio(S.code.trim()).then(render);
    render();
  }
  function expired() { resetTo('login', SESSION_EXPIRED); }

  function startSession(token, participant) {
    sSet('sessionStorage', TOKEN_KEY, token);
    S.token = token; S.participant = participant; S.status = null; S.statusLoaded = false; S.statusFailed = false; S.closedLocal = false;
    S.view = 'home'; S.pin = ''; S.pin2 = ''; S.error = '';
    startPolling();
    render();
    return loadStatus(true).then(function (ok) { loadLists(); return ok; });
  }

  // fix 3: every status request gets a number; an older answer never overwrites a newer screen.
  function loadStatus(showBusy) {
    var token = S.token; if (!token) return Promise.resolve(false);
    var seq = ++statusSeq;
    if (showBusy) { S.busy = S.busy || 'status'; render(); }
    loadDetails(token);   // 2026-10-24: hours remaining / sick time load at the same time, not after
    return api({ action: 'statusCore', token: token }).then(function (x) {
      if (x.r.ok === false && /unknown.*action/i.test(errText(x.r, ''))) return api({ action: 'status', token: token });
      return x;
    }).then(function (x) {
      if (seq !== statusSeq || token !== S.token) return false;
      if (isExpired(x.resp, x.r)) { expired(); return false; }
      if (!x.resp.ok || x.r.ok === false || !x.r.participant) { S.statusFailed = true; S.error = errText(x.r, 'Unable to load your timekeeping status.'); return false; }
      var keep = S.status && S.status.balances !== undefined ? { balances: S.status.balances, lowHoursWarning: S.status.lowHoursWarning, mealWarning: S.status.mealWarning, startDate: S.status.startDate, openPeriods: S.status.openPeriods } : {};
      S.participant = x.r.participant;
      S.status = Object.assign({}, keep, x.r);
      if (x.r.timecard && x.r.timecard.closed === false) S.closedLocal = false;
      S.statusLoaded = true; S.statusFailed = false; S.error = '';
      return true;
    }).catch(function (e) {
      if (seq !== statusSeq) return false;
      S.statusFailed = true; S.error = e.message || 'Unable to load your timekeeping status.'; return false;
    }).finally(function () {
      if (showBusy && S.busy === 'status') S.busy = '';
      render();
    });
  }
  // Balances do not change with punch state, so the newest answer that arrives is always used.
  var detailsSeq = 0, detailsShown = 0;
  function loadDetails(token) {
    var mySeq = ++detailsSeq;
    api({ action: 'statusDetails', token: token }).then(function (x) {
      if (token !== S.token || mySeq < detailsShown) return;
      detailsShown = mySeq;
      if (isExpired(x.resp, x.r)) { expired(); return; }
      if (!x.resp.ok || x.r.ok === false) throw new Error();
      S.status = Object.assign({}, S.status || {}, { balances: x.r.balances, lowHoursWarning: x.r.lowHoursWarning, mealWarning: x.r.mealWarning, startDate: x.r.startDate || '', openPeriods: x.r.openPeriods || [] });
      render();
    }).catch(function () {
      if (token !== S.token) return;
      S.statusFailed = true; S.error = 'Your timecard loaded, but balance details are unavailable. Tap Retry loading status to try again.'; render();
    });
  }
  function loadLists() {
    var token = S.token; if (!token) return Promise.resolve();
    var a = api({ action: 'shiftHistory', token: token }).then(function (x) {
      if (token !== S.token) return;
      if (isExpired(x.resp, x.r)) { expired(); return; }
      if (!x.resp.ok || x.r.ok === false) { S.shiftsError = 'Unable to load your shifts right now. Please try again.'; S.shiftsLoaded = true; return; }
      S.shifts = x.r.shifts || []; S.shiftsPeriod = x.r.payPeriod || null; S.shiftsError = ''; S.shiftsLoaded = true;
    }).catch(function () { S.shiftsError = 'Unable to load your shifts right now. Please try again.'; S.shiftsLoaded = true; })
      .then(function () {
        return api({ action: 'unsubmittedTimecards', token: token }).then(function (x) {
          if (token !== S.token) return;
          if (isExpired(x.resp, x.r)) { expired(); return; }
          if (!x.resp.ok || x.r.ok === false) { S.pastError = 'Unable to load older timecards right now.'; S.pastLoaded = true; return; }
          S.past = x.r.timecards || []; S.pastError = ''; S.pastLoaded = true;
        }).catch(function () { S.pastError = 'Unable to load older timecards right now.'; S.pastLoaded = true; });
      });
    var b = api({ action: 'sickRequestHistory', token: token }).then(function (x) {
      if (token !== S.token) return;
      if (isExpired(x.resp, x.r)) { expired(); return; }
      if (!x.resp.ok || x.r.ok === false) { S.sickError = errText(x.r, 'Unable to load sick-time requests.'); return; }
      S.sick = (x.r.requests || x.r.sickRequests || []).slice().sort(function (p, q) { return dayNum(q.workDate) - dayNum(p.workDate) || to24(q.startTime).localeCompare(to24(p.startTime)); });
      S.sickError = '';
    }).catch(function (e) { S.sickError = e.message || 'Unable to load sick-time requests.'; });
    return Promise.all([a, b]).then(render);
  }
  function refreshAll() { return Promise.all([loadStatus(false), loadLists()]); }
  function startPolling() {
    stopPolling();
    pollTimer = setInterval(function () { if (document.visibilityState === 'visible' && !S.busy && !S.modal) loadStatus(false); }, 60000);
  }
  function stopPolling() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; }
  // keep "2 hr 14 min so far" current without a server call
  setInterval(function () {
    var a = document.activeElement;
    if (S.view === 'home' && S.tab === 'clock' && !S.modal && S.guide == null && !S.busy && !(a && /INPUT|SELECT|TEXTAREA/.test(a.tagName))) render();
  }, 30000);
  window.addEventListener('focus', function () { if (S.view === 'home' && S.token && !S.busy && !S.modal) loadStatus(false); });
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible' && S.view === 'home' && S.token && !S.busy && !S.modal) loadStatus(false); });

  // ---------------------------------------------------------------- actions: sign in
  function doLogin() {
    S.error = ''; S.bioMsg = '';
    var code = S.code.trim();
    if (!code) { S.error = 'Enter your participant code.'; return render(); }
    if (!/^\d{4}$/.test(S.pin)) { S.error = 'Enter your four-digit PIN.'; return render(); }
    S.busy = 'login'; render();
    api({ action: 'login', participantCode: code, pin: S.pin }).then(function (x) {
      if (!x.resp.ok || x.r.ok !== true || !x.r.token || !x.r.participant) { S.error = errText(x.r, 'Unable to sign in.'); return; }
      sSet('localStorage', CODE_KEY, code);
      S.busy = '';
      return startSession(x.r.token, x.r.participant).then(function (ok) {
        if (!ok) return;
        maybeShowGuide(false);
        return bioSupported().then(function (sup) { if (sup && !savedBio(code)) { S.offerBio = true; render(); } });
      });
    }).catch(function (e) { S.error = e.message || 'Unable to sign in.'; })
      .finally(function () { if (S.busy === 'login') S.busy = ''; render(); });
  }
  function doActivate() {
    S.error = '';
    var code = S.code.trim();
    if (!code || !/^\d{6}$/.test(S.activation.trim())) { S.error = 'Enter your participant code and six-digit activation code.'; return render(); }
    if (!/^\d{4}$/.test(S.pin) || S.pin !== S.pin2) { S.error = 'Your PIN must be four digits, and both PIN fields must match.'; return render(); }
    S.busy = 'activate'; render();
    api({ action: 'activate', participantCode: code, activationCode: S.activation.trim(), pin: S.pin }).then(function (x) {
      if (!x.resp.ok || x.r.ok !== true || !x.r.token || !x.r.participant) { S.error = errText(x.r, 'Unable to activate your account.'); return; }
      sSet('localStorage', CODE_KEY, code);
      var wasReset = S.reset;
      S.activation = ''; S.busy = ''; S.reset = false; S.notice = '';
      return startSession(x.r.token, x.r.participant).then(function () { if (wasReset) showToast('Your new PIN is saved.'); else maybeShowGuide(true); });
    }).catch(function (e) { S.error = e.message || 'Unable to activate your account.'; })
      .finally(function () { if (S.busy === 'activate') S.busy = ''; render(); });
  }
  function doDeviceLogin() {
    var saved = S.bioSaved; if (!saved || S.busy) return;
    S.bioMsg = ''; S.error = ''; S.busy = 'deviceLogin'; render();
    prfKey(saved.credentialId, unb64u(saved.prfSalt))
      .then(function (key) { return decrypt(saved.tokenCiphertext, saved.tokenIv, key); })
      .then(function (deviceToken) { return api({ action: 'deviceLogin', participantCode: saved.participantCode, deviceId: saved.deviceId, deviceToken: deviceToken }); })
      .then(function (x) {
        if (!x.resp.ok || x.r.ok !== true || !x.r.token || !x.r.participant) {
          if (x.resp.status === 401 || /invalid|revoked|expired|device|trusted/i.test(errText(x.r, ''))) {
            clearBio(); S.bioSaved = null; S.bioMsg = 'Face ID / fingerprint sign-in needs to be set up again. Please sign in with your PIN.'; return;
          }
          S.bioMsg = errText(x.r, 'Unable to sign in with this device.'); return;
        }
        sSet('localStorage', CODE_KEY, saved.participantCode);
        S.busy = '';
        return startSession(x.r.token, x.r.participant);
      })
      .catch(function (e) {
        if (isCancel(e)) return;
        S.bioMsg = (e && (e.message === 'PRF_UNAVAILABLE' || e.name === 'OperationError'))
          ? 'Face ID / fingerprint sign-in is not available on this device. You can continue using your PIN.'
          : 'Face ID / fingerprint sign-in could not be completed. Please use your PIN.';
      })
      .finally(function () { if (S.busy === 'deviceLogin') S.busy = ''; render(); });
  }
  function doEnroll() {
    if (!S.token || !S.participant || S.busy) return;
    S.bioMsg = ''; S.busy = 'deviceEnroll'; render();
    var deviceId = uuid(), salt = rand(32), credId = '';
    bioSupported().then(function (ok) {
      if (!ok) throw new Error('DEVICE_UNAVAILABLE');
      return navigator.credentials.create({ publicKey: {
        challenge: rand(32), rp: { id: location.hostname, name: 'FCCP WEX Timekeeping' },
        user: { id: rand(32), name: S.participant.code, displayName: S.participant.name },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
        attestation: 'none' } });
    }).then(function (cred) {
      if (!cred) throw new Error('DEVICE_UNAVAILABLE');
      credId = b64u(cred.rawId);
      return prfKey(credId, salt);
    }).then(function (key) {
      return api({ action: 'deviceEnroll', token: S.token, deviceId: deviceId, label: deviceLabel() }).then(function (x) {
        if (!x.resp.ok || x.r.ok !== true || !x.r.deviceToken || !x.r.expiresAt) { S.bioMsg = errText(x.r, 'Unable to set up device sign-in.'); return; }
        return encrypt(x.r.deviceToken, key).then(function (enc) {
          sSet('localStorage', BIO.participantCode, S.participant.code);
          sSet('localStorage', BIO.deviceId, deviceId);
          sSet('localStorage', BIO.credentialId, credId);
          sSet('localStorage', BIO.prfSalt, b64u(salt));
          sSet('localStorage', BIO.tokenCiphertext, enc.ciphertext);
          sSet('localStorage', BIO.tokenIv, enc.iv);
          sSet('localStorage', BIO.expiresAt, x.r.expiresAt);
          S.bioSaved = savedBio(S.participant.code); S.offerBio = false;
          S.bioMsg = 'Face ID / fingerprint sign-in is ready for this device.';
        });
      });
    }).catch(function (e) {
      if (isCancel(e)) return;
      S.bioMsg = (e && (e.message === 'DEVICE_UNAVAILABLE' || e.message === 'PRF_UNAVAILABLE'))
        ? 'Face ID / fingerprint sign-in is not available on this device. You can continue using your PIN.'
        : (e && e.message) || 'Unable to set up device sign-in.';
    }).finally(function () { S.busy = ''; render(); });
  }
  function doRevoke() {
    if (!S.token || !S.bioSaved || S.busy) return;
    S.bioMsg = ''; S.busy = 'deviceRevoke'; render();
    api({ action: 'deviceRevoke', token: S.token, deviceId: S.bioSaved.deviceId }).then(function (x) {
      if (!x.resp.ok || x.r.ok !== true) { S.bioMsg = errText(x.r, 'Unable to remove device sign-in.'); return; }
      clearBio(); S.bioSaved = null; S.offerBio = false;
      S.bioMsg = 'Face ID / fingerprint sign-in has been removed from this device.';
    }).catch(function (e) { S.bioMsg = e.message || 'Unable to remove device sign-in.'; })
      .finally(function () { S.busy = ''; render(); });
  }
  function doLogout() {
    if (!S.token) return resetTo('login');
    S.busy = 'logout'; render();
    var token = S.token, msg = '';
    api({ action: 'logout', token: token }).catch(function (e) { msg = e.message || 'Unable to sign out from the timekeeping service.'; })
      .finally(function () { S.busy = ''; resetTo('login', msg); });
  }

  // ---------------------------------------------------------------- actions: punches
  function doPunch(action) {
    if (S.busy || !S.token || !S.statusLoaded || isClosed() || allowed().indexOf(action) < 0) return;
    S.error = ''; S.busy = 'punch';
    statusSeq++;                       // fix 3: drop any status answer that started before this punch
    render();
    api({ action: 'punch', token: S.token, punchAction: action }).then(function (x) {
      if (isExpired(x.resp, x.r)) { expired(); return; }
      if (!x.resp.ok || x.r.ok !== true) { S.error = errText(x.r, 'The punch was not recorded. Your screen was not changed.'); return; }
      // Show the new state right away from the punch answer, then refresh the details.
      if (S.status) {
        S.status.state = x.r.status === 'Active' ? 'Off Clock' : x.r.status;
        S.status.allowedActions = x.r.allowedActions || S.status.allowedActions;
        S.status.sinceTime = x.r.time || '';
      }
      S.busy = '';
      var said = { CLOCK_IN: 'Clocked in', START_LUNCH: 'Lunch started', END_LUNCH: 'Back from lunch', CLOCK_OUT: 'Clocked out' }[action];
      showToast('\u2713 ' + said + (x.r.time ? ' at ' + fmtTime(x.r.time) : '') + ' \u2013 saved');
      return refreshAll();
    }).catch(function (e) { S.error = e.message || 'The punch was not recorded. Your screen was not changed.'; })
      .finally(function () { if (S.busy === 'punch') S.busy = ''; render(); });
  }

  // ---------------------------------------------------------------- modals
  function openSick() {
    if (!S.statusLoaded || isClosed() || !(Number(S.status && S.status.balances && S.status.balances.sickAvailable) > 0)) return;
    S.modal = { kind: 'sick', date: todayKey(), start: '', end: '', manual: {}, err: '', busy: false, done: false };
    render();
  }
  function submitSick() {
    var m = S.modal; if (!m || m.busy) return;
    m.err = '';
    if (!m.date || !m.start || !m.end) { m.err = 'Enter a date, start time, and end time.'; return render(); }
    m.busy = true; render();
    api({ action: 'requestSickTime', token: S.token, workDate: m.date, startTime: m.start, endTime: m.end }).then(function (x) {
      if (isExpired(x.resp, x.r)) { expired(); return; }
      if (!x.resp.ok || x.r.ok !== true) { m.err = errText(x.r, 'Unable to submit your sick-time request.'); return; }
      m.done = true; m.doneText = x.r.message || 'FCCP staff will review your request.';
      render();
      return refreshAll().then(function () { return wait(1500); }).then(function () { if (S.modal === m) S.modal = null; });
    }).catch(function (e) { m.err = e.message || 'Unable to submit your sick-time request.'; })
      .finally(function () { m.busy = false; render(); });
  }
  function openMissed(date) {
    if (!S.statusLoaded || (isClosed() && !date)) return;
    S.modal = { kind: 'missed', step: 'form', f: { workDate: date || todayKey(), startTime: '', lunchOut: '', lunchIn: '', endTime: '' }, manual: {}, reason: '', details: '', err: '', busy: false };
    render();
  }
  function reviewMissed() {
    var m = S.modal, f = m.f; m.err = '';
    if (!f.workDate || !f.startTime || !f.endTime) m.err = 'Enter a work date, Clock In, and Clock Out.';
    else if (!!f.lunchOut !== !!f.lunchIn) m.err = 'Enter both Lunch Out and Lunch In, or leave both blank.';
    else if (!m.reason) m.err = 'Please select a reason for adding this shift.';
    else if (m.reason === 'Other' && !m.details.trim()) m.err = 'Please enter additional details.';
    else m.step = 'review';
    render();
  }
  function submitMissed() {
    var m = S.modal, f = m.f; if (m.busy) return;
    m.busy = true; m.err = ''; render();
    api({ action: 'addMissedShift', token: S.token, workDate: f.workDate, startTime: f.startTime, lunchOut: f.lunchOut, lunchIn: f.lunchIn, endTime: f.endTime,
      correctionReason: m.reason, correctionDetails: m.reason === 'Other' ? m.details.trim() : '' }).then(function (x) {
      if (isExpired(x.resp, x.r)) { expired(); return; }
      if (!x.resp.ok || x.r.ok !== true) { m.err = errText(x.r, 'Unable to add this shift.'); return; }
      m.step = 'done'; m.doneText = x.r.message || 'Your timecard has been updated.';   // fix 4
      render();
      return refreshAll().then(function () { return wait(2500); }).then(function () { if (S.modal === m) S.modal = null; });
    }).catch(function (e) { m.err = e.message || 'Unable to add this shift.'; })
      .finally(function () { m.busy = false; render(); });
  }
  function openEdit(punchId) {
    var sh = S.shifts.filter(function (x) { return String(x.punchId) === String(punchId); })[0];
    if (!sh || isClosed()) return;
    S.modal = { kind: 'edit', step: 'form', shift: sh,
      f: { startTime: to24(sh.startTime), lunchOut: to24(sh.lunchOut), lunchIn: to24(sh.lunchIn), endTime: to24(sh.endTime) },
      manual: {}, reason: sh.endTime ? '' : 'Forgot to Clock Out', details: '', err: '', busy: false };
    render();
  }
  function reviewEdit() {
    var m = S.modal, f = m.f; m.err = '';
    if (!m.reason) m.err = 'Please select a reason for this correction.';
    else if (m.reason === 'Other' && !m.details.trim()) m.err = 'Please explain the reason for this correction.';
    else if (!f.startTime || !f.endTime) m.err = 'Clock In and Clock Out are required.';
    else if (!!f.lunchOut !== !!f.lunchIn) m.err = 'Enter both Lunch Out and Lunch In, or leave both blank.';
    else m.step = 'review';
    render();
  }
  function submitEdit() {
    var m = S.modal, f = m.f; if (m.busy) return;
    m.busy = true; m.err = ''; render();
    api({ action: 'editShift', token: S.token, punchId: m.shift.punchId, startTime: f.startTime, lunchOut: f.lunchOut, lunchIn: f.lunchIn, endTime: f.endTime,
      correctionReason: m.reason, correctionDetails: m.reason === 'Other' ? m.details.trim() : '' }).then(function (x) {
      if (isExpired(x.resp, x.r)) { expired(); return; }
      if (!x.resp.ok || x.r.ok !== true) { m.err = errText(x.r, 'Unable to save this correction.'); return; }
      m.step = 'done'; m.doneText = x.r.message || 'Your timesheet has been updated.';
      render();
      return refreshAll().then(function () { return wait(1500); }).then(function () { if (S.modal === m) S.modal = null; });
    }).catch(function (e) { m.err = e.message || 'Unable to save this correction.'; })
      .finally(function () { m.busy = false; render(); });
  }
  function openSubmit() {
    if (!S.token || !S.statusLoaded || isClosed()) return;
    var m = { kind: 'submit', step: 'review', review: null, loading: true, err: '', c1: false, c2: false, signed: false, busy: false };
    S.modal = m; render();
    api({ action: 'timecardReview', token: S.token }).then(function (x) {
      if (isExpired(x.resp, x.r)) { expired(); return; }
      if (!x.resp.ok || x.r.ok === false) throw new Error(errText(x.r, 'Unable to review your timecard.'));
      var rv = x.r.review || x.r;
      if (typeof rv.canSubmit !== 'boolean' && typeof x.r.canSubmit === 'boolean') rv.canSubmit = x.r.canSubmit;
      m.review = rv;
    }).catch(function (e) { m.err = e.message || 'Unable to review your timecard.'; })
      .finally(function () { m.loading = false; render(); });
  }
  function submitSigned() {
    var m = S.modal; if (!m || m.busy || !m.signed) return;
    var canvas = document.getElementById('sig'); if (!canvas) return;
    var ctx = canvas.getContext('2d'), img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    var minX = canvas.width, minY = canvas.height, maxX = -1, maxY = -1;
    for (var y = 0; y < canvas.height; y++) for (var x = 0; x < canvas.width; x++) {
      var i = (y * canvas.width + x) * 4;
      if (img.data[i] < 245 || img.data[i + 1] < 245 || img.data[i + 2] < 245) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    }
    if (maxX < minX || maxY < minY) { m.signed = false; m.err = 'Please draw your signature before submitting.'; return render(); }
    var out = document.createElement('canvas'); out.width = maxX - minX + 17; out.height = maxY - minY + 17;
    var oc = out.getContext('2d'); oc.fillStyle = '#ffffff'; oc.fillRect(0, 0, out.width, out.height); oc.drawImage(canvas, 8 - minX, 8 - minY);
    var dataUrl = out.toDataURL('image/png');
    m.busy = true; m.err = ''; renderSubmitButtons();
    var sentAt = Date.now();
    api({ action: 'submitTimecard', token: S.token, certifyAccurate: true, certifyClose: true, signatureDataUrl: dataUrl }).then(function (x) {
      if (isExpired(x.resp, x.r)) { expired(); return; }
      if (x.r.ok !== true) { m.err = errText(x.r, 'Unable to submit your timecard.'); m.busy = false; render(); return; }
      S.closedLocal = true; m.step = 'done'; m.busy = false; render();
      return refreshAll().then(function () { return wait(2000); }).then(function () { if (S.modal === m) S.modal = null; render(); });
    }).catch(function () {
      // The answer may have been lost after the card was saved; check before asking to try again.
      // 2026-10-26: check the pay period being signed (it can be an earlier one), not today's pay period.
      return api({ action: 'timecardReview', token: S.token }).then(function (x) {
        var c = x.r && x.r.closure;
        if (c && c.status === 'Submitted' && Date.parse(c.submittedAt || '') >= sentAt - 120000) { S.closedLocal = true; m.step = 'done'; m.busy = false; render(); return refreshAll().then(function () { return wait(2000); }).then(function () { if (S.modal === m) S.modal = null; render(); }); }
        throw new Error();
      }).catch(function () { m.err = 'The timekeeping service did not respond. Please try again.'; m.busy = false; render(); });
    });
  }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // ---------------------------------------------------------------- time picker (hour / minute / AM-PM)
  // AM/PM is guessed from the earlier times in the same shift until the person picks it themselves.
  function guessPeriod(h, m, earlier) {
    var last = earlier.filter(Boolean).slice(-1)[0];
    if (!last) return 'AM';
    var i = mins(last), s = (Number(h) % 12) * 60 + Number(m || '00'), c = s + 720;
    return s > i ? 'AM' : c > i ? 'PM' : 'AM';
  }
  function earlierFor(f, field) {
    return field === 'lunchOut' ? [f.startTime] : field === 'lunchIn' ? [f.startTime, f.lunchOut] : field === 'endTime' ? [f.startTime, f.lunchOut, f.lunchIn] : [];
  }
  function timePicker(value, name, label) {
    var h24 = value ? Number(value.slice(0, 2)) : 0, hour = value ? String(h24 % 12 || 12) : '', minute = value ? value.slice(3, 5) : '', ap = value ? (h24 >= 12 ? 'PM' : 'AM') : '';
    var hours = '<option value="">Hour</option>'; for (var i = 1; i <= 12; i++) hours += '<option' + (String(i) === hour ? ' selected' : '') + '>' + i + '</option>';
    var minsOpt = '<option value="">Minute</option>'; for (var j = 0; j < 60; j++) { var mm = pad(j); minsOpt += '<option' + (mm === minute ? ' selected' : '') + '>' + mm + '</option>'; }
    return '<div class="time-row">' +
      '<select class="select" aria-label="' + esc(label) + ' hour" data-time="' + name + '" data-part="h">' + hours + '</select>' +
      '<select class="select" aria-label="' + esc(label) + ' minute" data-time="' + name + '" data-part="m">' + minsOpt + '</select>' +
      '<select class="select" aria-label="' + esc(label) + ' AM or PM" data-time="' + name + '" data-part="p"><option value="" disabled hidden' + (ap ? '' : ' selected') + '>Choose</option><option' + (ap === 'AM' ? ' selected' : '') + '>AM</option><option' + (ap === 'PM' ? ' selected' : '') + '>PM</option></select>' +
      '</div>';
  }
  function onTimeChange(sel) {
    var m = S.modal; if (!m) return;
    var name = sel.getAttribute('data-time'), part = sel.getAttribute('data-part');
    var f = m.kind === 'sick' ? { startTime: m.start, endTime: m.end } : m.f;
    var cur = f[name] || '', h24 = cur ? Number(cur.slice(0, 2)) : 0;
    var hour = cur ? String(h24 % 12 || 12) : '', minute = cur ? cur.slice(3, 5) : '', ap = cur ? (h24 >= 12 ? 'PM' : 'AM') : '';
    var earlier = m.kind === 'sick' ? (name === 'endTime' ? [m.start] : []) : earlierFor(f, name);
    var v = sel.value, next = cur;
    if (part === 'h') {
      if (!v) { next = ''; m.manual[name] = false; }
      else { var mm = minute || '00'; var p = m.manual[name] && cur ? ap : guessPeriod(v, mm, earlier); next = pad(Number(v) % 12 + (p === 'PM' ? 12 : 0)) + ':' + mm; }
    } else if (part === 'm') {
      if (!hour || !v) { next = ''; m.manual[name] = false; }
      else { var p2 = m.manual[name] ? ap : guessPeriod(hour, v, earlier); next = pad(Number(hour) % 12 + (p2 === 'PM' ? 12 : 0)) + ':' + v; }
    } else if (part === 'p') {
      if (hour && minute) { next = pad(Number(hour) % 12 + (v === 'PM' ? 12 : 0)) + ':' + minute; m.manual[name] = true; }
    }
    if (m.kind === 'sick') { if (name === 'startTime') m.start = next; else m.end = next; } else f[name] = next;
    render();
  }

  // ---------------------------------------------------------------- render
  var app = document.getElementById('app');
  function banner() { return IS_TEST ? '<div class="env-banner">NEW TEST SITE - not for real time</div>' : ''; }
  function brand(sub) {
    return '<div class="brand"><div class="brand-mark">' + logoHtml() + '</div><div style="min-width:0"><p class="brand-name">FCCP WEX</p>' + (sub ? '<p class="brand-sub">' + sub + '</p>' : '') + '</div></div>';
  }
  function logoHtml() { return '<img src="fccp-logo.png" alt="Folsom Cordova Community Partnership" onerror="this.parentNode.classList.add(\'no-logo\');this.parentNode.textContent=\'FCCP\'">'; }
  function alertHtml(t) { return t ? '<p role="alert" class="alert">' + esc(t) + '</p>' : ''; }

  function render() {
    var focusId = document.activeElement && document.activeElement.id;
    var html;
    if (S.view === 'session') html = '<main class="center-screen"><p class="loading-text">Loading your timekeeping account…</p></main>';
    else if (S.view === 'activate') html = renderActivate();
    else if (S.view === 'login') html = renderLogin();
    else if (S.view === 'forgot') html = renderForgot();
    else html = renderHome();
    var openKeys = {}; Array.prototype.forEach.call(app.querySelectorAll('details[open][data-key]'), function (d) { openKeys[d.getAttribute('data-key')] = 1; });
    // 2026-10-26: keep the pop-up window's scroll spot when it redraws (checking a box no longer jumps to the top).
    var oldDialog = app.querySelector('.dialog'), dialogTop = oldDialog ? oldDialog.scrollTop : 0, dialogKey = S.modal ? S.modal.kind + '|' + (S.modal.step || '') : '';
    app.innerHTML = banner() + html + renderModal();
    var newDialog = app.querySelector('.dialog'); if (newDialog && oldDialog && dialogKey && dialogKey === render.lastDialogKey) newDialog.scrollTop = dialogTop;
    render.lastDialogKey = dialogKey;
    Array.prototype.forEach.call(app.querySelectorAll('details[data-key]'), function (d) { if (openKeys[d.getAttribute('data-key')]) d.open = true; });
    if (focusId) { var el = document.getElementById(focusId); if (el && el.tagName !== 'BUTTON') { el.focus(); if (el.setSelectionRange && el.type !== 'date') try { el.setSelectionRange(el.value.length, el.value.length); } catch (e) {} } }
    setupSignature();
  }
  function renderLogin() {
    var b = S.busy;
    return '<main class="center-screen"><form class="card-xl" data-form="login">' + brand('') +
      '<h1 class="title mt6">Welcome back</h1><p class="small muted mt3">Enter your participant code and the PIN you created during activation.</p>' + installCard(false) +
      (S.bioAvailable && S.bioSaved ? '<div class="panel mt6" style="border:1px solid var(--line)"><p class="small strong">Sign in faster</p>' +
        '<button type="button" class="btn btn-primary mt3" data-act="deviceLogin"' + (b ? ' disabled' : '') + '>' + (b === 'deviceLogin' ? 'Checking device…' : 'Sign in with Face ID / fingerprint') + '</button>' +
        '<p class="small muted mt3" style="text-align:center">Or sign in with your PIN below</p></div>' : '') +
      '<label class="field mt8">Participant code<input id="code" class="input" data-model="code" value="' + esc(S.code) + '" autocomplete="username" enterkeyhint="next"></label>' +
      '<button type="button" class="link mt2" data-act="otherParticipant"' + (b ? ' disabled' : '') + '>Use a different participant</button>' +
      '<label class="field">4-digit PIN<input id="pin" class="input pin" data-model="pin" value="' + esc(S.pin) + '" inputmode="numeric" maxlength="4" type="password" autocomplete="current-password" enterkeyhint="go"></label>' +
      alertHtml(S.error || S.bioMsg) +
      '<button type="submit" class="btn btn-primary mt6"' + (b ? ' disabled' : '') + '>' + (b === 'login' ? 'Signing in…' : 'Sign in') + '</button>' +
      '<button type="button" class="link mt4" style="display:block;width:100%" data-act="toForgot"' + (b ? ' disabled' : '') + '>Forgot PIN?</button>' +
      '<button type="button" class="link mt2" style="display:block;width:100%" data-act="toActivate"' + (b ? ' disabled' : '') + '>First time? Create your account</button>' +
      '</form></main>';
  }
  // 2026-10-25: Forgot PIN. The reset code is emailed; the participant then sets a new PIN on the activate screen.
  function renderForgot() {
    var b = S.busy;
    return '<main class="center-screen"><form class="card-xl" data-form="forgot">' + brand('') +
      '<h1 class="title mt6">Forgot your PIN?</h1><p class="small muted mt3">Enter your participant code. We\u2019ll email you a 6-digit PIN reset code. Your old PIN keeps working until you set a new one.</p>' +
      '<label class="field mt8">Participant code<input id="code" class="input" data-model="code" value="' + esc(S.code) + '" autocomplete="username" enterkeyhint="go"></label>' +
      alertHtml(S.error) +
      '<button type="submit" class="btn btn-primary mt6"' + (b ? ' disabled' : '') + '>' + (b === 'forgot' ? 'Sending…' : 'Email me a reset code') + '</button>' +
      '<button type="button" class="link mt4" style="display:block;width:100%" data-act="toReset"' + (b ? ' disabled' : '') + '>I have a code</button>' +
      '<button type="button" class="link mt2" style="display:block;width:100%" data-act="toLogin"' + (b ? ' disabled' : '') + '>Back to sign in</button>' +
      '<p class="xs muted mt4" style="text-align:center">No email on file? Ask FCCP staff to reset your PIN.</p>' +
      '</form></main>';
  }
  function doForgot() {
    S.error = '';
    var code = S.code.trim();
    if (!code) { S.error = 'Enter your participant code.'; return render(); }
    S.busy = 'forgot'; render();
    api({ action: 'forgotPin', participantCode: code }).then(function (x) {
      if (!x.resp.ok || x.r.ok !== true) { S.error = errText(x.r, 'Unable to send a reset code. Please ask FCCP staff.'); return; }
      S.notice = x.r.message || 'Check your email for a PIN reset code.';
      S.reset = true; S.activation = ''; S.pin = ''; S.pin2 = ''; S.view = 'activate';
    }).catch(function (e) { S.error = e.message || 'Unable to send a reset code. Please ask FCCP staff.'; })
      .finally(function () { if (S.busy === 'forgot') S.busy = ''; render(); });
  }
  function renderActivate() {
    var b = S.busy, rs = S.reset;
    return '<main class="center-screen"><section class="split"><div class="split-left">' +
      '<div style="display:flex;align-items:center;gap:12px;margin-bottom:56px"><div class="brand-mark big">' + logoHtml() + '</div><div><p class="small strong" style="letter-spacing:.18em">FCCP</p><p class="xs" style="color:#d4d1ea">WEX TIMEKEEPING</p></div></div>' +
      '<p class="small strong" style="text-transform:uppercase;letter-spacing:.16em;color:var(--brand-green)">Participant setup</p>' +
      '<h1 class="mt4" style="font-size:36px;font-weight:600;line-height:1.15">' + (rs ? 'Reset your PIN.' : 'Create your private PIN.') + '</h1>' +
      '<p class="mt5" style="color:#e4e2f2;line-height:1.75">' + (rs ? 'Use your participant code and the PIN reset code we emailed you.' : 'Use the participant code and one-time activation code provided by FCCP.') + ' Your PIN is private—FCCP staff cannot see it.</p></div>' +
      '<div class="split-right"><p class="small strong green">' + (rs ? 'Forgot PIN' : 'First-time access') + '</p><h2 class="mt2" style="font-size:24px;font-weight:600">' + (rs ? 'Set a new PIN' : 'Activate your account') + '</h2>' +
      (rs && S.notice ? '<p class="info-note">' + esc(S.notice) + '</p>' : '') + (rs ? '' : installCard(false)) +
      '<form data-form="activate" class="mt4">' +
      '<label class="field">Participant code<input id="code" class="input" data-model="code" value="' + esc(S.code) + '" placeholder="Participant code" autocomplete="username"></label>' +
      '<label class="field">' + (rs ? 'PIN reset code (from your email)' : 'One-time activation code') + '<input id="act" class="input" data-model="activation" value="' + esc(S.activation) + '" inputmode="numeric" maxlength="6" placeholder="Six digits" autocomplete="one-time-code"></label>' +
      '<label class="field">' + (rs ? 'New 4-digit PIN' : 'Create 4-digit PIN') + '<input id="pin" class="input pin" data-model="pin" value="' + esc(S.pin) + '" inputmode="numeric" maxlength="4" type="password" placeholder="••••" autocomplete="new-password"></label>' +
      '<label class="field">Confirm PIN<input id="pin2" class="input pin" data-model="pin2" value="' + esc(S.pin2) + '" inputmode="numeric" maxlength="4" type="password" placeholder="••••" autocomplete="new-password"></label>' +
      alertHtml(S.error) +
      '<button type="submit" class="btn btn-primary mt5"' + (b ? ' disabled' : '') + '>' + (b === 'activate' ? (rs ? 'Saving…' : 'Activating…') : (rs ? 'Save new PIN and continue' : 'Create PIN and continue')) + '</button>' +
      '<button type="button" class="link mt4" style="display:block;width:100%" data-act="toLogin"' + (b ? ' disabled' : '') + '>' + (rs ? 'Back to sign in' : 'Already activated? Sign in') + '</button>' +
      '</form></div></section></main>';
  }

  // ================================================================ home screen (2026-10-25 redesign)
  // Tabs: Clock | My Hours | Timecard | More. Colors carry meaning everywhere:
  //   green = done / good, amber = you need to do something, blue = information, red = problem.
  var ICON = {
    clock: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    hours: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="15" rx="2"/><path d="M8 3v4M16 3v4M4 10h16"/></svg>',
    card: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 14l2 2 4-4"/></svg>',
    more: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>'
  };
  var TABS = [['clock', 'Clock'], ['hours', 'My Hours'], ['timecard', 'Timecard'], ['more', 'More']];
  function nowMinutes() { var d = new Date(); return d.getHours() * 60 + d.getMinutes(); }
  function elapsedText(fromHHmm) {
    var t = to24(fromHHmm); if (!t) return '';
    var m = nowMinutes() - mins(t); if (m < 0) m += 1440;
    return m < 60 ? m + ' min' : Math.floor(m / 60) + ' hr ' + (m % 60) + ' min';
  }
  function openShiftToday() {
    var t = (S.status && S.status.today) || [];
    for (var i = t.length - 1; i >= 0; i--) if (/^(open|lunch)$/i.test(String(t[i].status || ''))) return t[i];
    return null;
  }
  function liveShifts() { return S.shifts.filter(function (e) { return !isSuperseded(e); }); }
  function currentPeriod() { return S.shiftsPeriod || (S.status && S.status.payPeriod) || {}; }
  function forgotClockOut() {
    var today = todayKey();
    return liveShifts().filter(function (e) { return /^(open|lunch)$/i.test(String(e.status || '')) && String(e.workDate) < today; })
      .sort(function (a, b) { return dayNum(a.workDate) - dayNum(b.workDate); })[0] || null;
  }
  function unsignedPast() {
    return (S.past || []).filter(function (t) { return (t.status === 'Not submitted' || t.status === 'Reopened') && t.shiftCount > 0; })
      .sort(function (a, b) { return dayNum(b.start) - dayNum(a.start); })[0] || null;
  }
  function heldCount() { return liveShifts().filter(function (e) { return String(e.sheetTab || '') === 'PENDING'; }).length; }

  // 2026-10-25: earlier pay periods (from the start date) that FCCP has not finalized yet.
  function openEarlier() {
    var cur = (S.status && S.status.payPeriod) || {}, list = (S.status && S.status.openPeriods) || [];
    return list.filter(function (p) { return p && p.start && (!cur.start || dayNum(p.start) < dayNum(cur.start)); })
      .sort(function (a, b) { return dayNum(a.start) - dayNum(b.start); });
  }
  function firstAddDate(p) { var sd = S.status && S.status.startDate; return sd && dayNum(sd) > dayNum(p.start) ? sd : p.start; }
  function shiftsIn(p) { return liveShifts().filter(function (e) { return dayNum(e.workDate) >= dayNum(p.start) && dayNum(e.workDate) <= dayNum(p.end); }); }
  function earlyKey() { return 'wexNoEarlier_' + ((S.participant && S.participant.code) || ''); }
  function earlyPrompt() {
    if (!S.shiftsLoaded) return null;
    var list = openEarlier(); if (!list.length) return null;
    if (list.some(function (p) { return shiftsIn(p).length; })) return null;
    if (sGet('localStorage', earlyKey()) === 'yes') return null;
    return list[0];
  }

  // 4. one plain sentence: what to do next
  function nextStep() {
    var st = S.status || {}, bal = st.balances || {}, tc = st.timecard || {}, closed = isClosed();
    var meal = typeof st.mealWarning === 'string' ? st.mealWarning.toUpperCase() : String((st.mealWarning && (st.mealWarning.code || st.mealWarning.type)) || '').toUpperCase();
    var forgot = forgotClockOut(), unsigned = unsignedPast(), pp = st.payPeriod || {};
    if (!S.statusLoaded) return null;
    if (bal.hoursRemaining != null && Number(bal.hoursRemaining) === 0) return { tone: 'red', text: 'You have no WEX hours left. Talk to FCCP staff before you work again.' };
    if (meal === 'TAKE_LUNCH_NOW') return { tone: 'red', text: 'Take your lunch now. Tap Start Lunch.' };
    if (forgot) return { tone: 'amber', text: 'You forgot to clock out on ' + fmtShort(forgot.workDate) + '. Tap here to add your clock-out time.', edit: forgot.punchId };
    if (tc.status === 'Reopened') return { tone: 'amber', text: 'FCCP reopened your timecard. Tap here to review and sign it again.', tab: 'timecard' };
    if (unsigned && !closed) return { tone: 'amber', text: 'Your timecard for ' + fmtMDY(unsigned.start) + ' to ' + fmtMDY(unsigned.end) + ' still needs your signature. Tap here.', tab: 'timecard' };
    if (meal === 'LUNCH_DUE_SOON') return { tone: 'amber', text: 'Lunch is due soon. Start a 30-minute lunch before you reach 5 hours.' };
    var early = earlyPrompt();
    if (early) return { tone: 'blue', text: 'You started ' + fmtShort(st.startDate || early.start) + '. Did you work any days before you got the app? Tap here to add them.', missed: firstAddDate(early), dismiss: true };
    if (closed) return { tone: 'green', text: 'Your timecard is signed. You’re all set for this pay period.' };
    if (pp.end && todayKey() === pp.end) return { tone: 'amber', text: 'Today is the last day of this pay period. Sign your timecard after your last shift.', tab: 'timecard' };
    if (heldCount()) return { tone: 'blue', text: heldCount() + ' of your shifts ' + (heldCount() === 1 ? 'is' : 'are') + ' waiting to go on your timesheet. FCCP will add ' + (heldCount() === 1 ? 'it' : 'them') + '.', tab: 'hours' };
    if (bal.hoursRemaining != null && Number(bal.hoursRemaining) < 8) return { tone: 'amber', text: 'You have only ' + hrs(bal.hoursRemaining) + ' WEX hours left.' };
    var state = String(st.state || '').toUpperCase();
    if (state === 'OPEN') return { tone: 'green', text: 'You’re clocked in. Working over 5 hours? Take a 30-minute lunch.' };
    if (state === 'LUNCH') return { tone: 'blue', text: 'Enjoy your lunch. Tap End Lunch when you’re back.' };
    if (!S.shiftsLoaded) return null; // 2026-10-25: don't say "All set" before the shifts have loaded
    return { tone: 'green', text: 'All set ✓' };
  }
  function nextStepHtml() {
    var n = nextStep(); if (!n) return '';
    var icon = { green: '✓', amber: '!', blue: 'i', red: '!' }[n.tone];
    var attrs = n.missed ? ' data-act="missedFrom" data-date="' + esc(n.missed) + '" role="button" tabindex="0"' : n.edit ? ' data-edit="' + esc(n.edit) + '" role="button" tabindex="0"' : n.tab ? ' data-tab="' + n.tab + '" role="button" tabindex="0"' : '';
    return '<div class="next tone-' + n.tone + (attrs ? ' tappable' : '') + '"' + attrs + '><span class="next-icon" aria-hidden="true">' + icon + '</span><p><span class="sr-only">Next step: </span>' + esc(n.text) + (n.dismiss ? '<br><button type="button" class="link xs mt1" data-act="noEarlier">I didn’t work any days before</button>' : '') + '</p>' + (attrs ? '<span class="next-go" aria-hidden="true">›</span>' : '') + '</div>';
  }

  function renderHome() {
    var p = S.participant || {}, b = S.busy;
    var tab = S.tab || 'clock';
    var h = '<header class="topbar"><div class="topbar-inner">' + brand(esc(p.name || 'Participant timekeeping')) +
      '<button class="link" data-act="logout"' + (b ? ' disabled' : '') + '>' + (b === 'logout' ? 'Signing out…' : 'Sign out') + '</button></div></header>';
    h += '<div class="wrap with-tabs">' + nextStepHtml();
    if (false) {
      h += '<section class="section tone-blue-soft"><p class="h3">Sign in faster next time</p><p class="small muted mt1">Use your phone’s Face ID or fingerprint instead of typing your PIN.</p>' +
        '<div class="btn-row"><button class="btn" data-act="notNow"' + (b ? ' disabled' : '') + '>Not now</button><button class="btn btn-primary" data-act="enroll"' + (b ? ' disabled' : '') + '>' + (b === 'deviceEnroll' ? 'Setting up…' : 'Turn it on') + '</button></div>' + alertHtml(S.bioMsg) + '</section>';
    } else if (S.bioMsg && tab !== 'more') h += alertHtml(S.bioMsg);
    if (tab === 'clock') h += renderClockTab();
    else if (tab === 'hours') h += renderHoursTab();
    else if (tab === 'timecard') h += renderTimecardTab();
    else h += renderMoreTab();
    h += '</div>';
    h += '<nav class="tabbar" aria-label="Sections">' + TABS.map(function (t) {
      var icon = ICON[t[0] === 'timecard' ? 'card' : t[0]];
      return '<button class="tab tab-' + t[0] + (tab === t[0] ? ' active' : '') + '" data-tab="' + t[0] + '"' + (tab === t[0] ? ' aria-current="page"' : '') + '>' + icon + '<span>' + t[1] + '</span>' + (t[0] === 'timecard' && tabBadge() ? '<i class="badge" aria-label="needs attention"></i>' : '') + '</button>';
    }).join('') + '</nav>';
    if (S.toast) h += '<div class="toast" role="status">' + esc(S.toast) + '</div>';
    if (S.guide != null) h += renderGuide();
    return '<main>' + h + '</main>';
  }
  function tabBadge() { var tc = (S.status && S.status.timecard) || {}; return !isClosed() && (tc.status === 'Reopened' || !!unsignedPast()); }

  // 1. the status card with the one big button
  function renderClockTab() {
    var st = S.status || {}, bal = st.balances || {}, b = S.busy, closed = isClosed(), acts = allowed();
    var state = String(st.state || '').toUpperCase(), open = openShiftToday();
    var h = '';
    if (!S.statusLoaded) {
      h += '<section class="status-card tone-gray"><p class="status-title">' + (S.statusFailed ? 'Your status didn’t load.' : 'Loading your status…') + '</p>' + alertHtml(S.error) +
        (S.statusFailed ? '<button class="btn mt4" data-act="retry"' + (b ? ' disabled' : '') + '>' + (b === 'status' ? 'Trying again…' : 'Try again') + '</button>' : '') + '</section>';
    } else if (closed) {
      h += '<section class="status-card tone-green"><p class="status-title">Timecard signed ✓</p><p class="status-sub">Clock-ins for this pay period are closed. Contact FCCP staff if something needs to change.</p></section>';
    } else if (state === 'LUNCH') {
      var lunchFrom = (open && open.lunchOut) || st.sinceTime;
      h += '<section class="status-card tone-amber"><p class="status-label">On lunch</p><p class="status-title">' + (lunchFrom ? 'Since ' + fmtTime(lunchFrom) : 'Lunch started') + '</p>' +
        (lunchFrom ? '<p class="status-sub">' + elapsedText(lunchFrom) + ' so far · a full lunch is 30 minutes</p>' : '') +
        '<button class="btn btn-big btn-amber mt4" data-punch="END_LUNCH"' + (b ? ' disabled' : '') + '>' + (b === 'punch' ? 'Saving…' : 'End Lunch') + '</button></section>';
    } else if (state === 'OPEN') {
      var from = (open && open.startTime) || st.sinceTime;
      h += '<section class="status-card tone-working"><p class="status-label">You’re working</p><p class="status-title">' + (from ? 'Since ' + fmtTime(from) : 'Clocked in') + '</p>' +
        (from ? '<p class="status-sub">' + elapsedText(from) + ' so far today</p>' : '') +
        '<button class="btn btn-big btn-red mt4" data-punch="CLOCK_OUT"' + (b ? ' disabled' : '') + '>' + (b === 'punch' ? 'Saving…' : 'Clock Out') + '</button>' +
        (acts.indexOf('START_LUNCH') >= 0 ? '<button class="btn btn-amber-outline mt3" data-punch="START_LUNCH"' + (b ? ' disabled' : '') + '>Start Lunch</button>' : '') + '</section>';
    } else {
      h += '<section class="status-card tone-off"><p class="status-label">You’re off the clock</p><p class="status-title">' + esc(new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'short', day: 'numeric' }).format(new Date())) + '</p>' +
        (acts.indexOf('CLOCK_IN') >= 0 ? '<button class="btn btn-big btn-go mt4" data-punch="CLOCK_IN"' + (b ? ' disabled' : '') + '>' + (b === 'punch' ? 'Saving…' : 'Clock In') + '</button>' : '<p class="status-sub mt3">No action is available right now.</p>') + '</section>';
    }
    if (S.statusLoaded) h += alertHtml(S.error);
    if (S.offerBio) {
      h += '<section class="section tone-blue-soft"><p class="h3">Sign in faster next time</p><p class="small muted mt1">Use your phone’s Face ID or fingerprint instead of typing your PIN.</p>' +
        '<div class="btn-row"><button class="btn" data-act="notNow"' + (b ? ' disabled' : '') + '>Not now</button><button class="btn btn-primary" data-act="enroll"' + (b ? ' disabled' : '') + '>' + (b === 'deviceEnroll' ? 'Setting up…' : 'Turn it on') + '</button></div>' + alertHtml(S.bioMsg) + '</section>';
    }
    // today (hidden when empty)
    var today = st.today || [];
    if (today.length) {
      h += '<section class="section"><h2 class="h3">Today</h2>' + today.map(function (e) { return shiftRow(e, false, true); }).join('') + '</section>';
    }
    // balances (blue = information)
    h += '<div class="tiles">' +
      '<div class="tile tone-blue-soft"><p class="tile-label">WEX hours left</p><p class="big-num">' + (hrs(bal.hoursRemaining) || '—') + '</p><p class="xs muted">of ' + (hrs(bal.hourLimit) || '—') + ' program hours</p></div>' +
      '<div class="tile tone-blue-soft"><p class="tile-label">Sick time</p><p class="big-num">' + (hrs(bal.sickAvailable) || '—') + '</p><p class="xs muted">hours available</p></div></div>';
    return h;
  }

  // compact one-line shift with details on tap (5)
  function shiftRow(e, allowEdit, isToday) {
    var st = String(e.status || '');
    var notOut = /^(open|lunch)$/i.test(st), held = String(e.sheetTab || '') === 'PENDING', meal = hasMealPremium(e);
    var badge = notOut ? (isToday ? '<span class="pill pill-green">In progress</span>' : '<span class="pill pill-amber">! Not clocked out</span>')
      : held ? '<span class="pill pill-blue">Waiting to be added</span>' : '<span class="pill pill-green">✓</span>';
    var timeText = fmtTime(e.startTime) + ' – ' + (e.endTime ? fmtTime(e.endTime) : '…');
    var canEdit = allowEdit && e.editable === true && S.statusLoaded && !isClosed() && e.punchId;
    var h = '<details data-key="s-' + esc(e.punchId || e.workDate + e.startTime) + '" class="srow' + (notOut && !isToday ? ' srow-amber' : '') + '"><summary><span class="srow-day">' + esc(isToday ? 'Today' : fmtShort(e.workDate)) + '</span>' +
      '<span class="srow-time">' + timeText + '</span><span class="srow-hrs">' + (e.endTime ? (hrs(e.hours) || '0.00') + ' hr' : '') + '</span>' + badge + '</summary><div class="srow-body">' +
      '<dl class="times"><div><dt>Clock In</dt><dd>' + fmtTime(e.startTime) + '</dd></div><div><dt>Clock Out</dt><dd>' + (e.endTime ? fmtTime(e.endTime) : 'Not yet') + '</dd></div>' +
      '<div><dt>Lunch</dt><dd>' + (e.lunchOut ? fmtTime(e.lunchOut) + ' – ' + (e.lunchIn ? fmtTime(e.lunchIn) : '…') : 'None') + '</dd></div><div><dt>Type</dt><dd>' + esc(typeLabel(e.type) || 'Regular') + '</dd></div></dl>' +
      mealChip(e) +
      (held ? '<p class="info-note">This shift is saved. FCCP will add it to the right timesheet.</p>' : '') +
      (e.corrected === true ? '<p class="xs muted mt2">Corrected</p>' : e.manuallyAdded === true ? '<p class="xs muted mt2">Added as a missed shift</p>' : '') +
      (canEdit ? '<button class="btn mt3" data-edit="' + esc(e.punchId) + '">' + (e.endTime ? 'Edit this shift' : 'Add clock-out time') + '</button>' : '') +
      '</div></details>';
    if (meal) h = h.replace('<span class="srow-hrs">', '<span class="srow-hrs">★ ');
    return h;
  }

  // 6. My Hours: pay period total, compact list, earlier unfinalized shifts
  function renderHoursTab() {
    var cur = currentPeriod(), closed = isClosed();
    var h = '<section class="section tone-hours"><p class="eyebrow">This pay period (today)</p><p class="h2 mt1">' + esc(fmtMDY(cur.start)) + ' to ' + esc(fmtMDY(cur.end)) + '</p>';
    if (S.shiftsError) return h + alertHtml(S.shiftsError) + '</section>';
    if (!S.shiftsLoaded) return h + '<p class="small muted mt3">Loading your shifts…</p></section>';
    var list = liveShifts().sort(function (a, b) { return dayNum(b.workDate) - dayNum(a.workDate) || to24(b.startTime).localeCompare(to24(a.startTime)); });
    var startNum = dayNum(cur.start);
    var current = list.filter(function (e) { return !startNum || dayNum(e.workDate) >= startNum; });
    var opens = openEarlier();
    var earlier = list.filter(function (e) { return startNum && dayNum(e.workDate) < startNum && !opens.some(function (p) { return dayNum(e.workDate) >= dayNum(p.start) && dayNum(e.workDate) <= dayNum(p.end); }); });
    var earlyHtml = opens.map(function (p) {
      var sh = shiftsIn(p).sort(function (a, b) { return dayNum(b.workDate) - dayNum(a.workDate) || to24(b.startTime).localeCompare(to24(a.startTime)); });
      var tot = sh.reduce(function (n, e) { return n + (e.endTime ? Number(e.hours || 0) : 0); }, 0);
      return '<section class="section tone-amber-soft"><p class="eyebrow">Earlier pay period · still open</p><p class="h2 mt1">' + esc(fmtMDY(p.start)) + ' to ' + esc(fmtMDY(p.end)) + '</p>' +
        '<p class="small muted mt1">' + (sh.length ? tot.toFixed(2) + ' hours · ' + sh.length + ' shift' + (sh.length === 1 ? '' : 's') + '. Missing a day? Add it below.' : 'No shifts yet. Did you work any of these days? Add them here.') + '</p>' +
        '<button class="btn btn-go mt3" data-act="missedFrom" data-date="' + esc(firstAddDate(p)) + '">+ Add a shift for these dates</button>' +
        sh.map(function (e) { return shiftRow(e, true, false); }).join('') + '</section>';
    }).join('');
    var total = current.reduce(function (n, e) { return n + (e.endTime ? Number(e.hours || 0) : 0); }, 0);
    var days = {}; current.forEach(function (e) { days[e.workDate] = 1; });
    var meals = current.filter(hasMealPremium).length;
    if (earlyHtml) h = earlyHtml + h;
    h += '<div class="total-row"><div><p class="big-num">' + total.toFixed(2) + '</p><p class="xs muted">hours worked</p></div><div><p class="big-num">' + Object.keys(days).length + '</p><p class="xs muted">days</p></div>' +
      (meals ? '<div><p class="big-num">+' + meals + '</p><p class="xs muted">meal premium hr</p></div>' : '') + '</div>';
    h += '<button class="btn btn-go mt4" data-act="missed"' + (!S.statusLoaded || closed ? ' disabled' : '') + '>+ Add Missed Shift</button>';
    h += '<p class="xs muted mt2">Worked a day without clocking in, including days before you had the app? Add it here.</p></section>';
    h += '<section class="section">' + (current.length ? current.map(function (e) { return shiftRow(e, true, false); }).join('') : '<p class="small muted">No shifts yet this pay period.</p>') + '</section>';
    if (earlier.length) {
      h += '<section class="section tone-amber-soft"><h2 class="h3">Earlier pay period – not finalized yet</h2><p class="small muted mt1">FCCP hasn’t finalized these yet, so you can still fix them.</p>' +
        earlier.map(function (e) { return shiftRow(e, true, false); }).join('') + '</section>';
    }
    h += '<p class="xs muted legend"><span class="pill pill-green">✓</span> saved · <span class="pill pill-amber">!</span> needs fixing · <span class="pill pill-blue">i</span> waiting · ★ meal premium</p>';
    return h;
  }

  // 7. Timecard: steps Review -> Sign -> Done, reminder, past timecards
  function stepsHtml(active) {
    return '<ol class="steps">' + ['Review', 'Sign', 'Done'].map(function (s, i) {
      return '<li class="' + (i < active ? 'done' : i === active ? 'now' : '') + '"><span>' + (i < active ? '✓' : i + 1) + '</span>' + s + '</li>';
    }).join('') + '</ol>';
  }
  function renderTimecardTab() {
    var st = S.status || {}, tc = st.timecard || {}, closed = isClosed();
    var h = '<section class="section tone-card">';
    if (tc.status === 'Reopened') h += '<div class="callout tone-amber"><p class="strong">FCCP reopened your timecard</p><p class="small mt1">Check your shifts, fix anything needed, and sign it again.</p>' + (tc.reopenReason ? '<p class="small mt2"><b>Reason:</b> ' + esc(tc.reopenReason) + '</p>' : '') + '</div>';
    if (closed) {
      h += stepsHtml(3) + '<div class="callout tone-green"><p class="strong">Signed ✓</p>' + (tc.submittedAt ? '<p class="small mt1">Submitted ' + esc(fmtStamp(tc.submittedAt)) + '</p>' : '') + '<p class="small mt1">Your timecard is closed for this pay period. Contact FCCP staff if a correction is needed.</p></div>';
    } else {
      h += '<h2 class="h2">Sign your timecard</h2><p class="small muted mt1">Do this after your last shift of the pay period.</p>' + stepsHtml(0) +
        '<button class="btn btn-go btn-big mt4" data-act="submit"' + (!S.statusLoaded ? ' disabled' : '') + '>Review &amp; Sign</button>' +
        '<p class="xs muted mt2" style="text-align:center">After you sign, you can’t change this pay period unless FCCP reopens it.</p>';
    }
    h += '</section>';
    h += '<section class="section"><h2 class="h3">Past timecards</h2>';
    if (!S.pastLoaded) h += '<p class="small muted mt3">Checking earlier pay periods…</p>';
    else if (S.pastError) h += alertHtml(S.pastError);
    else if (!S.past.length) h += '<p class="small muted mt3">No earlier timecards yet.</p>';
    else S.past.forEach(function (t) {
      var fin = t.status === 'Manager Finalized', sub = ['Submitted', 'Needs Re-signature'].indexOf(t.status) >= 0, re = t.status === 'Reopened';
      var txt = fin ? '✓ Finalized by FCCP' : sub ? '✓ Signed' : re ? '! Reopened – sign again' : '! Not signed';
      var cls = fin || sub ? 'pill-green' : 'pill-amber';
      h += '<details data-key="p-' + esc(t.start) + '" class="past"><summary><div class="row-between" style="align-items:center"><div><p class="strong">' + esc(fmtMDY(t.start)) + ' to ' + esc(fmtMDY(t.end)) + '</p>' +
        '<p class="small muted mt1">' + t.shiftCount + ' ' + (t.shiftCount === 1 ? 'shift' : 'shifts') + ' · ' + (hrs(t.totalHours) || '0.00') + ' hours</p></div><span class="pill ' + cls + '">' + txt + '</span></div></summary>' +
        (t.submittedAt ? '<p class="small muted mt3">Signed ' + esc(fmtStamp(t.submittedAt)) + '</p>' : '');
      if ((t.shifts || []).length) t.shifts.forEach(function (s) {
        h += '<div class="past-shift"><p class="strong">' + esc(fmtShort(s.workDate)) + '</p><p class="small mt1">' + fmtTime(s.startTime) + ' – ' + fmtTime(s.endTime) + ' · ' + (hrs(s.hours != null ? s.hours : s.workedHours) || '—') + ' hr · ' + esc(typeLabel(s.type) || 'Regular') + '</p></div>';
      });
      else h += '<p class="small muted mt3">No saved shifts for this period.</p>';
      h += '</details>';
    });
    return h + '</section>';
  }

  // More: sick time, program hours, device sign-in, help
  function renderMoreTab() {
    var st = S.status || {}, bal = st.balances || {}, b = S.busy, closed = isClosed();
    var sickAvail = Number(bal.sickAvailable);
    var h = '<section class="section tone-blue-soft"><h2 class="h3">Your WEX hours</h2><div class="total-row"><div><p class="big-num">' + (hrs(bal.hoursRemaining) || '—') + '</p><p class="xs muted">hours left</p></div><div><p class="big-num">' + (hrs(bal.hourLimit) || '—') + '</p><p class="xs muted">program limit</p></div></div>' +
      '<p class="xs muted mt2">Regular time, sick time and meal premiums all count toward the limit.</p></section>';
    h += '<section class="section"><h2 class="h3">Sick time</h2><p class="mt1"><span class="big-num">' + (hrs(bal.sickAvailable) || '0.00') + '</span> <span class="small muted">hours available</span></p>';
    if (sickAvail > 0) h += '<button class="btn btn-go mt3" data-act="sick"' + (!S.statusLoaded || closed ? ' disabled' : '') + '>Request Sick Time</button>';
    else h += '<p class="info-note">You earn 1 hour of sick time for every 30 hours you work. When you have some, you can request it here.</p>';
    if (S.sickError) h += alertHtml(S.sickError);
    else if (S.sick.length) {
      h += '<h3 class="small strong mt4">Your requests</h3>';
      S.sick.forEach(function (r) {
        var s = String(r.status || 'Pending').toUpperCase(), cls = s === 'APPROVED' ? 'pill-green' : s === 'DENIED' ? 'pill-red' : 'pill-amber';
        h += '<div class="past-shift row-between" style="align-items:center"><div><p class="strong">' + esc(fmtShort(r.workDate)) + '</p><p class="small mt1">' + fmtTime(r.startTime) + ' – ' + fmtTime(r.endTime) + ' · ' + (hrs(r.requestedHours != null ? r.requestedHours : r.hours) || '—') + ' hr</p>' +
          (r.reviewNote ? '<p class="xs muted mt1">' + esc(r.reviewNote) + '</p>' : '') + '</div><span class="pill ' + cls + '">' + s.charAt(0) + s.slice(1).toLowerCase() + '</span></div>';
      });
    }
    h += '</section>';
    h += '<section class="section"><h2 class="h3">This phone</h2>';
    if (S.bioSaved) h += '<p class="small muted mt1">Face ID / fingerprint sign-in is on.</p><button class="link mt3" data-act="revoke"' + (b ? ' disabled' : '') + '>' + (b === 'deviceRevoke' ? 'Turning off…' : 'Turn off Face ID / fingerprint') + '</button>';
    else if (S.bioAvailable) h += '<p class="small muted mt1">Sign in with Face ID or fingerprint instead of your PIN.</p><button class="btn mt3" data-act="enroll"' + (b ? ' disabled' : '') + '>' + (b === 'deviceEnroll' ? 'Setting up…' : 'Turn on Face ID / fingerprint') + '</button>';
    else h += '<p class="small muted mt1">Face ID / fingerprint sign-in isn’t available in this browser.</p>';
    h += alertHtml(S.bioMsg) + '</section>';
    var ic = installCard(true); if (ic) h += '<section class="section">' + ic + '</section>';
    h += '<section class="section"><h2 class="h3">Help</h2><button class="btn mt3" data-act="guide">How to use this app</button>' +
      '<button class="btn mt3" data-act="logout"' + (b ? ' disabled' : '') + '>Sign out</button></section>';
    return h;
  }

  // 9. first-time guide
  var GUIDE = [
    ['Clock in and out', 'Tap the green Clock In button when you start work. Tap Clock Out when you finish.'],
    ['Take your lunch', 'Working more than 5 hours? Take a 30-minute lunch. Tap Start Lunch when you leave and End Lunch when you’re back.'],
    ['Forgot to punch?', 'Open My Hours and tap Add Missed Shift, or tap a shift to fix it.'],
    ['Sign your timecard', 'After your last shift of the pay period, open Timecard and tap Review & Sign.']
  ];
  function renderGuide() {
    var i = S.guide, g = GUIDE[i];
    return '<div class="overlay"><section role="dialog" aria-modal="true" class="dialog guide"><p class="xs muted">' + (i + 1) + ' of ' + GUIDE.length + '</p>' +
      '<h2 class="title mt2" style="font-size:24px">' + esc(g[0]) + '</h2><p class="mt3">' + esc(g[1]) + '</p>' +
      '<div class="dots">' + GUIDE.map(function (x, k) { return '<i class="' + (k === i ? 'on' : '') + '"></i>'; }).join('') + '</div>' +
      '<div class="btn-row"><button class="btn" data-act="' + (i > 0 ? 'guideBack' : 'guideSkip') + '">' + (i > 0 ? 'Back' : 'Skip') + '</button><button class="btn btn-primary" data-act="guideNext">' + (i === GUIDE.length - 1 ? 'Got it' : 'Next') + '</button></div></section></div>';
  }

  // ---------------------------------------------------------------- modals render
  function renderModal() {
    var m = S.modal; if (!m) return '';
    var inner = m.kind === 'sick' ? sickHtml(m) : m.kind === 'missed' ? missedHtml(m) : m.kind === 'edit' ? editHtml(m) : submitHtml(m);
    return '<div class="overlay" data-overlay="1"><section role="dialog" aria-modal="true" class="dialog' + (m.kind === 'submit' ? ' wide' : '') + '">' + inner + '</section></div>';
  }
  function reasonSelect(list, value, label) {
    return '<label class="field">' + label + '<select class="select" data-mfield="reason"><option value="" disabled' + (value ? '' : ' selected') + '>Select a reason</option>' +
      list.map(function (r) { return '<option' + (r === value ? ' selected' : '') + '>' + r + '</option>'; }).join('') + '</select></label>';
  }
  function sickHtml(m) {
    var bal = (S.status && S.status.balances) || {};
    if (m.done) return '<div role="status" class="done"><p class="done-title">✓ Sick-time request submitted</p><p class="muted mt3">' + esc(m.doneText) + '</p></div>';
    return '<h2 class="title" style="font-size:24px">Request Sick Time</h2>' +
      '<div class="panel small mt4"><p>Available sick time: <b>' + (hrs(bal.sickAvailable) || '—') + ' hours</b></p><p class="mt1">WEX hours remaining: <b>' + (hrs(bal.hoursRemaining) || '—') + ' hours</b></p></div>' +
      '<label class="field">Date<input id="sickDate" type="date" class="input" data-mfield="date" value="' + esc(m.date) + '"></label>' +
      '<label class="field">Start Time' + timePicker(m.start, 'startTime', 'Start Time') + '</label>' +
      '<label class="field">End Time' + timePicker(m.end, 'endTime', 'End Time') + '</label>' +
      '<p class="panel small mt3">Requested sick time: ' + (hrs(workedHours(m.start, '', '', m.end)) || '0.00') + ' hours</p>' + alertHtml(m.err) +
      '<div class="btn-row"><button class="btn" data-act="closeModal"' + (m.busy ? ' disabled' : '') + '>Cancel</button><button class="btn btn-primary" data-act="sickSubmit"' + (m.busy ? ' disabled' : '') + '>' + (m.busy ? 'Submitting…' : 'Submit Sick Time Request') + '</button></div>';
  }
  function fieldsHtml(m) {
    return [['Clock In', 'startTime'], ['Lunch Out (optional)', 'lunchOut'], ['Lunch In (optional)', 'lunchIn'], ['Clock Out', 'endTime']].map(function (x) {
      return '<label class="field">' + x[0] + timePicker(m.f[x[1]], x[1], x[0].replace(' (optional)', '')) + '</label>';
    }).join('');
  }
  function missedHtml(m) {
    var f = m.f;
    if (m.step === 'done') return '<div role="status" class="done"><p class="done-title">✓ Missed shift saved</p><p class="muted mt3">' + esc(m.doneText) + '</p></div>';
    if (m.step === 'review') return '<h2 class="title" style="font-size:24px">Review shift to add</h2><div class="panel mt4"><p class="strong">' + esc(fmtLong(f.workDate)) + '</p>' +
      '<p class="mt2"><span class="green">Clock In:</span> ' + fmtTime(f.startTime) + '</p><p class="mt2"><span class="green">Lunch:</span> ' + (f.lunchOut ? fmtTime(f.lunchOut) + ' - ' + fmtTime(f.lunchIn) : 'No lunch entered') + '</p>' +
      '<p class="mt2"><span class="green">Clock Out:</span> ' + fmtTime(f.endTime) + '</p><p class="mt2"><span class="green">Worked hours:</span> ' + (hrs(workedHours(f.startTime, f.lunchOut, f.lunchIn, f.endTime)) || '—') + '</p>' +
      '<p class="mt2"><span class="green">Reason:</span> ' + esc(m.reason) + '</p>' + (m.reason === 'Other' ? '<p class="mt1">' + esc(m.details.trim()) + '</p>' : '') + '</div>' + alertHtml(m.err) +
      '<div class="btn-row"><button class="btn" data-act="backForm"' + (m.busy ? ' disabled' : '') + '>Go Back</button><button class="btn btn-primary" data-act="missedSubmit"' + (m.busy ? ' disabled' : '') + '>' + (m.busy ? 'Submitting…' : 'Add Missed Shift') + '</button></div>';
    return '<h2 class="title" style="font-size:24px">Add Missed Shift</h2><p class="small muted mt2">Use this only when you worked a shift but no punch was recorded for it.</p>' +
      '<label class="field">Work Date<input id="mDate" type="date" class="input" data-mfield="workDate" max="' + todayKey() + '" value="' + esc(f.workDate) + '"></label>' + fieldsHtml(m) +
      '<p class="xs muted mt2">Leave both lunch times blank if you did not take a lunch.</p>' + reasonSelect(ADD_REASONS, m.reason, 'Why are you adding this shift?') +
      (m.reason === 'Other' ? '<label class="field">Additional details *<textarea id="mDetails" class="textarea" rows="3" data-mfield="details">' + esc(m.details) + '</textarea></label>' : '') +
      '<p class="panel small mt4">Estimated worked hours: ' + (hrs(workedHours(f.startTime, f.lunchOut, f.lunchIn, f.endTime)) || '—') + '</p>' + alertHtml(m.err) +
      '<div class="btn-row"><button class="btn" data-act="closeModal">Cancel</button><button class="btn btn-primary" data-act="missedReview">Review Shift</button></div>';
  }
  function editHtml(m) {
    var s = m.shift, f = m.f;
    if (m.step === 'done') return '<div role="status" class="done"><p class="done-title">✓ Time correction saved</p><p class="muted mt3">' + esc(m.doneText) + '</p></div>';
    if (m.step === 'review') {
      var hadL = !!(s.lunchOut || s.lunchIn), hasL = !!(f.lunchOut || f.lunchIn), lunchChanged = to24(s.lunchOut) !== f.lunchOut || to24(s.lunchIn) !== f.lunchIn;
      return '<h2 class="title" style="font-size:24px">Review your correction</h2><p class="h2 mt3">' + esc(fmtLong(s.workDate)) + '</p><div class="panel mt5">' +
        '<p class="small green">Before</p><p class="h2 mt1">' + fmtTime(s.startTime) + ' - ' + fmtTime(s.endTime) + '</p>' +
        '<p class="small green mt4">After</p><p class="h2 mt1">' + fmtTime(f.startTime) + ' - ' + fmtTime(f.endTime) + '</p>' +
        (lunchChanged ? '<p class="small green mt4">Before lunch</p><p class="strong mt1">' + (hadL ? fmtTime(s.lunchOut) + ' - ' + fmtTime(s.lunchIn) : 'No lunch recorded') + '</p><p class="small green mt4">After lunch</p><p class="strong mt1">' + (hasL ? fmtTime(f.lunchOut) + ' - ' + fmtTime(f.lunchIn) : 'No lunch recorded') + '</p>' : '') +
        '<p class="small green mt4">Reason</p><p class="strong mt1">' + esc(m.reason) + '</p>' + (m.reason === 'Other' ? '<p class="small mt1">' + esc(m.details.trim()) + '</p>' : '') + '</div>' + alertHtml(m.err) +
        '<div class="btn-row"><button class="btn" data-act="backForm"' + (m.busy ? ' disabled' : '') + '>Go Back</button><button class="btn btn-primary" data-act="editSubmit"' + (m.busy ? ' disabled' : '') + '>' + (m.busy ? 'Submitting…' : 'Submit Correction') + '</button></div>';
    }
    return '<p class="title" style="font-size:24px">' + esc(fmtLong(s.workDate)) + '</p><h2 class="h2 mt2">' + (s.endTime ? 'Edit this shift' : 'Add the missing clock-out time') + '</h2>' +
      '<div class="panel mt5"><p class="small strong green">Current shift</p><p class="h2 mt1">' + fmtTime(s.startTime) + ' - ' + (s.endTime ? fmtTime(s.endTime) : 'not clocked out') + '</p>' +
      '<p class="small muted mt1">' + (s.lunchOut || s.lunchIn ? 'Lunch: ' + fmtTime(s.lunchOut) + ' - ' + fmtTime(s.lunchIn) : 'No lunch recorded') + '</p></div>' + fieldsHtml(m) +
      '<p class="xs muted mt2">Leave both blank if you did not take a lunch.</p>' + reasonSelect(EDIT_REASONS, m.reason, 'Why are you changing this? *') +
      (m.reason === 'Other' ? '<label class="field">Tell us what happened *<textarea id="eDetails" class="textarea" rows="3" data-mfield="details">' + esc(m.details) + '</textarea></label>' : '') + alertHtml(m.err) +
      '<div class="btn-row"><button class="btn" data-act="closeModal">Cancel</button><button class="btn btn-primary" data-act="editReview">Submit Time Correction</button></div>';
  }
  function submitHtml(m) {
    var rv = m.review, t = (rv && rv.totals) || {}, total = t.totalCountableHours != null ? t.totalCountableHours : t.countableHours != null ? t.countableHours : t.totalHours;
    var pp = (rv && rv.payPeriod) || (S.status && S.status.payPeriod) || {}, name = (rv && rv.participant && (rv.participant.name || rv.participant)) || (S.participant && S.participant.name) || '';
    if (m.step === 'done') return stepsHtml(3) + '<div role="status" class="done"><h2 class="title" style="font-size:24px">YOUR TIMECARD HAS BEEN SUBMITTED.</h2><p class="small muted mt3">Your timecard is closed. FCCP will reopen it if a correction is needed.</p></div>';
    if (m.step === 'sign') return stepsHtml(1) + '<h2 class="title" style="font-size:24px">Sign Your Timecard</h2><div class="panel small mt4"><p class="strong">' + esc(name) + '</p><p class="mt1">Pay period: ' + esc(fmtMDY(pp.start)) + ' to ' + esc(fmtMDY(pp.end)) + '</p>' +
      '<p class="mt1">Total countable hours: <b>' + (hrs(total) || '—') + '</b></p><p class="mt4">I certify that the time shown is complete and accurate and reflects all time I worked during this pay period. I understand that submitting this timecard closes my time for this pay period.</p></div>' +
      '<p class="xs muted mt4 turn-tip">Tip: turn your phone sideways for a bigger signing box.</p>' +
      '<canvas id="sig" class="sig" aria-label="Draw your signature"></canvas><button class="btn btn-inline mt3" data-act="clearSig">Clear Signature</button>' + alertHtml(m.err) +
      '<div class="btn-row" id="sigButtons">' + sigButtons(m) + '</div>';
    var h = stepsHtml(0) + '<h2 class="title" style="font-size:24px">Review your timecard</h2><div class="notice-gold"><p class="strong">Submitting closes this pay period. If a correction is needed, FCCP can reopen it; you will get a message to review and submit again.</p></div>';
    if (m.loading) h += '<p class="small muted mt5">Loading your pay-period review…</p>';
    else if (rv) {
      h += '<div class="panel mt5"><p class="strong">' + esc(name) + '</p><p class="small mt1">Pay period: ' + esc(fmtMDY(pp.start)) + ' to ' + esc(fmtMDY(pp.end)) + '</p><dl class="times">' +
        '<div><dt>Regular hours</dt><dd>' + (hrs(t.regularHours) || '—') + '</dd></div><div><dt>Sick hours</dt><dd>' + (hrs(t.sickHours) || '—') + '</dd></div>' +
        '<div><dt>Meal premium hours</dt><dd>' + (hrs(t.mealPremiumHours) || '—') + '</dd></div><div><dt>Total countable hours</dt><dd>' + (hrs(total) || '—') + '</dd></div></dl></div>' +
        '<h3 class="h2 mt5">Shifts this pay period</h3>';
      var sh = (rv.shifts || rv.completedShifts || []).slice().sort(function (a, b) { return dayNum(b.workDate) - dayNum(a.workDate) || to24(b.startTime).localeCompare(to24(a.startTime)); });
      if (!sh.length) h += '<p class="small muted mt2">No completed shifts were returned for this pay period.</p>';
      sh.forEach(function (e) {
        h += '<article class="shift"><p class="strong">' + esc(fmtShort(e.workDate)) + '</p><dl class="times"><div><dt>Clock In</dt><dd>' + fmtTime(e.startTime) + '</dd></div>' +
          (e.lunchOut || e.lunchIn ? '<div><dt>Lunch Out</dt><dd>' + fmtTime(e.lunchOut) + '</dd></div><div><dt>Lunch In</dt><dd>' + fmtTime(e.lunchIn) + '</dd></div>' : '') +
          '<div><dt>Clock Out</dt><dd>' + fmtTime(e.endTime) + '</dd></div><div><dt>Type</dt><dd>' + esc(typeLabel(e.type) || '—') + '</dd></div><div><dt>Worked hours</dt><dd>' + (hrs(e.hours != null ? e.hours : e.workedHours) || '—') + '</dd></div>' +
          (Number(e.mealPremiumHours) > 0 ? '<div><dt>Meal premium hours</dt><dd>' + hrs(e.mealPremiumHours) + '</dd></div>' : '') + '</dl></article>';
      });
      if (rv.canSubmit !== true) h += '<p role="alert" class="alert">' + (Number(rv.openShiftCount) > 0 ? 'Clock out before submitting your timecard.' : 'This timecard cannot be submitted yet. Contact FCCP staff.') + '</p>';
    }
    h += alertHtml(m.err);
    var can = rv && rv.canSubmit === true && !m.loading;
    h += '<label class="check"><input type="checkbox" data-mfield="c1"' + (m.c1 ? ' checked' : '') + (can ? '' : ' disabled') + '><span>I certify that the time shown is complete and accurate and reflects all time I worked during this pay period.</span></label>' +
      '<label class="check" style="margin-top:12px"><input type="checkbox" data-mfield="c2"' + (m.c2 ? ' checked' : '') + (can ? '' : ' disabled') + '><span>I understand that submitting this timecard closes my time for this pay period and I cannot add or change time unless FCCP staff reopens it.</span></label>' +
      '<div class="btn-row"><button class="btn" data-act="closeModal"' + (m.loading ? ' disabled' : '') + '>Cancel</button><button class="btn btn-primary" data-act="toSign"' + (can && m.c1 && m.c2 ? '' : ' disabled') + '>Continue to Signature</button></div>';
    return h;
  }
  function sigButtons(m) {
    return '<button class="btn" data-act="sigBack"' + (m.busy ? ' disabled' : '') + '>Go Back</button><button class="btn btn-primary" data-act="sigSubmit"' + (!m.signed || m.busy ? ' disabled' : '') + '>' + (m.busy ? 'Submitting signed timecard...' : 'Submit Signed Timecard') + '</button>';
  }
  function renderSubmitButtons() { var el = document.getElementById('sigButtons'); if (el && S.modal) el.innerHTML = sigButtons(S.modal); }

  // signature pad (kept across re-renders only while the sign step is shown)
  var sigState = { drawing: false, last: null, canvas: null };
  function setupSignature() {
    var c = document.getElementById('sig');
    if (!c) { sigState.canvas = null; return; }
    if (sigState.canvas === c) return;
    sigState.canvas = c;
    var dpr = window.devicePixelRatio || 1, r = c.getBoundingClientRect();
    c.width = Math.max(1, Math.floor(r.width * dpr)); c.height = Math.max(1, Math.floor(r.height * dpr));
    var ctx = c.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, r.width, r.height);
    ctx.strokeStyle = '#1b1464'; ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    // 2026-10-25: map the finger to the drawing using the box's current size (it changes when the phone turns).
    function pt(e) { var b = c.getBoundingClientRect(), d = window.devicePixelRatio || 1; return { x: (e.clientX - b.left) * (c.width / d) / (b.width || 1), y: (e.clientY - b.top) * (c.height / d) / (b.height || 1) }; }
    c.addEventListener('pointerdown', function (e) { e.preventDefault(); c.setPointerCapture(e.pointerId); var p = pt(e); sigState.drawing = true; sigState.last = p; ctx.fillStyle = '#1b1464'; ctx.beginPath(); ctx.arc(p.x, p.y, 1.5, 0, Math.PI * 2); ctx.fill(); if (S.modal && !S.modal.signed) { S.modal.signed = true; renderSubmitButtons(); } });
    c.addEventListener('pointermove', function (e) { if (!sigState.drawing) return; e.preventDefault(); var p = pt(e); ctx.beginPath(); ctx.moveTo(sigState.last.x, sigState.last.y); ctx.lineTo(p.x, p.y); ctx.stroke(); sigState.last = p; });
    function end(e) { if (!sigState.drawing) return; e.preventDefault(); sigState.drawing = false; sigState.last = null; try { c.releasePointerCapture(e.pointerId); } catch (x) {} }
    c.addEventListener('pointerup', end); c.addEventListener('pointercancel', end);
  }
  // 2026-10-25: when the phone turns, resize the signing box to its new shape and keep the signature.
  function refitSignature() {
    var c = sigState.canvas; if (!c || !document.body.contains(c)) return;
    var d = window.devicePixelRatio || 1, r = c.getBoundingClientRect();
    var w = Math.max(1, Math.floor(r.width * d)), h = Math.max(1, Math.floor(r.height * d));
    if (w === c.width && h === c.height) return;
    var old = document.createElement('canvas'); old.width = c.width; old.height = c.height; old.getContext('2d').drawImage(c, 0, 0);
    c.width = w; c.height = h;
    var ctx = c.getContext('2d'); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
    if (S.modal && S.modal.signed) { var k = Math.min(w / old.width, h / old.height); ctx.drawImage(old, (w - old.width * k) / 2, (h - old.height * k) / 2, old.width * k, old.height * k); }
    ctx.setTransform(d, 0, 0, d, 0, 0); ctx.strokeStyle = '#1b1464'; ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    try { c.scrollIntoView({ block: 'start' }); } catch (e) {}
  }
  var sigTurnTimer = null;
  function onTurn() { clearTimeout(sigTurnTimer); sigTurnTimer = setTimeout(refitSignature, 250); }
  window.addEventListener('resize', onTurn);
  window.addEventListener('orientationchange', onTurn);
  function clearSignature() {
    var c = document.getElementById('sig'); if (!c) return;
    var ctx = c.getContext('2d'), dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (S.modal) { S.modal.signed = false; S.modal.err = ''; renderSubmitButtons(); }
  }

  // ---------------------------------------------------------------- events
  app.addEventListener('input', function (e) {
    var t = e.target, model = t.getAttribute('data-model');
    if (model) {
      var v = t.value;
      if (model === 'pin' || model === 'pin2') v = v.replace(/\D/g, '').slice(0, 4);
      if (model === 'activation') v = v.replace(/\D/g, '').slice(0, 6);
      if (v !== t.value) t.value = v;
      S[model] = v;
      if (model === 'code') { S.bioSaved = null; refreshBio(v.trim()).then(function () { if (S.view === 'login' && !S.busy) render(); }); }
      return;
    }
    var mf = t.getAttribute('data-mfield');
    if (mf === 'details' && S.modal) { S.modal.details = t.value; }
  });
  app.addEventListener('change', function (e) {
    var t = e.target, m = S.modal;
    if (t.hasAttribute('data-time')) return onTimeChange(t);
    var mf = t.getAttribute('data-mfield'); if (!mf || !m) return;
    if (mf === 'date') m.date = t.value;
    else if (mf === 'workDate') m.f.workDate = t.value;
    else if (mf === 'reason') { m.reason = t.value; if (t.value !== 'Other') m.details = ''; }
    else if (mf === 'c1' || mf === 'c2') m[mf] = t.checked;
    else return;
    render();
  });
  app.addEventListener('submit', function (e) {
    e.preventDefault();
    if (S.busy) return;
    var f = e.target.getAttribute('data-form');
    if (f === 'login') doLogin(); else if (f === 'activate') doActivate(); else if (f === 'forgot') doForgot();
  });
  app.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    if (e.target.classList && e.target.classList.contains('tappable')) { e.preventDefault(); e.target.click(); return; }
    var id = e.target.id;
    var next = { code: S.view === 'activate' ? 'act' : 'pin', act: 'pin', pin: S.view === 'activate' ? 'pin2' : null };
    if (next[id] !== undefined && next[id] !== null) { e.preventDefault(); var n = document.getElementById(next[id]); if (n) n.focus(); }
  });
  app.addEventListener('mousedown', function (e) {
    if (e.target.getAttribute && e.target.getAttribute('data-overlay') && S.modal && !S.modal.busy && S.modal.kind !== 'sick' && S.modal.kind !== 'missed') { S.modal = null; render(); }
  });
  app.addEventListener('click', function (e) {
    var el = e.target.closest('[data-act],[data-punch],[data-edit],[data-tab]'); if (!el || el.disabled) return;
    if (el.hasAttribute('data-tab') && !el.hasAttribute('data-act')) { S.tab = el.getAttribute('data-tab'); sSet('sessionStorage', 'wexTab', S.tab); render(); window.scrollTo(0, 0); return; }
    if (el.hasAttribute('data-punch')) return doPunch(el.getAttribute('data-punch'));
    if (el.hasAttribute('data-edit')) return openEdit(el.getAttribute('data-edit'));
    var a = el.getAttribute('data-act'), m = S.modal;
    switch (a) {
      case 'toActivate': S.error = ''; S.pin = ''; S.reset = false; S.notice = ''; S.view = 'activate'; render(); break;
      case 'toForgot': S.error = ''; S.pin = ''; S.view = 'forgot'; render(); break;
      case 'toReset': S.error = ''; S.pin = ''; S.pin2 = ''; S.activation = ''; S.reset = true; S.notice = ''; S.view = 'activate'; render(); break;
      case 'toLogin': S.error = ''; S.pin = ''; S.pin2 = ''; S.reset = false; S.notice = ''; S.view = 'login'; refreshBio(S.code.trim()).then(render); render(); break;
      case 'otherParticipant': S.code = ''; S.error = ''; S.bioMsg = ''; S.bioSaved = null; render(); var c = document.getElementById('code'); if (c) c.focus(); break;
      case 'deviceLogin': doDeviceLogin(); break;
      case 'logout': doLogout(); break;
      case 'enroll': doEnroll(); break;
      case 'notNow': S.offerBio = false; S.bioMsg = ''; render(); break;
      case 'revoke': doRevoke(); break;
      case 'retry': S.busy = 'status'; render(); Promise.all([loadStatus(false), loadLists()]).finally(function () { S.busy = ''; render(); }); break;
      case 'sick': openSick(); break;
      case 'sickSubmit': submitSick(); break;
      case 'missed': openMissed(); break;
      case 'missedReview': reviewMissed(); break;
      case 'missedSubmit': submitMissed(); break;
      case 'editReview': reviewEdit(); break;
      case 'editSubmit': submitEdit(); break;
      case 'backForm': if (m) { m.step = 'form'; m.err = ''; render(); } break;
      case 'submit': openSubmit(); break;
      case 'toSign': if (m && m.review && m.review.canSubmit === true && m.c1 && m.c2) { m.step = 'sign'; m.signed = false; m.err = ''; render(); } break;
      case 'clearSig': clearSignature(); break;
      case 'sigBack': if (m && !m.busy) { m.step = 'review'; m.err = ''; render(); } break;
      case 'sigSubmit': submitSigned(); break;
      case 'closeModal': if (m && !m.busy) { S.modal = null; render(); } break;
      case 'guide': maybeShowGuide(true); break;
      case 'guideNext': if (S.guide >= GUIDE.length - 1) closeGuide(); else { S.guide++; render(); } break;
      case 'guideBack': if (S.guide > 0) { S.guide--; render(); } break;
      case 'guideSkip': closeGuide(); break;
      case 'install': doInstall(); break;
      case 'missedFrom': openMissed(el.getAttribute('data-date')); break;
      case 'noEarlier': sSet('localStorage', earlyKey(), 'yes'); render(); break;
      case 'copyLink':
        try { navigator.clipboard.writeText(location.origin + location.pathname).then(function () { S.linkCopied = true; render(); }, function () {}); } catch (err) {}
        break;
      case 'installLater': sSet('localStorage', 'wexInstallLater', String(Date.now())); render(); break;
    }
  });

  // ---------------------------------------------------------------- start
  var saved = sGet('sessionStorage', TOKEN_KEY);
  if (saved) {
    S.token = saved; S.view = 'session'; render();
    loadStatus(false).then(function (ok) {
      if (!ok && S.view === 'session') { if (S.token) { S.view = 'home'; render(); } return; }
      if (ok) { S.view = 'home'; startPolling(); render(); loadLists(); refreshBio(S.participant && S.participant.code).then(render); }
    });
  } else {
    S.view = 'login';
    refreshBio(S.code.trim()).then(render);
    render();
  }
})();
