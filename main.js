const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, session, desktopCapturer, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const { spawn } = require('child_process')
const { uIOhook, UiohookKey } = require('uiohook-napi')
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts')

const SIZE = 96
const FOOT = 8
const BUBBLE_W = 280
const GRAVITY = 2600
const BOUNCE = 0.35
const SNAP = 16
const MAX_SPEED = 4000
const RUN = 520

const defaults = {
  provider: 'pollinations',
  groqKey: '',
  openrouterKey: '',
  groqModel: 'openai/gpt-oss-120b',
  openrouterModel: 'meta-llama/llama-3.3-70b-instruct:free',
  ollamaModel: 'llama3.2',
  ttsVoice: 'fr-FR-VivienneMultilingualNeural',
  ttsPitch: 12,
  ttsRate: 4,
  ttsEngine: 'fish',
  fishKey: process.env.FISHAUDIO_API_KEY || '',
  fishVoiceId: process.env.FISHAUDIO_VOICEID || '711cf3ed00ab441a8f54a45058047b7a',
  fishModel: process.env.FISHAUDIO_MODEL || 's2.1-pro-free',
  wakeWord: true,
  autoUpdate: true,
  allowOpen: true,
  allowScreen: true,
  visionModel: 'meta-llama/llama-4-scout-17b-16e-instruct',
  mood: 30,
  moodAt: 0
}

const providers = [
  ['pollinations', 'Pollinations (sans clé)'],
  ['groq', 'Groq (gratuit)'],
  ['openrouter', 'OpenRouter (modèles free)'],
  ['ollama', 'Ollama (local)']
]

let cfg = { ...defaults }
let win
let bubbleWin
let settingsWin
let tray
let scanner
let platforms = []

const ball = { x: 0, y: 0, vx: 0, vy: 0 }
let dragging = false
let grounded = false
let follow = false
let jumpCooldown = 0
let grab = { x: 0, y: 0 }
let lastTick = Date.now()
let bubbleOn = false
let bubbleH = 40
let bubbleTimer

const cfgPath = () => path.join(app.getPath('userData'), 'config.json')
const load = () => {
  try {
    cfg = { ...defaults, ...JSON.parse(fs.readFileSync(cfgPath(), 'utf8')) }
  } catch {}
  if (/^llama-(3\.3-70b-versatile|3\.1-8b-instant)$/.test(cfg.groqModel)) cfg.groqModel = defaults.groqModel
  try {
    const s = JSON.parse(fs.readFileSync(path.join(__dirname, 'secrets.json'), 'utf8'))
    if (s.groqKey && !cfg.groqKey) {
      cfg.groqKey = s.groqKey
      if (cfg.provider === 'pollinations') cfg.provider = 'groq'
      save()
    }
    if (s.fishKey && !cfg.fishKey) {
      cfg.fishKey = s.fishKey
      save()
    }
  } catch {}
}
const save = () => {
  fs.mkdirSync(path.dirname(cfgPath()), { recursive: true })
  fs.writeFileSync(cfgPath(), JSON.stringify(cfg, null, 2))
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v))

function dropBall() {
  const { workArea } = screen.getPrimaryDisplay()
  ball.x = workArea.x + workArea.width / 2 - SIZE / 2
  ball.y = workArea.y
  ball.vx = 0
  ball.vy = 0
}

function setFollow(v) {
  follow = v
  buildMenu()
}

function jump(h) {
  if (!grounded) return
  ball.vy = -Math.sqrt(2 * GRAVITY * h)
  grounded = false
}

