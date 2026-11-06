const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const ffmpeg = require('fluent-ffmpeg');
const axios = require('axios');
const FormData = require('form-data');

// --- CONFIGURAÇÕES INICIAIS ---
let mainWindow;
const localFfmpegPath = path.join(__dirname, 'ffmpeg.exe');
if (fs.existsSync(localFfmpegPath)) {
  ffmpeg.setFfmpegPath(localFfmpegPath);
  const localFfprobePath = path.join(__dirname, 'ffprobe.exe');
  if (fs.existsSync(localFfprobePath)) {
    ffmpeg.setFfprobePath(localFfprobePath);
  }
}

// Arquivo para salvar as configurações do gravador
const settingsFile = path.join(app.getPath('userData'), 'recorder-settings.json');
let activeRecordings = {}; // { modelName: processo_ytdlp }

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 750,
    backgroundColor: '#09090b',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    },
    autoHideMenuBar: true
  });

  mainWindow.loadFile('index.html');
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Selecionar pasta genérica
ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });
  return result.filePaths[0] || null;
});

// ==========================================
// MÓDULO 1: EXTRATOR DE FRAMES (SEU CÓDIGO)
// ==========================================

function getVideoDuration(filePath) {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err || !metadata || !metadata.format || !metadata.format.duration) {
        resolve(0);
      } else {
        resolve(metadata.format.duration);
      }
    });
  });
}

function extractSingleFrame(videoPath, timeInSeconds, outputPath) {
  return new Promise((resolve) => {
    ffmpeg()
      .input(videoPath)
      .inputOptions([`-ss ${timeInSeconds}`])
      .outputOptions(['-vframes 1', '-q:v 2'])
      .output(outputPath)
      .on('end', () => resolve(true))
      .on('error', () => resolve(false))
      .run();
  });
}

