// DirectCall — P2P звонок 1-на-1 по коду комнаты.
// Сервер знакомства (ws://SIGNAL_SERVER) сводит двоих по 6-значному коду и
// пересылает сигналинг. Дальше всё P2P: звук/видео WebRTC, чат DataChannel.

const SIGNAL_SERVER = 'ws://144.172.65.25:9945';

const $ = (id) => document.getElementById(id);
const views = ['view-home', 'view-host', 'view-connecting', 'view-call'];

let role = null;          // 'host' (создал код) | 'guest' (ввёл код)
let ws = null;            // соединение с сервером знакомства
let pc = null;
let dc = null;            // чат
let localStream = null;
let shareStream = null;
let shareSenders = [];
let makingOffer = false;
let polite = false;       // создатель уступает при коллизии offer'ов
let noiseOn = true;
let callTimer = null;
let pingTimer = null;
let callStart = 0;
let testMode = null;

function show(view) {
  views.forEach((v) => $(v).classList.toggle('active', v === view));
}

let toastTimer = null;
function toast(msg, ms = 3500) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

function fmtCode(code) {
  return code.slice(0, 3) + '-' + code.slice(3);
}

// ---------- сервер знакомства ----------

function connectSignal(onOpen) {
  ws = new WebSocket(SIGNAL_SERVER);
  const connectTimeout = setTimeout(() => {
    if (ws && ws.readyState !== 1) ws.close();
  }, 8000);

  ws.onopen = () => { clearTimeout(connectTimeout); onOpen(); };

  ws.onmessage = async (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }

    if (msg.type === 'created') {
      console.log('room created: ' + msg.code);
      $('room-code').textContent = fmtCode(msg.code);
      $('room-code').dataset.code = msg.code;
      show('view-host');
      if (testMode === 'host') window.api.testPutCode(msg.code);
    } else if (msg.type === 'peer-joined') {
      console.log('peer joined room');
      createPeer(); // гость пришлёт offer
    } else if (msg.type === 'joined') {
      console.log('joined room');
      createPeer(); // addTrack → negotiationneeded → offer уйдёт сам
    } else if (msg.type === 'error') {
      endCall(msg.message === 'room not found' ? 'Нет звонка с таким кодом' : 'Ошибка: ' + msg.message);
    } else if (msg.type === 'peer-left') {
      endCall('Собеседник отключился');
    } else {
      handleSignal(msg);
    }
  };

  ws.onerror = () => {};
  ws.onclose = () => {
    clearTimeout(connectTimeout);
    // при активном P2P-звонке сервер уже не нужен — не рвём разговор
    if (role && (!pc || pc.connectionState !== 'connected')) {
      endCall(pc ? 'Соединение закрыто' : 'Сервер недоступен. Проверь интернет');
    }
  };
}

function sendSignal(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

let pendingCandidates = []; // кандидаты, пришедшие раньше remoteDescription

async function handleSignal(msg) {
  if (!pc) return;
  try {
    if (msg.type === 'description') {
      const d = msg.description;
      const collision = d.type === 'offer' && (makingOffer || pc.signalingState !== 'stable');
      if (!polite && collision) return; // невежливый игнорирует встречный offer
      await pc.setRemoteDescription(d);
      for (const c of pendingCandidates.splice(0)) {
        try { await pc.addIceCandidate(c); } catch (e) { console.log('ice err: ' + e.message); }
      }
      if (d.type === 'offer') {
        await pc.setLocalDescription();
        sendSignal({ type: 'description', description: pc.localDescription });
      }
    } else if (msg.type === 'candidate' && msg.candidate) {
      if (!pc.remoteDescription) { pendingCandidates.push(msg.candidate); return; }
      try { await pc.addIceCandidate(msg.candidate); } catch (e) { console.log('ice err: ' + e.message); }
    }
  } catch (e) {
    console.log('signal error: ' + e.message);
  }
}

// ---------- WebRTC ----------

async function getMic() {
  localStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: false,
  });
}