function buildMenu() {
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: 'Suivre la souris',
        type: 'checkbox',
        checked: follow,
        click: (item) => setFollow(item.checked)
      },
      { type: 'separator' },
      ...providers.map(([id, label]) => ({
        label,
        type: 'radio',
        checked: cfg.provider === id,
        click: () => {
          cfg.provider = id
          save()
        }
      })),
      { type: 'separator' },
      {
        label: 'Calmer Verity',
        click: () => {
          cfg.mood = defaults.mood
          cfg.moodAt = Date.now()
          save()
        }
      },
      {
        label: 'Mises à jour automatiques',
        type: 'checkbox',
        checked: cfg.autoUpdate !== false,
        click: (item) => {
          cfg.autoUpdate = item.checked
          save()
        }
      },
      { label: 'Vérifier les mises à jour', click: () => checkUpdate(true) },
      { label: 'Réglages', click: openSettings },
      { label: 'Lâcher la boule', click: dropBall },
      { label: 'Afficher / Masquer', click: () => (win.isVisible() ? win.hide() : win.show()) },
      { label: 'Quitter', click: () => app.quit() }
    ])
  )
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) return settingsWin.focus()
  settingsWin = new BrowserWindow({
    width: 420,
    height: 620,
    autoHideMenuBar: true,
    title: 'Verity — Réglages',
    webPreferences: { preload: path.join(__dirname, 'preload.js') }
  })
  settingsWin.loadFile('settings.html')
}

function createWindows() {
  const webPreferences = { preload: path.join(__dirname, 'preload.js') }

  win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    focusable: false,
    show: false,
    webPreferences
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.loadFile('index.html')
  win.once('ready-to-show', () => win.showInactive())

  bubbleWin = new BrowserWindow({
    width: BUBBLE_W,
    height: bubbleH,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    focusable: false,
    show: false,
    webPreferences
  })
  bubbleWin.setAlwaysOnTop(true, 'screen-saver')
  bubbleWin.setIgnoreMouseEvents(true)
  bubbleWin.loadFile('bubble.html')
}

function placeBubble() {
  if (!bubbleOn) return
  const area = screen.getDisplayNearestPoint({ x: Math.round(ball.x + SIZE / 2), y: Math.round(ball.y + SIZE / 2) }).workArea
  const x = clamp(Math.round(ball.x + SIZE / 2 - BUBBLE_W / 2), area.x, area.x + area.width - BUBBLE_W)
  let y = Math.round(ball.y + FOOT - bubbleH)
  if (y < area.y) y = Math.round(ball.y + SIZE - FOOT)
  bubbleWin.setBounds({ x, y, width: BUBBLE_W, height: bubbleH })
}

function hideBubble() {
  bubbleOn = false
  bubbleWin.hide()
}

function covered(cx, y, index) {
  for (let j = 0; j < index; j++) {
    const q = platforms[j]
    if (cx > q.l && cx < q.r && y > q.t && y < q.b) return true
  }
  return false
}

function tick() {
  const now = Date.now()
  const dt = Math.min((now - lastTick) / 1000, 0.05)
  lastTick = now
  if (dt <= 0 || !win || win.isDestroyed()) return

  const cursor = screen.getCursorScreenPoint()
  const center = { x: Math.round(ball.x + SIZE / 2), y: Math.round(ball.y + SIZE / 2) }
  const area = screen.getDisplayNearestPoint(center).workArea
  const displays = screen.getAllDisplays()
  const minX = Math.min(...displays.map((d) => d.workArea.x))
  const maxX = Math.max(...displays.map((d) => d.workArea.x + d.workArea.width))
  const minY = Math.min(...displays.map((d) => d.workArea.y))

  jumpCooldown -= dt

  if (dragging) {
    const nx = cursor.x - grab.x
    const ny = cursor.y - grab.y
    ball.vx = ball.vx * 0.6 + ((nx - ball.x) / dt) * 0.4
    ball.vy = ball.vy * 0.6 + ((ny - ball.y) / dt) * 0.4
    ball.x = nx
    ball.y = ny
    grounded = false
  } else {
    if (follow) {
      const dx = cursor.x - (ball.x + SIZE / 2)
      const want = Math.abs(dx) < 14 ? 0 : clamp(dx * 3, -RUN, RUN)
      const k = grounded ? Math.min(1, 12 * dt) : Math.min(1, 3 * dt)
      ball.vx += (want - ball.vx) * k

      const feet = ball.y + SIZE - FOOT
      if (grounded && jumpCooldown <= 0 && cursor.y < feet - 60 && Math.abs(dx) < 260) {
        jump(clamp(feet - cursor.y + 60, 140, 340))
        jumpCooldown = 0.9
      }
    }

    ball.vy += GRAVITY * dt
    const prevBottom = ball.y + SIZE - FOOT
    ball.x += ball.vx * dt
    ball.y += ball.vy * dt
    grounded = false

    if (ball.x < minX) {
      ball.x = minX
      ball.vx = Math.abs(ball.vx) * 0.5
    }
    if (ball.x + SIZE > maxX) {
      ball.x = maxX - SIZE
      ball.vx = -Math.abs(ball.vx) * 0.5
    }
    if (ball.y + FOOT < minY) {
      ball.y = minY - FOOT
      ball.vy = Math.abs(ball.vy) * 0.3
    }

    let land = null
    if (ball.vy >= 0) {
      const bottom = ball.y + SIZE - FOOT
      const cx = ball.x + SIZE / 2
      for (let i = 0; i < platforms.length; i++) {
        const p = platforms[i]
        if (p.t < area.y + SIZE + 10) continue
        if (cx < p.l || cx > p.r) continue
        if (prevBottom > p.t + SNAP || bottom < p.t) continue
        if (covered(cx, p.t, i)) continue
        if (land === null || p.t < land) land = p.t
      }
      const ground = area.y + area.height
      if (bottom >= ground && (land === null || ground < land)) land = ground
    }

    if (land !== null) {
      ball.y = land - SIZE + FOOT
      if (ball.vy > 220) {
        ball.vy = -ball.vy * BOUNCE
        ball.vx *= 0.85
      } else {
        ball.vy = 0
        grounded = true
        if (!follow) {
          ball.vx *= Math.max(0, 1 - 8 * dt)
          if (Math.abs(ball.vx) < 4) ball.vx = 0
        }
      }
    }
  }

  win.setBounds({ x: Math.round(ball.x), y: Math.round(ball.y), width: SIZE, height: SIZE })
  win.webContents.send('state', {
    vx: ball.vx,
    vy: ball.vy,
    grounded,
    lx: clamp((cursor.x - (ball.x + SIZE / 2)) / 250, -1, 1),
    ly: clamp((cursor.y - (ball.y + SIZE / 2)) / 250, -1, 1),
    drag: dragging
  })
  placeBubble()
}