ipcMain.on('start-processing', async (event, config) => {
  const { inputFolder, outputFolder } = config;

  if (!inputFolder || !outputFolder) {
    event.reply('log', '❌ Por favor, selecione as pastas de entrada e saída.');
    return;
  }

  try {
    const files = fs.readdirSync(inputFolder);
    const videoExtensions = ['.mp4', '.mkv', '.avi', '.mov', '.webm', '.ts'];
    const videoFiles = files.filter(file => videoExtensions.includes(path.extname(file).toLowerCase()));

    if (videoFiles.length === 0) {
      event.reply('log', '⚠️ Nenhum vídeo compatível encontrado na pasta de entrada.');
      return;
    }

    event.reply('log', `🔍 Analisando ${videoFiles.length} vídeos e agrupando por modelos...`);
    const modelMap = {};

    for (let file of videoFiles) {
      let modelName = 'Outros';
      const match = file.match(/^(.*?)(?=_\d{4}-\d{2}-\d{2})/);
      
      if (match && match[1]) {
        modelName = match[1].replace(/^_+|_+$/g, '').trim();
      } else {
        const parts = file.split('_');
        if (parts.length > 1) modelName = parts[0];
      }
      if (!modelName) modelName = 'Desconhecido';
      if (!modelMap[modelName]) modelMap[modelName] = [];
      modelMap[modelName].push(file);
    }

    const models = Object.keys(modelMap);
    event.reply('log', `✨ Encontradas ${models.length} modelos diferentes. Calculando durações e cotas...`);

    let processedCount = 0;

    for (let mIndex = 0; mIndex < models.length; mIndex++) {
      const modelName = models[mIndex];
      const modelVideos = modelMap[modelName];

      event.reply('log', `\n--- Processando Modelo [${mIndex + 1}/${models.length}]: "${modelName}" (${modelVideos.length} vídeos) ---`);

      const modelOutputDir = path.join(outputFolder, modelName);
      if (!fs.existsSync(modelOutputDir)) fs.mkdirSync(modelOutputDir, { recursive: true });

      let videoDurations = [];
      let totalModelDuration = 0;

      for (let vFile of modelVideos) {
        const fullPath = path.join(inputFolder, vFile);
        const duration = await getVideoDuration(fullPath);
        videoDurations.push({ file: vFile, fullPath, duration });
        totalModelDuration += duration;
      }

      if (totalModelDuration <= 0) {
        event.reply('log', `⚠️ Duração total inválida para a modelo ${modelName}. Pulando...`);
        continue;
      }

      const targetFrames = 50;
      let intervalSeconds = totalModelDuration / targetFrames;
      if (intervalSeconds < 1) intervalSeconds = 1;

      event.reply('log', `⏱️ Duração total: ${Math.round(totalModelDuration)}s | Intervalo dinâmico: ~${Math.round(intervalSeconds)}s por foto`);

      let globalTimeCursor = 0;
      let frameIndex = 1;

      for (let step = 0; step < targetFrames; step++) {
        let accumulatedTime = 0;
        let targetVideoObj = null;
        let timeWithinVideo = 0;

        for (let vObj of videoDurations) {
          if (globalTimeCursor >= accumulatedTime && globalTimeCursor <= accumulatedTime + vObj.duration) {
            targetVideoObj = vObj;
            timeWithinVideo = globalTimeCursor - accumulatedTime;
            break;
          }
          accumulatedTime += vObj.duration;
        }

        if (!targetVideoObj) {
          targetVideoObj = videoDurations[videoDurations.length - 1];
          timeWithinVideo = targetVideoObj.duration > 2 ? targetVideoObj.duration - 2 : 0;
        }

        const videoBaseName = path.parse(targetVideoObj.file).name;
        const frameIndexPadded = String(frameIndex).padStart(4, '0');
        const framePath = path.join(modelOutputDir, `${videoBaseName}_frame_${frameIndexPadded}.jpg`);

        await extractSingleFrame(targetVideoObj.fullPath, timeWithinVideo, framePath);
        frameIndex++;
        globalTimeCursor += intervalSeconds;
        if (globalTimeCursor > totalModelDuration) break;
      }

      event.reply('log', `✅ Concluída a modelo "${modelName}" (Gerados ${frameIndex - 1} prints).`);
      processedCount++;
      event.reply('progress-update', Math.round((processedCount / models.length) * 100));
    }
    event.reply('log', '\n🎉 Processamento inteligente concluído com sucesso!');
  } catch (err) {
    event.reply('log', `❌ Erro crítico no sistema: ${err.message}`);
  }
});

// ==========================================
// MÓDULO 2: UPLOAD FILESTER (SEU CÓDIGO)
// ==========================================

function extractModelNameFromFile(filename) {
  const match = filename.match(/^(.*?)(?=_\d{4}-\d{2}-\d{2})/);
  if (match && match[1]) return match[1].replace(/^_+|_+$/g, '').trim();
  const parts = filename.split('_');
  return parts.length > 1 ? parts[0] : 'Desconhecido';
}

