const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  onPtt: (cb) => ipcRenderer.on('ptt', (_, state) => cb(state)),
  onState: (cb) => ipcRenderer.on('state', (_, s) => cb(s)),
  tts: (text, mood) => ipcRenderer.invoke('tts', text, mood),
  voices: () => ipcRenderer.invoke('voices'),
  chat: (messages) => ipcRenderer.invoke('chat', messages),
  stt: (buf) => ipcRenderer.invoke('stt', buf),
  act: (a) => ipcRenderer.invoke('act', a),
  checkUpdate: () => ipcRenderer.invoke('checkUpdate'),
  getConfig: () => ipcRenderer.invoke('getConfig'),
  setConfig: (data) => ipcRenderer.invoke('setConfig', data),
  say: (text, ms) => ipcRenderer.send('say', text, ms),
  command: (name) => ipcRenderer.send('command', name),
  dragStart: () => ipcRenderer.send('drag', true),
  dragEnd: () => ipcRenderer.send('drag', false),
  onText: (cb) => ipcRenderer.on('text', (_, t) => cb(t)),
  bubbleSize: (h) => ipcRenderer.send('bubble-size', h)
})