function createPeer() {
  polite = role === 'host';
  pc = new RTCPeerConnection({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ],
  });
  localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));

  pc.onnegotiationneeded = async () => {
    try {
      makingOffer = true;
      await pc.setLocalDescription();
      sendSignal({ type: 'description', description: pc.localDescription });
    } catch (e) {
      console.log('nego error: ' + e.message);
    } finally {
      makingOffer = false;
    }
  };

  pc.onicecandidate = (e) => {
    if (e.candidate) sendSignal({ type: 'candidate', candidate: e.candidate });
  };

  pc.ontrack = (e) => {
    const stream = e.streams[0];
    if (e.track.kind === 'video') {
      console.log('remote video track received');
      attachRemoteVideo(stream);
    } else if (stream.getVideoTracks().length === 0) {
      // микрофон собеседника; звук демонстрации играет внутри video-элемента
      $('remote-audio').srcObject = stream;
    }
  };

  pc.onconnectionstatechange = () => {
    console.log('pc state: ' + pc.connectionState);
    if (pc.connectionState === 'connected') startCallUI();
    if (['failed', 'closed'].includes(pc.connectionState)) endCall('Соединение потеряно');
  };

  if (role === 'guest') {
    dc = pc.createDataChannel('chat');
    setupChat();
  } else {
    pc.ondatachannel = (e) => { dc = e.channel; setupChat(); };
  }
}

// ---------- чат ----------

function setupChat() {
  dc.onopen = () => console.log('chat channel open');
  dc.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    if (typeof m.text !== 'string' || !m.text) return;
    addMsg(m.text, false);
    console.log('chat received: ' + m.text);
    if (testMode === 'host' && m.text === 'ping-from-guest') sendChat('pong-from-host');
  };
}

function sendChat(text) {
  if (!dc || dc.readyState !== 'open') { toast('Чат ещё не готов'); return; }
  dc.send(JSON.stringify({ text }));
  addMsg(text, true);
}

function addMsg(text, mine) {
  const el = document.createElement('div');
  el.className = 'msg ' + (mine ? 'mine' : 'theirs');
  el.textContent = text;
  $('chat-log').appendChild(el);
  $('chat-log').scrollTop = $('chat-log').scrollHeight;
}

// ---------- демонстрация экрана ----------

async function openSharePicker() {
  const sources = await window.api.getScreenSources();
  if (!sources.length) { toast('Нет доступных экранов'); return; }
  $('picker-grid').innerHTML = sources.map((s) =>
    `<button class="src" data-id="${s.id}"><img src="${s.thumb}" alt=""><div class="src-name">${s.name.replace(/</g, '&lt;')}</div></button>`
  ).join('');
  $('picker').classList.add('open');
  document.querySelectorAll('.src').forEach((el) => {
    el.addEventListener('click', () => {
      $('picker').classList.remove('open');
      startShare(el.dataset.id);
    });
  });
}

async function startShare(sourceId) {
  await window.api.setShareSource(sourceId || null);
  try {
    shareStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: true });
  } catch (e1) {
    try {
      shareStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    } catch (e2) {
      toast('Не удалось захватить экран: ' + e2.message);
      return;
    }
  }
  shareSenders = shareStream.getTracks().map((t) => pc.addTrack(t, shareStream));
  const vt = shareStream.getVideoTracks()[0];
  if (vt) vt.onended = stopShare;
  $('btn-share').classList.add('active');
  console.log('screen share started');
}

function stopShare() {
  if (!shareStream) return;
  shareSenders.forEach((s) => { try { pc.removeTrack(s); } catch {} });
  shareSenders = [];
  shareStream.getTracks().forEach((t) => t.stop());
  shareStream = null;
  $('btn-share').classList.remove('active');
}

function attachRemoteVideo(stream) {
  $('remote-video').srcObject = stream;
  $('video-wrap').classList.add('on');
  window.api.setWindowSize(1000, 720);
  stream.onremovetrack = () => {
    if (stream.getVideoTracks().length === 0) hideRemoteVideo();
  };
}

function hideRemoteVideo() {
  $('remote-video').srcObject = null;
  $('video-wrap').classList.remove('on');
  window.api.setWindowSize(440, 700);
}

// ---------- UI разговора ----------

function startCallUI() {
  show('view-call');
  callStart = Date.now();
  clearInterval(callTimer);
  callTimer = setInterval(() => {
    const s = Math.floor((Date.now() - callStart) / 1000);
    $('badge-time').textContent =
      String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }, 1000);

  clearInterval(pingTimer);
  pingTimer = setInterval(async () => {
    if (!pc) return;
    const stats = await pc.getStats();
    stats.forEach((r) => {
      if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.currentRoundTripTime !== undefined) {
        $('badge-ping').textContent = Math.round(r.currentRoundTripTime * 1000) + ' мс';
      }
    });
  }, 2000);

  // автотест: чат + демонстрация
  if (testMode === 'guest') {
    setTimeout(() => sendChat('ping-from-guest'), 1500);
    setTimeout(() => startShare(null), 3500);
  }
}