ipcMain.on('start-filester-upload', async (event, config) => {
  const { apiKey, folder } = config;
  const baseURL = 'https://u1.filester.me/api/v1';

  try {
    const files = fs.readdirSync(folder);
    const videoExtensions = ['.mp4', '.mkv', '.avi', '.mov', '.webm', '.ts'];
    const videoFiles = files.filter(file => videoExtensions.includes(path.extname(file).toLowerCase()));

    if (videoFiles.length === 0) {
      event.sender.send('log', '⚠️ Nenhum vídeo encontrado na pasta selecionada.');
      return;
    }

    const queueData = videoFiles.map((file, index) => ({
      id: index,
      name: file,
      path: path.join(folder, file),
      model: extractModelNameFromFile(file)
    }));

    event.sender.send('upload-queue-init', queueData);
    event.sender.send('log', `🚀 Iniciando processamento de ${queueData.length} vídeos...`);

    const modelFolderMap = {}; 
    const modelLinksMap = {};  

    try {
      const foldersRes = await axios.get(`${baseURL}/folders`, { headers: { 'Authorization': `Bearer ${apiKey}` } });
      if (foldersRes.data && foldersRes.data.data) {
        foldersRes.data.data.forEach(f => modelFolderMap[f.name] = f.id);
      }
    } catch (e) {
      event.sender.send('log', '⚠️ Aviso ao buscar pastas: ' + (e.response?.data?.message || e.message));
    }

    for (let item of queueData) {
      const modelName = item.model;
      if (!modelLinksMap[modelName]) modelLinksMap[modelName] = [];

      if (!modelFolderMap[modelName]) {
        try {
          event.sender.send('log', `📁 Criando pasta "${modelName}"...`);
          const createFolderRes = await axios.post(`${baseURL}/folder`, 
            { name: modelName, public: 1 },
            { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' } }
          );
          if (createFolderRes.data && createFolderRes.data.data) modelFolderMap[modelName] = createFolderRes.data.data.identifier;
        } catch (err) {
          event.sender.send('log', `❌ Erro ao criar pasta ${modelName}: ${err.response?.data?.message || err.message}`);
        }
      }

      const folderId = modelFolderMap[modelName];

      try {
        const form = new FormData();
        form.append('file', fs.createReadStream(item.path));

        const headers = { ...form.getHeaders(), 'Authorization': `Bearer ${apiKey}` };
        if (folderId) headers['X-Folder-ID'] = folderId;

        const uploadRes = await axios.post(`${baseURL}/upload`, form, {
          headers: headers,
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
          onUploadProgress: (progressEvent) => {
            if (progressEvent.total) {
              const percent = Math.round((progressEvent.loaded * 100) / progressEvent.total);
              const loadedMB = (progressEvent.loaded / (1024 * 1024)).toFixed(1);
              const totalMB = (progressEvent.total / (1024 * 1024)).toFixed(1);
              event.sender.send('upload-progress-update', {
                id: item.id,
                percent: percent,
                status: `${loadedMB} MB / ${totalMB} MB (${percent}%)`
              });
            }
          }
        });

        if (uploadRes.data && (uploadRes.data.url || uploadRes.data.success)) {
          const fileUrl = uploadRes.data.url || `https://filester.me/d/${uploadRes.data.slug}`;
          modelLinksMap[modelName].push(fileUrl);
          event.sender.send('upload-progress-update', { id: item.id, percent: 100, status: 'Concluído e Removido ✅' });
          try { fs.unlinkSync(item.path); } catch (unlinkErr) { event.sender.send('log', `⚠️ Não foi possível apagar ${item.name}: ${unlinkErr.message}`); }
        } else {
          throw new Error('A resposta da API não retornou a URL do arquivo.');
        }
      } catch (err) {
        const errorMsg = err.response?.data?.message || err.message;
        event.sender.send('upload-progress-update', { id: item.id, percent: 100, status: 'Erro ❌' });
        event.sender.send('log', `❌ Falha no arquivo ${item.name}: ${errorMsg}`);
      }
    }

    let txtContent = '';
    for (const [model, links] of Object.entries(modelLinksMap)) {
      if (links.length > 0) {
        txtContent += `========================================\nMODELO: ${model}\n========================================\n`;
        links.forEach(url => txtContent += `${url}\n`);
        txtContent += `\n`;
      }
    }

    const txtPath = path.join(folder, `links_upload_${Date.now()}.txt`);
    fs.writeFileSync(txtPath, txtContent, 'utf-8');
    event.sender.send('log', `\n🎉 Processo finalizado! TXT de links salvo em: ${txtPath}`);
  } catch (err) {
    event.sender.send('log', `❌ Erro crítico: ${err.message}`);
  }
});

// ==========================================
// MÓDULO 3: GRAVADOR YT-DLP (NOVO)
// ==========================================

function loadRecSettings() {
  if (fs.existsSync(settingsFile)) return JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
  return { savePath: app.getPath('videos'), maxSizeGb: 1, maxResolution: '720', maxConcurrent: 3 };
}

function saveRecSettings(settings) {
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), 'utf-8');
}

