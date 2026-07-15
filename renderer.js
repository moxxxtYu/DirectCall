// DirectCall — P2P звонок 1-на-1 без внешнего сервера.
// Хост поднимает WebSocket на :9944, гость подключается по IP.
// Звук/видео — WebRTC, чат — DataChannel, демонстрация экрана — getDisplayMedia
// с докидыванием треков и перепереговорами (perfect negotiation).

const $ = (id) => document.getElementById(id);
const views = ['view-home', 'view-host', 'view-connecting', 'view-call'];

let role = null;          // 'host' | 'guest'
let ws = null;            // сокет гостя
let pc = null;
let dc = null;            // чат
let localStream = null;
let shareStream = null;
let shareSenders = [];
let makingOffer = false;
let polite = false;       // хост уступает при коллизии offer'ов
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

// ---------- адреса на главном экране ----------

// Виртуальные адаптеры (Docker/WSL/Hyper-V и т.п.) — мусор, скрываем.
// Адреса VPN-сетей (Radmin 26.x, Hamachi 25.x, Tailscale 100.64+) — то, что
// реально надо кидать другу через интернет, подсвечиваем как рекомендуемые.
const VIRTUAL_IFACE = /vethernet|wsl|docker|virtualbox|vmware|hyper-v|loopback|bluetooth|виртуальн|tun|tap/i;

function classifyAddr(ip, iface) {
  if (VIRTUAL_IFACE.test(iface)) return null;
  const [a, b] = ip.split('.').map(Number);
  if (a === 169 && b === 254) return null; // APIPA — адаптер без сети
  if (a === 26) return { tag: 'radmin · кидай этот', rec: true };
  if (a === 25) return { tag: 'hamachi · кидай этот', rec: true };
  if (a === 100 && b >= 64 && b <= 127) return { tag: 'tailscale · кидай этот', rec: true };
  return { tag: 'локальная сеть', rec: false };
}

async function loadAddresses() {
  const rows = [];
  const ips = await window.api.getLocalIps();
  ips.forEach(({ ip, iface }) => {
    const c = classifyAddr(ip, iface);
    if (c) rows.push({ ip, ...c });
  });
  rows.sort((x, y) => (y.rec ? 1 : 0) - (x.rec ? 1 : 0));
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch('https://api.ipify.org?format=json', { signal: ctrl.signal });
    const j = await r.json();
    if (j.ip && !rows.some((x) => x.ip === j.ip)) rows.push({ ip: j.ip, tag: 'внешний', rec: false });
  } catch {}
  $('addr-list').innerHTML = rows.length
    ? rows.map((r) => `<div class="addr-row${r.rec ? ' rec' : ''}" data-ip="${r.ip}"><span class="addr-ip">${r.ip}</span><span class="addr-tag">${r.tag}</span></div>`).join('')
    : '<div class="hint">Сетевые адреса не найдены</div>';
  document.querySelectorAll('.addr-row').forEach((el) => {
    el.addEventListener('click', () => {
      navigator.clipboard.writeText(el.dataset.ip);
      toast('Скопировано: ' + el.dataset.ip);
    });
  });
}

// ---------- сигналинг ----------

function sendSignal(obj) {
  const msg = JSON.stringify(obj);
  if (role === 'host') window.api.sendSignal(msg);
  else if (ws && ws.readyState === 1) ws.send(msg);
}

async function handleSignal(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  if (!pc) return;
  try {
    if (msg.type === 'description') {
      const d = msg.description;
      const collision = d.type === 'offer' && (makingOffer || pc.signalingState !== 'stable');
      if (!polite && collision) return; // невежливый игнорирует встречный offer
      await pc.setRemoteDescription(d);
      if (d.type === 'offer') {
        await pc.setLocalDescription();
        sendSignal({ type: 'description', description: pc.localDescription });
      }
    } else if (msg.type === 'candidate' && msg.candidate) {
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
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
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
  if (ws) { try { ws.close(); } catch {} ws = null; }
  window.api.stopHost();
  role = null;
  $('chat-log').innerHTML = '';
  $('badge-time').textContent = '00:00';
  $('badge-ping').textContent = '— мс';
  $('btn-mute').classList.remove('muted');
  show('view-home');
  if (reason) toast(reason);
}

// ---------- хост ----------

async function startHost() {
  role = 'host';
  try {
    await getMic();
  } catch (e) {
    role = null;
    toast('Нет доступа к микрофону: ' + e.message);
    return;
  }
  try {
    await window.api.startHost();
  } catch (e) {
    endCall('Не удалось открыть порт 9944: ' + e.message);
    return;
  }
  show('view-host');
}

window.api.onPeerConnected(() => {
  if (role !== 'host') return;
  console.log('peer connected to host socket');
  createPeer(); // гость пришлёт offer
});

window.api.onPeerDisconnected(() => {
  if (role === 'host' && pc) endCall('Собеседник отключился');
});

window.api.onSignal((msg) => handleSignal(msg));

// ---------- гость ----------

async function joinCall(ip) {
  role = 'guest';
  $('connecting-text').textContent = 'Подключение к ' + ip;
  show('view-connecting');
  try {
    await getMic();
  } catch (e) {
    role = null;
    show('view-home');
    toast('Нет доступа к микрофону: ' + e.message);
    return;
  }

  ws = new WebSocket('ws://' + ip + ':9944');
  const connectTimeout = setTimeout(() => {
    if (ws && ws.readyState !== 1) ws.close();
  }, 8000);

  ws.onopen = () => {
    clearTimeout(connectTimeout);
    console.log('ws connected to host');
    createPeer(); // addTrack → negotiationneeded → offer уйдёт сам
  };
  ws.onmessage = (e) => handleSignal(e.data);
  ws.onerror = () => {};
  ws.onclose = () => {
    clearTimeout(connectTimeout);
    if (role === 'guest') endCall(pc ? 'Соединение закрыто' : 'Хост недоступен. Проверь IP и порт 9944');
  };
}

// ---------- кнопки ----------

$('btn-host').addEventListener('click', startHost);

$('btn-join').addEventListener('click', () => {
  const ip = $('join-ip').value.trim();
  if (!ip) { toast('Введи IP хоста'); return; }
  joinCall(ip);
});
$('join-ip').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-join').click(); });

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

// ---------- старт ----------

loadAddresses();

window.api.onTestMode((mode) => {
  console.log('test mode: ' + mode);
  testMode = mode === 'host' ? 'host' : 'guest';
  if (mode === 'host') startHost();
  else setTimeout(() => joinCall('127.0.0.1'), 2500);
});