function parseWindows(line) {
  if (!/^[\d,;\-]*$/.test(line)) return
  platforms = line
    .split(';')
    .filter(Boolean)
    .map((s) => {
      const [l, t, r, b] = s.split(',').map(Number)
      const d = screen.screenToDipRect(null, { x: l, y: t, width: r - l, height: b - t })
      return { l: d.x, t: d.y, r: d.x + d.width, b: d.y + d.height }
    })
}

function startScanner() {
  if (process.platform !== 'win32') return
  const script = path.join(__dirname, 'windows.ps1').replace('app.asar', 'app.asar.unpacked')
  scanner = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-SelfPid', String(process.pid)],
    { windowsHide: true }
  )
  let buf = ''
  scanner.stdout.on('data', (d) => {
    buf += d.toString()
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      parseWindows(line)
    }
  })
  scanner.on('exit', () => {
    scanner = null
  })
}

async function chat(messages) {
  const p = cfg.provider
  const headers = { 'Content-Type': 'application/json' }
  let url
  let body

  if (p === 'ollama') {
    const r = await fetch('http://localhost:11434/api/chat', {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: cfg.ollamaModel, messages, stream: false })
    })
    if (!r.ok) throw new Error(r.status + ' ' + (await r.text()).slice(0, 200))
    return (await r.json()).message.content
  }

  if (p === 'groq') {
    if (!cfg.groqKey) throw new Error('Clé Groq manquante (Réglages)')
    headers.Authorization = 'Bearer ' + cfg.groqKey
    const models = [...new Set([cfg.groqModel, 'openai/gpt-oss-120b', 'openai/gpt-oss-20b'])]
    let err = ''
    for (const m of models) {
      const payload = { model: m, messages }
      if (m.startsWith('openai/gpt-oss')) payload.reasoning_effort = 'low'
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
      })
      if (r.ok) {
        if (m !== cfg.groqModel) {
          cfg.groqModel = m
          save()
        }
        return (await r.json()).choices[0].message.content || ''
      }
      err = r.status + ' ' + (await r.text()).slice(0, 200)
      if (r.status !== 404) break
    }
    throw new Error(err)
  }

  if (p === 'openrouter') {
    if (!cfg.openrouterKey) throw new Error('Clé OpenRouter manquante (Réglages)')
    url = 'https://openrouter.ai/api/v1/chat/completions'
    headers.Authorization = 'Bearer ' + cfg.openrouterKey
    body = { model: cfg.openrouterModel, messages }
  } else {
    url = 'https://text.pollinations.ai/openai'
    body = { model: 'openai', messages }
  }

  const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
  if (!r.ok) throw new Error(r.status + ' ' + (await r.text()).slice(0, 200))
  const j = await r.json()
  return j.choices[0].message.content
}

