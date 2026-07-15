const { app, BrowserWindow, ipcMain, session, desktopCapturer } = require('electron');
const os = require('os');
const fs = require('fs');
const path = require('path');

// Тестовый режим: --test-host / --test-join — автоклик + фейковый микрофон,
// код комнаты передаётся между инстансами через файл в temp.
const TEST_HOST = process.argv.includes('--test-host');
const TEST_JOIN = process.argv.includes('--test-join');
const TEST_CODE_FILE = path.join(os.tmpdir(), 'directcall_test_code.txt');
if (TEST_HOST || TEST_JOIN) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
}

let win = null;
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

// только для автотеста
ipcMain.handle('test-put-code', (e, code) => {
  if (TEST_HOST) fs.writeFileSync(TEST_CODE_FILE, code);
});
ipcMain.handle('test-get-code', () => {
  try { return fs.readFileSync(TEST_CODE_FILE, 'utf8').trim(); } catch { return ''; }
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
  if (TEST_HOST) { try { fs.unlinkSync(TEST_CODE_FILE); } catch {} }
  createWindow();
});

app.on('window-all-closed', () => { app.quit(); });
