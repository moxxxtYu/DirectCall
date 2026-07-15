const { app, BrowserWindow, ipcMain, session, desktopCapturer } = require('electron');
const { WebSocketServer } = require('ws');
const os = require('os');
const path = require('path');

const PORT = 9944;

// Тестовый режим: --test-host / --test-join — автоклик + фейковый микрофон
const TEST_HOST = process.argv.includes('--test-host');
const TEST_JOIN = process.argv.includes('--test-join');
if (TEST_HOST || TEST_JOIN) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
}

let win = null;
let wss = null;
let remote = null;
let shareSourceId = null; // источник для демонстрации экрана, выбирается в UI

function createWindow() {
  win = new BrowserWindow({
    width: 440,
    height: 700,
    minWidth: 400,
    minHeight: 620,
    autoHideMenuBar: true,
    backgroundColor: '#0a0a0a',
    title: 'DirectCall',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile('index.html');

  if (TEST_HOST || TEST_JOIN) {
    win.webContents.on('console-message', (e, level, message) => {
      console.log('[renderer]', message);
    });
    win.webContents.on('did-finish-load', () => {
      win.webContents.send('test-mode', TEST_HOST ? 'host' : 'join');
    });
  }
}

function stopHost() {
  if (remote) { try { remote.close(); } catch {} remote = null; }
  if (wss) { try { wss.close(); } catch {} wss = null; }
}

ipcMain.handle('start-host', () => {
  return new Promise((resolve, reject) => {
    if (wss) return resolve(PORT);
    wss = new WebSocketServer({ port: PORT }, () => resolve(PORT));
    wss.on('error', (e) => { wss = null; reject(new Error(e.message)); });
    wss.on('connection', (ws) => {
      if (remote && remote.readyState === 1) { ws.close(); return; } // только 1 собеседник
      remote = ws;
      win.webContents.send('peer-connected');
      ws.on('message', (data) => win.webContents.send('signal-in', data.toString()));
      ws.on('close', () => { remote = null; win.webContents.send('peer-disconnected'); });
    });
  });
});

ipcMain.handle('stop-host', () => { stopHost(); });

ipcMain.on('signal-out', (e, msg) => {
  if (remote && remote.readyState === 1) remote.send(msg);
});

ipcMain.handle('get-local-ips', () => {
  const ips = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const i of ifaces[name] || []) {
      if (i.family === 'IPv4' && !i.internal) ips.push({ ip: i.address, iface: name });
    }
  }
  return ips;
});

ipcMain.handle('get-screen-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 180 },
  });
  return sources.map((s) => ({ id: s.id, name: s.name, thumb: s.thumbnail.toDataURL() }));
});

ipcMain.handle('set-share-source', (e, id) => { shareSourceId = id; });

ipcMain.handle('set-window-size', (e, w, h) => {
  if (win) { win.setSize(w, h); win.center(); }
});

app.whenReady().then(() => {
  // getDisplayMedia в Electron требует свой обработчик выбора источника.
  // audio: 'loopback' — захват системного звука (Windows), чтобы шёл звук из демонстрации.
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen', 'window'] }).then((sources) => {
      const src = sources.find((s) => s.id === shareSourceId) || sources[0];
      if (!src) return callback({});
      try { callback({ video: src, audio: 'loopback' }); }
      catch { callback({ video: src }); }
    }).catch(() => callback({}));
  });
  createWindow();
});

app.on('window-all-closed', () => { stopHost(); app.quit(); });