ipcMain.handle('chat', async (_, messages) => {
  try {
    return await chat(messages)
  } catch (e) {
    return 'Erreur : ' + e.message
  }
})

ipcMain.handle('stt', async (_, buf) => {
  if (!cfg.groqKey) return { error: 'Clé Groq requise pour la voix (Réglages)' }
  try {
    const fd = new FormData()
    fd.append('file', new Blob([buf], { type: 'audio/webm' }), 'a.webm')
    fd.append('model', 'whisper-large-v3-turbo')
    fd.append('prompt', 'Verity')
    const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + cfg.groqKey },
      body: fd
    })
    if (!r.ok) return { error: r.status + ' ' + (await r.text()).slice(0, 200) }
    return { text: (await r.json()).text.trim() }
  } catch (e) {
    return { error: e.message }
  }
})

let tts = null
let ttsVoice = ''

const signed = (n, unit) => (n >= 0 ? '+' : '') + n + unit

async function synth(text, mood) {
  try {
    if (!tts || ttsVoice !== cfg.ttsVoice) {
      if (tts) {
        try {
          tts.close()
        } catch {}
      }
      tts = new MsEdgeTTS()
      await tts.setMetadata(cfg.ttsVoice, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3)
      ttsVoice = cfg.ttsVoice
    }
    const safe = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const lvl = (mood && mood.level) || 0
    const { audioStream } = tts.toStream(safe, {
      pitch: signed((Number(cfg.ttsPitch) || 0) - (lvl >= 2 ? 10 : 0), 'Hz'),
      rate: signed((Number(cfg.ttsRate) || 0) + (lvl >= 3 ? 10 : lvl >= 2 ? 6 : 0), '%')
    })
    const chunks = []
    await new Promise((resolve, reject) => {
      audioStream.on('data', (c) => chunks.push(c))
      audioStream.on('end', resolve)
      audioStream.on('close', resolve)
      audioStream.on('error', reject)
    })
    const buf = Buffer.concat(chunks)
    if (!buf.length) throw new Error('audio vide')
    return buf
  } catch (e) {
    tts = null
    throw e
  }
}

const fallbackVoices = [
  ['fr-FR-VivienneMultilingualNeural', 'Vivienne (douce, multilingue)'],
  ['fr-FR-DeniseNeural', 'Denise (élégante)'],
  ['fr-FR-EloiseNeural', 'Eloise (jeune)'],
  ['fr-FR-RemyMultilingualNeural', 'Rémy (homme, multilingue)'],
  ['fr-FR-HenriNeural', 'Henri (homme)'],
  ['en-US-AriaNeural', 'Aria (English)'],
  ['en-US-JennyNeural', 'Jenny (English)']
].map(([name, label]) => ({ name, label }))

function moodTag(mood) {
  if (!mood) return ''
  if (mood.level >= 3) return '[angry][shouting] '
  if (mood.level === 2) return '[angry] '
  if (mood.level === 1) return '[annoyed] '
  if (mood.value >= 70) return '[excited] '
  return ''
}

async function synthFish(text, mood) {
  if (!cfg.fishKey) throw new Error('clé API manquante (Réglages)')
  const lvl = (mood && mood.level) || 0
  const r = await fetch('https://api.fish.audio/v1/tts', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + cfg.fishKey,
      'Content-Type': 'application/json',
      model: cfg.fishModel || 's2.1-pro-free'
    },
    body: JSON.stringify({
      text: moodTag(mood) + text,
      reference_id: cfg.fishVoiceId,
      format: 'mp3',
      mp3_bitrate: 128,
      latency: 'balanced',
      normalize: true,
      prosody: { speed: lvl >= 3 ? 1.1 : lvl === 1 ? 0.95 : 1 }
    }),
    signal: AbortSignal.timeout(25000)
  })
  if (!r.ok) throw new Error(r.status + ' ' + (await r.text()).slice(0, 200))
  const buf = Buffer.from(await r.arrayBuffer())
  if (!buf.length) throw new Error('audio vide')
  return buf
}

