const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Funções existentes
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  startProcessing: (config) => ipcRenderer.send('start-processing', config),
  startFilesterUpload: (config) => ipcRenderer.send('start-filester-upload', config),
  
  // Novas funções para o Gravador
  getRecorderSettings: () => ipcRenderer.invoke('get-recorder-settings'),
  saveRecorderSettings: (settings) => ipcRenderer.invoke('save-recorder-settings', settings),
  startRecording: (url, name) => ipcRenderer.invoke('start-recording', url, name),
  stopRecording: (name) => ipcRenderer.invoke('stop-recording', name),

  // Eventos
  onLog: (callback) => ipcRenderer.on('log', (event, msg) => callback(msg)),
  onProgress: (callback) => ipcRenderer.on('progress-update', (event, pct) => callback(pct)),
  onUploadQueueInit: (callback) => ipcRenderer.on('upload-queue-init', (event, files) => callback(files)),
  onUploadProgressUpdate: (callback) => ipcRenderer.on('upload-progress-update', (event, data) => callback(data)),
  
  // Novos eventos do Gravador
  onRecordProgress: (callback) => ipcRenderer.on('record-progress', (event, data) => callback(data)),
  onRecordStopped: (callback) => ipcRenderer.on('record-stopped', (event, data) => callback(data))
});