ipcMain.handle('get-recorder-settings', () => loadRecSettings());
ipcMain.handle('save-recorder-settings', (event, settings) => {
  saveRecSettings(settings);
  return true;
});

ipcMain.handle('start-recording', async (event, modelUrl, modelName) => {
  const settings = loadRecSettings();
  
  if (Object.keys(activeRecordings).length >= settings.maxConcurrent) {
    return { error: `Limite de ${settings.maxConcurrent} gravações simultâneas atingido.` };
  }
  if (activeRecordings[modelName]) return { error: 'Modelo já está sendo gravada.' };

  const ytdlpPath = path.join(__dirname, 'yt-dlp.exe');
  if (!fs.existsSync(ytdlpPath)) return { error: 'yt-dlp.exe não encontrado na pasta do programa.' };

  startYtdlpProcess(modelName, modelUrl, settings);
  return { success: true };
});

ipcMain.handle('stop-recording', (event, modelName) => {
  if (activeRecordings[modelName]) {
    activeRecordings[modelName].kill('SIGINT');
    delete activeRecordings[modelName];
    return true;
  }
  return false;
});

function startYtdlpProcess(modelName, modelUrl, settings) {
  const outputTemplate = path.join(settings.savePath, `${modelName}_%(timestamp)s.%(ext)s`);
  const ytdlpPath = path.join(__dirname, 'yt-dlp.exe');
  
  const args = [
    '--impersonate', 'chrome',
    '--hls-use-mpegts', 
    '--no-part',
    '-f', `bestvideo[height<=?${settings.maxResolution}]+bestaudio/best[height<=?${settings.maxResolution}]`,
    '-o', outputTemplate,
    '--external-downloader', 'ffmpeg',
    modelUrl
  ];

  const proc = spawn(ytdlpPath, args);
  activeRecordings[modelName] = proc;

  proc.stdout.on('data', (data) => {
    mainWindow.webContents.send('record-progress', { modelName, log: data.toString() });
    checkFileSizeLimit(modelName, modelUrl, settings); 
  });

  proc.stderr.on('data', (data) => {
    mainWindow.webContents.send('record-progress', { modelName, log: data.toString(), isError: true });
  });

  proc.on('close', (code) => {
    if (activeRecordings[modelName]) {
      delete activeRecordings[modelName];
      mainWindow.webContents.send('record-stopped', { modelName, code });
    }
  });
}

function checkFileSizeLimit(modelName, modelUrl, settings) {
  const limitBytes = settings.maxSizeGb * 1024 * 1024 * 1024;
  
  const interval = setInterval(() => {
    if (!activeRecordings[modelName]) {
      clearInterval(interval);
      return;
    }

    try {
      const files = fs.readdirSync(settings.savePath);
      const modelFiles = files.filter(f => f.startsWith(modelName) && (f.endsWith('.ts') || f.endsWith('.mp4') || f.endsWith('.mkv')));
      
      if (modelFiles.length > 0) {
        const latestFile = modelFiles.sort((a, b) => {
          return fs.statSync(path.join(settings.savePath, b)).mtime.getTime() - fs.statSync(path.join(settings.savePath, a)).mtime.getTime();
        })[0];
        
        const stats = fs.statSync(path.join(settings.savePath, latestFile));
        
        if (stats.size >= limitBytes) {
          mainWindow.webContents.send('record-progress', { modelName, log: `\n🔄 Limite de ${settings.maxSizeGb}GB atingido. Reiniciando...` });
          
          activeRecordings[modelName].kill('SIGINT');
          delete activeRecordings[modelName];
          clearInterval(interval);
          
          setTimeout(() => startYtdlpProcess(modelName, modelUrl, settings), 2000);
        }
      }
    } catch (e) {}
  }, 5000); 
}