ipcMain.handle('tts', async (_, text, mood) => {
  const t = String(text).slice(0, 900)
  let warn
  if (cfg.ttsEngine === 'fish') {
    try {
      return { audio: await synthFish(t, mood), engine: 'fish' }
    } catch (e) {
      warn = 'Fish Audio : ' + e.message
      console.error(warn)
    }
  }
  try {
    return { audio: await synth(t, mood), engine: 'edge', warn }
  } catch (e) {
    return { error: warn ? warn + ' | Edge : ' + e.message : e.message }
  }
})

ipcMain.handle('voices', async () => {
  try {
    const list = await new MsEdgeTTS().getVoices()
    const fr = list
      .filter((v) => /^(fr|en)-/.test(v.Locale))
      .map((v) => ({ name: v.ShortName, label: v.FriendlyName.replace(/^Microsoft /, '') }))
    return fr.length ? fr : fallbackVoices
  } catch {
    return fallbackVoices
  }
})


// ---- bulle (notifications depuis le process principal) -----------------------
function notify(text, ms = 5000) {
  if (!bubbleWin || bubbleWin.isDestroyed()) return
  bubbleWin.webContents.send('text', text)
  clearTimeout(bubbleTimer)
  bubbleTimer = setTimeout(hideBubble, ms)
}

// ---- mises à jour automatiques (GitHub Releases, sans dépendance) -------------
const REPO = 'Grungyyt/verity-helper'
let updating = false

function isNewer(a, b) {
  const pa = String(a).replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0)
  const pb = String(b).replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true
    if ((pa[i] || 0) < (pb[i] || 0)) return false
  }
  return false
}

async function checkUpdate(manual) {
  if (updating) return
  try {
    const r = await fetch('https://api.github.com/repos/' + REPO + '/releases/latest', {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Verity-Updater' },
      signal: AbortSignal.timeout(15000)
    })
    if (r.status === 404) return manual ? notify('No release published yet.', 5000) : undefined
    if (!r.ok) throw new Error(r.status + ' ' + (await r.text()).slice(0, 120))
    const rel = await r.json()
    const v = rel.tag_name
    if (!isNewer(v, app.getVersion())) return manual ? notify('Verity is up to date (v' + app.getVersion() + ').', 4000) : undefined
    if (!app.isPackaged || process.platform !== 'win32') return notify('Update ' + v + ' available on GitHub.', 6000)

    const asset = (rel.assets || []).find((a) => /\.exe$/i.test(a.name))
    if (!asset) throw new Error('aucun installeur .exe dans la release')
    // seuls les fichiers hébergés par GitHub sont acceptés
    const u = new URL(asset.browser_download_url)
    if (u.protocol !== 'https:' || !/(^|\.)github(usercontent)?\.com$/.test(u.hostname)) throw new Error('URL de téléchargement refusée')

    updating = true
    notify('Downloading update ' + v + '…', 120000)
    const d = await fetch(asset.browser_download_url, { headers: { 'User-Agent': 'Verity-Updater' }, signal: AbortSignal.timeout(300000) })
    if (!d.ok) throw new Error('téléchargement ' + d.status)
    const buf = Buffer.from(await d.arrayBuffer())
    if (/^sha256:/.test(asset.digest || '')) {
      const h = crypto.createHash('sha256').update(buf).digest('hex')
      if (h !== asset.digest.slice(7).toLowerCase()) throw new Error('somme de contrôle invalide')
    }
    const file = path.join(app.getPath('temp'), 'verity-update-' + path.basename(asset.name))
    fs.writeFileSync(file, buf)
    notify('Installing ' + v + '… see you in a moment!', 6000)
    spawn(file, ['/S', '--force-run'], { detached: true, stdio: 'ignore' }).unref()
    setTimeout(() => app.quit(), 2000)
  } catch (e) {
    updating = false
    console.error('update:', e.message)
    if (manual) notify('Update failed: ' + e.message, 7000)
  }
}