function endCall(reason) {
  clearInterval(callTimer);
  clearInterval(pingTimer);
  stopShare();
  hideRemoteVideo();
  if (dc) { try { dc.close(); } catch {} dc = null; }
  if (pc) { try { pc.close(); } catch {} pc = null; }
  if (localStream) { localStream.getTracks().forEach((t) => t.stop()); localStream = null; }
  if (ws) { const w = ws; ws = null; try { w.close(); } catch {} }
  pendingCandidates = [];
  role = null;
  $('chat-log').innerHTML = '';
  $('badge-time').textContent = '00:00';
  $('badge-ping').textContent = '— мс';
  $('btn-mute').classList.remove('muted');
  show('view-home');
  if (reason) toast(reason);
}

// ---------- создать / подключиться ----------

async function startHost() {
  role = 'host';
  try {
    await getMic();
  } catch (e) {
    role = null;
    toast('Нет доступа к микрофону: ' + e.message);
    return;
  }
  connectSignal(() => sendSignal({ type: 'create' }));
}

async function joinCall(code) {
  role = 'guest';
  $('connecting-text').textContent = 'Подключение…';
  show('view-connecting');
  try {
    await getMic();
  } catch (e) {
    role = null;
    show('view-home');
    toast('Нет доступа к микрофону: ' + e.message);
    return;
  }
  connectSignal(() => sendSignal({ type: 'join', code }));
}

// ---------- кнопки ----------

$('btn-host').addEventListener('click', startHost);

$('btn-join').addEventListener('click', () => {
  const code = $('join-code').value.replace(/\D/g, '');
  if (code.length !== 6) { toast('Код — 6 цифр'); return; }
  joinCall(code);
});
$('join-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-join').click(); });

$('room-code').addEventListener('click', () => {
  const code = $('room-code').dataset.code;
  if (!code) return;
  navigator.clipboard.writeText(code);
  toast('Код скопирован: ' + fmtCode(code));
});

$('btn-cancel-host').addEventListener('click', () => endCall());
$('btn-cancel-join').addEventListener('click', () => endCall());
$('btn-hangup').addEventListener('click', () => endCall('Звонок завершён'));

$('btn-mute').addEventListener('click', () => {
  if (!localStream) return;
  const track = localStream.getAudioTracks()[0];
  track.enabled = !track.enabled;
  $('btn-mute').classList.toggle('muted', !track.enabled);
});

$('btn-noise').addEventListener('click', async () => {
  if (!localStream) return;
  noiseOn = !noiseOn;
  const track = localStream.getAudioTracks()[0];
  try {
    await track.applyConstraints({
      echoCancellation: true,
      noiseSuppression: noiseOn,
      autoGainControl: noiseOn,
    });
  } catch (e) {
    toast('Не удалось переключить: ' + e.message);
    noiseOn = !noiseOn;
    return;
  }
  $('btn-noise').classList.toggle('active', noiseOn);
  toast(noiseOn ? 'Шумоподавление включено' : 'Шумоподавление выключено');
});

$('btn-share').addEventListener('click', () => {
  if (!pc) return;
  if (shareStream) stopShare();
  else openSharePicker();
});

$('picker-cancel').addEventListener('click', () => $('picker').classList.remove('open'));

$('btn-chat-send').addEventListener('click', () => {
  const text = $('chat-input').value.trim();
  if (!text) return;
  sendChat(text);
  $('chat-input').value = '';
});
$('chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-chat-send').click(); });

// ---------- автотест ----------

window.api.onTestMode((mode) => {
  console.log('test mode: ' + mode);
  testMode = mode === 'host' ? 'host' : 'guest';
  if (mode === 'host') { startHost(); return; }
  // гость: ждём, пока хост запишет код комнаты в temp-файл
  let tries = 0;
  const poll = setInterval(async () => {
    const code = await window.api.testGetCode();
    if (code && code.length === 6) {
      clearInterval(poll);
      joinCall(code);
    } else if (++tries > 30) {
      clearInterval(poll);
      console.log('TEST: no code from host');
    }
  }, 500);
});