// ---- actions sur le PC (liste blanche stricte, déclenchées uniquement par la voix de l'utilisateur) ----
const nm = (s) =>
  String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()

const BUILTIN = {
  notepad: 'notepad.exe',
  'bloc notes': 'notepad.exe',
  calculator: 'calc.exe',
  calculatrice: 'calc.exe',
  calc: 'calc.exe',
  paint: 'mspaint.exe',
  'task manager': 'taskmgr.exe',
  'gestionnaire des taches': 'taskmgr.exe',
  explorer: 'explorer.exe',
  'file explorer': 'explorer.exe',
  explorateur: 'explorer.exe'
}
const SITES = {
  youtube: 'https://www.youtube.com',
  google: 'https://www.google.com',
  gmail: 'https://mail.google.com',
  github: 'https://github.com',
  twitch: 'https://www.twitch.tv',
  twitter: 'https://x.com',
  x: 'https://x.com',
  reddit: 'https://www.reddit.com',
  netflix: 'https://www.netflix.com',
  spotify: 'https://open.spotify.com',
  discord: 'https://discord.com/app',
  chatgpt: 'https://chatgpt.com',
  wikipedia: 'https://wikipedia.org',
  maps: 'https://maps.google.com',
  'google maps': 'https://maps.google.com',
  tiktok: 'https://www.tiktok.com',
  instagram: 'https://www.instagram.com'
}
const folderOf = (t) =>
  ({
    downloads: 'downloads',
    telechargements: 'downloads',
    documents: 'documents',
    desktop: 'desktop',
    bureau: 'desktop',
    pictures: 'pictures',
    images: 'pictures',
    music: 'music',
    musique: 'music',
    videos: 'videos'
  })[t]

let startApps = null
let startAt = 0
function scanDir(dir, depth, out) {
  let ents
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of ents) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (depth < 3) scanDir(p, depth + 1, out)
    } else if (/\.lnk$/i.test(e.name) && !/uninstall|readme|help|documentation|license/i.test(e.name)) {
      out.push({ name: e.name.replace(/\.lnk$/i, ''), n: nm(e.name.replace(/\.lnk$/i, '')), file: p })
    }
  }
}
function findApp(q) {
  if (process.platform !== 'win32' || q.length < 2) return null
  if (!startApps || Date.now() - startAt > 300000) {
    startApps = []
    for (const base of [process.env.ProgramData, process.env.APPDATA])
      if (base) scanDir(path.join(base, 'Microsoft', 'Windows', 'Start Menu', 'Programs'), 0, startApps)
    startAt = Date.now()
  }
  return startApps.find((a) => a.n === q) || startApps.find((a) => a.n.startsWith(q)) || startApps.find((a) => a.n.includes(q)) || null
}

async function openTarget(raw) {
  const t = nm(raw)
  if (!t) return { ok: false }
  if (process.platform === 'win32' && BUILTIN[t]) {
    spawn(BUILTIN[t], [], { detached: true, stdio: 'ignore' }).unref()
    return { ok: true, name: raw }
  }
  if (t === 'settings' || t === 'parametres') {
    await shell.openExternal('ms-settings:')
    return { ok: true, name: 'Settings' }
  }
  const f = folderOf(t)
  if (f) {
    await shell.openPath(app.getPath(f))
    return { ok: true, name: raw }
  }
  const a = findApp(t)
  if (a && !(await shell.openPath(a.file))) return { ok: true, name: a.name }
  if (SITES[t]) {
    await shell.openExternal(SITES[t])
    return { ok: true, name: raw }
  }
  const dom = String(raw).trim().toLowerCase()
  if (/^(?:[a-z0-9-]+\.)+(com|fr|net|org|io|gg|tv|dev|app|co|eu|info)$/.test(dom)) {
    await shell.openExternal('https://' + dom)
    return { ok: true, name: dom }
  }
  return { ok: false, name: raw }
}

async function grabScreen() {
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const w = 1600
  const h = Math.round((w * d.size.height) / d.size.width)
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: w, height: h } })
  const src = sources.find((s) => s.display_id === String(d.id)) || sources[0]
  if (!src) throw new Error('aucun écran')
  return 'data:image/jpeg;base64,' + src.thumbnail.toJPEG(70).toString('base64')
}

async function vision(question, dataUrl, system) {
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: [{ type: 'text', text: question }, { type: 'image_url', image_url: { url: dataUrl } }] }
  ]
  const tries = []
  if (cfg.groqKey) tries.push(['https://api.groq.com/openai/v1/chat/completions', cfg.groqKey, { model: cfg.visionModel, messages, max_tokens: 300 }])
  tries.push(['https://text.pollinations.ai/openai', '', { model: 'openai', messages }])
  let err = ''
  for (const [url, key, body] of tries) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(40000)
      })
      if (r.ok) return (await r.json()).choices[0].message.content || ''
      err = r.status + ' ' + (await r.text()).slice(0, 160)
    } catch (e) {
      err = e.message
    }
  }
  throw new Error(err)
}

ipcMain.handle('act', async (_, a) => {
  try {
    if (a.type === 'open' || a.type === 'search') {
      if (!cfg.allowOpen) return { error: 'disabled' }
      if (a.type === 'open') return await openTarget(String(a.target).slice(0, 60))
      const q = String(a.query).slice(0, 200)
      const base = a.engine === 'youtube' ? 'https://www.youtube.com/results?search_query=' : 'https://www.google.com/search?q='
      await shell.openExternal(base + encodeURIComponent(q))
      return { ok: true, name: q }
    }
    if (a.type === 'screen') {
      if (!cfg.allowScreen) return { error: 'disabled' }
      const img = await grabScreen()
      return { text: await vision(String(a.question).slice(0, 500), img, String(a.system).slice(0, 4000)) }
    }
    return { error: 'unknown' }
  } catch (e) {
    return { error: e.message }
  }
})

ipcMain.handle('checkUpdate', () => checkUpdate(true))

ipcMain.handle('getConfig', () => cfg)
ipcMain.handle('setConfig', (_, data) => {
  Object.assign(cfg, data)
  save()
  buildMenu()
})

ipcMain.on('command', (_, name) => {
  if (name === 'follow') setFollow(true)
  else if (name === 'stop') setFollow(false)
  else if (name === 'jump') jump(230)
})

ipcMain.on('say', (_, text, ms) => {
  bubbleWin.webContents.send('text', text)
  clearTimeout(bubbleTimer)
  bubbleTimer = setTimeout(hideBubble, ms)
})

ipcMain.on('bubble-size', (_, h) => {
  bubbleH = clamp(h, 30, 230)
  bubbleOn = true
  placeBubble()
  bubbleWin.showInactive()
})

ipcMain.on('drag', (_, state) => {
  if (state) {
    const c = screen.getCursorScreenPoint()
    grab = { x: c.x - ball.x, y: c.y - ball.y }
    dragging = true
    ball.vx = 0
    ball.vy = 0
  } else if (dragging) {
    dragging = false
    ball.vx = clamp(ball.vx, -MAX_SPEED, MAX_SPEED)
    ball.vy = clamp(ball.vy, -MAX_SPEED, MAX_SPEED)
  }
})

app.whenReady().then(() => {
  load()
  session.defaultSession.setPermissionRequestHandler((_, permission, cb) => cb(permission === 'media'))
  session.defaultSession.setPermissionCheckHandler(() => true)

  createWindows()
  dropBall()
  startScanner()

  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png')).resize({ width: 16, height: 16 })
  tray = new Tray(icon)
  tray.setToolTip('Verity')
  tray.on('click', () => (win.isVisible() ? win.hide() : win.show()))
  buildMenu()

  setInterval(tick, 16)

  setTimeout(() => cfg.autoUpdate !== false && checkUpdate(false), 10000)
  setInterval(() => cfg.autoUpdate !== false && checkUpdate(false), 4 * 3600 * 1000)

  let held = false
  uIOhook.on('keydown', (e) => {
    if (e.keycode === UiohookKey.K && !held) {
      held = true
      win.webContents.send('ptt', true)
    }
  })
  uIOhook.on('keyup', (e) => {
    if (e.keycode === UiohookKey.K && held) {
      held = false
      win.webContents.send('ptt', false)
    }
  })
  uIOhook.start()
})

app.on('will-quit', () => {
  try {
    uIOhook.stop()
  } catch {}
  if (scanner) scanner.kill()
})

app.on('window-all-closed', (e) => e.preventDefault())
