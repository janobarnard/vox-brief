// ============================================================
// Theme toggle
// ============================================================

function updateThemeIcon() {
  const isDark = document.documentElement.classList.contains('dark');
  document.getElementById('iconSun').classList.toggle('hidden', !isDark);
  document.getElementById('iconMoon').classList.toggle('hidden', isDark);
}

document.addEventListener('DOMContentLoaded', () => {
  updateThemeIcon();
  document.getElementById('themeToggle').addEventListener('click', () => {
    const html = document.documentElement;
    html.classList.add('theme-transitioning');
    html.classList.toggle('dark');
    localStorage.setItem('theme', html.classList.contains('dark') ? 'dark' : 'light');
    updateThemeIcon();
    setTimeout(() => html.classList.remove('theme-transitioning'), 300);
  });
});

// ============================================================
// Config
// ============================================================
const LOCAL_WS_URL = 'ws://localhost:8000/ws/call';
const SAMPLE_RATE = 16000;         // Must match Nova Sonic config
const CAPTURE_BUFFER = 4096;       // ScriptProcessor buffer size

async function getWsUrl() {
  // On localhost: use local dev server directly
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    return LOCAL_WS_URL;
  }
  // In production: fetch a SigV4 presigned URL from the presign API
  const cfg = await fetch('/config.json').then(r => r.json());
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.demoToken) headers['x-demo-token'] = cfg.demoToken;
  const { wsUrl } = await fetch(cfg.presignUrl, { method: 'POST', headers }).then(r => r.json());
  return wsUrl;
}

// ============================================================
// State
// ============================================================
let state = 'idle'; // idle | connecting | live | processing | done | error
let ws = null;
let audioCtx = null;
let mediaStream = null;
let scriptProcessor = null;
let nextPlayTime = 0;
let isMuted = false;
let lastTranscriptRole = null;
let lastTranscriptContent = null;
let pendingAgentText = []; // { text, showAt }
let scheduledSources = [];

// ============================================================
// DOM refs
// ============================================================
const startBtn        = document.getElementById('startBtn');
const startWrap       = document.getElementById('startWrap');
const callControls    = document.getElementById('callControls');
const callEndedWrap   = document.getElementById('callEndedWrap');
const muteBtn         = document.getElementById('muteBtn');
const muteLabel       = document.getElementById('muteLabel');
const muteIcon        = document.getElementById('muteIcon');
const hangupBtn       = document.getElementById('hangupBtn');
const statusText      = document.getElementById('statusText');
const waveform        = document.getElementById('waveform');
const pulseRing       = document.getElementById('pulseRing');
const transcriptCard  = document.getElementById('transcriptCard');
const transcriptBody  = document.getElementById('transcriptBody');
const recDot          = document.getElementById('recDot');
const digestCard      = document.getElementById('digestCard');
const digestLoading   = document.getElementById('digestLoading');
const digestContent   = document.getElementById('digestContent');
const digestSummary   = document.getElementById('digestSummary');
const digestTakeaways = document.getElementById('digestTakeaways');
const digestActions   = document.getElementById('digestActions');
const digestDangers   = document.getElementById('digestDangers');
const sentimentBadge  = document.getElementById('sentimentBadge');
const newCallBtn      = document.getElementById('newCallBtn');

// ============================================================
// Audio helpers
// ============================================================

function downsample(buf, fromRate, toRate) {
  if (fromRate === toRate) return buf;
  const ratio = fromRate / toRate;
  const out = new Float32Array(Math.floor(buf.length / ratio));
  for (let i = 0; i < out.length; i++) out[i] = buf[Math.floor(i * ratio)];
  return out;
}

function float32ToInt16(float32) {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const x = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = x < 0 ? x * 0x8000 : x * 0x7FFF;
  }
  return int16;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToInt16Array(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

// ============================================================
// Audio capture
// ============================================================

async function startCapture() {
  mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  audioCtx = new AudioContext();

  const src = audioCtx.createMediaStreamSource(mediaStream);
  scriptProcessor = audioCtx.createScriptProcessor(CAPTURE_BUFFER, 1, 1);

  scriptProcessor.onaudioprocess = (e) => {
    if (isMuted || state !== 'live' || !ws || ws.readyState !== WebSocket.OPEN) return;
    const raw = e.inputBuffer.getChannelData(0);
    const ds = downsample(raw, audioCtx.sampleRate, SAMPLE_RATE);
    const pcm = float32ToInt16(ds);
    const b64 = arrayBufferToBase64(pcm.buffer);
    ws.send(JSON.stringify({ type: 'audio', data: b64 }));
  };

  src.connect(scriptProcessor);
  scriptProcessor.connect(audioCtx.destination);
}

function stopCapture() {
  if (scriptProcessor) {
    scriptProcessor.disconnect();
    scriptProcessor.onaudioprocess = null;
    scriptProcessor = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach(t => t.stop());
    mediaStream = null;
  }
}

// ============================================================
// Audio playback
// ============================================================

function playAudioChunk(b64) {
  if (!audioCtx) return;
  const int16 = base64ToInt16Array(b64);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768.0;

  const buffer = audioCtx.createBuffer(1, float32.length, SAMPLE_RATE);
  buffer.copyToChannel(float32, 0);

  const source = audioCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(audioCtx.destination);

  const now = audioCtx.currentTime;
  if (nextPlayTime < now) nextPlayTime = now + 0.05; // small initial buffer
  source.start(nextPlayTime);
  nextPlayTime += buffer.duration;
  scheduledSources.push(source);
  source.onended = () => {
    scheduledSources = scheduledSources.filter(s => s !== source);
  };
}

function clearAudioQueue() {
  for (const s of scheduledSources) {
    try { s.stop(); } catch {}
  }
  scheduledSources = [];
  nextPlayTime = 0;
  pendingAgentText = [];
  // Truncate last agent line to show it was interrupted
  if (lastTranscriptRole === 'agent' && lastTranscriptContent) {
    lastTranscriptContent.textContent = lastTranscriptContent.textContent.trimEnd() + '…';
  }
}

// ============================================================
// WebSocket connection
// ============================================================

async function connect() {
  setState('connecting');
  setStatus('Requesting microphone access…');
  pulseRing.style.opacity = '1';

  try {
    await startCapture();
  } catch (e) {
    setStatus('Microphone access denied.', 'error');
    pulseRing.style.opacity = '0';
    setState('idle');
    return;
  }

  setStatus('Connecting to Alex…');
  const wsUrl = await getWsUrl();
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    // Send a start message immediately — AgentCore's WS proxy
    // doesn't forward server→client messages until the client
    // sends at least one message.
    ws.send(JSON.stringify({ type: 'start' }));
  };

  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleMessage(msg);
  };

  ws.onerror = () => {
    setStatus('Connection error. Is the server running?', 'error');
    setState('idle');
    stopCapture();
  };

  ws.onclose = () => {
    if (state === 'live') {
      // Unexpected close — treat as hangup
      onCallEnded();
    }
  };
}

function disconnect() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'hangup' }));
  }
}

// ============================================================
// Message handler
// ============================================================

function handleMessage(msg) {
  switch (msg.type) {

    case 'status':
      handleStatus(msg.state);
      break;

    case 'audio':
      playAudioChunk(msg.data);
      setWaveformActive(true, 'agent');
      break;

    case 'transcript':
      if (msg.role === 'user') clearAudioQueue();
      addTranscriptLine(msg.role, msg.text);
      if (msg.role === 'agent') setWaveformActive(false);
      break;

    case 'digest':
      renderDigest(msg.data);
      break;

    case 'error':
      setStatus('Error: ' + msg.message, 'error');
      setState('idle');
      stopCapture();
      break;
  }
}

function handleStatus(s) {
  switch (s) {
    case 'connecting':
      setStatus('Connecting to Alex…');
      pulseRing.style.opacity = '1';
      break;

    case 'live':
      setState('live');
      setStatus('Alex is ready. Say hello to start the conversation.');
      pulseRing.style.opacity = '0';
      break;

    case 'processing':
      setState('processing');
      setStatus('Generating your call digest…');
      stopCapture();
      recDot.classList.add('hidden');
      setWaveformActive(false);
      digestCard.classList.remove('hidden');
      digestLoading.classList.remove('hidden');
      digestContent.classList.add('hidden');
      break;

    case 'done':
      // No digest coming (e.g. empty transcript) — go straight to idle
      stopCapture();
      setWaveformActive(false);
      setState('done');
      setStatus('Interview ended — no feedback to summarise.');
      break;
  }
}

// ============================================================
// Call lifecycle
// ============================================================

function onCallEnded() {
  setState('processing');
  setStatus('Call ended. Generating your digest…');
  stopCapture();
  recDot.classList.add('hidden');
  setWaveformActive(false);
  // Flush remaining agent text
  for (const { text } of pendingAgentText) _renderTranscriptLine('agent', text);
  pendingAgentText = [];
  digestCard.classList.remove('hidden');
  digestLoading.classList.remove('hidden');
  digestContent.classList.add('hidden');
}

// ============================================================
// Transcript rendering
// ============================================================

function addTranscriptLine(role, text) {
  if (role === 'agent' && audioCtx) {
    // Hold until audio clock reaches current buffer position
    // (text arrives just before its corresponding audio)
    pendingAgentText.push({ text, showAt: nextPlayTime });
    return;
  }
  _renderTranscriptLine(role, text);
}

// Show agent text chunks as their audio plays
setInterval(() => {
  if (!audioCtx || pendingAgentText.length === 0) return;
  const now = audioCtx.currentTime;
  while (pendingAgentText.length > 0 && now >= pendingAgentText[0].showAt) {
    const { text } = pendingAgentText.shift();
    _renderTranscriptLine('agent', text);
  }
}, 50);

function _renderTranscriptLine(role, text) {
  transcriptCard.classList.remove('hidden');

  // Group consecutive messages from the same role into one entry
  if (role === lastTranscriptRole && lastTranscriptContent) {
    lastTranscriptContent.textContent += ' ' + text;
  } else {
    const line = document.createElement('div');
    line.className = 'transcript-line flex gap-2';

    const label = document.createElement('span');
    label.className = role === 'agent'
      ? 'transcript-agent font-medium shrink-0 w-12 text-right'
      : 'transcript-user font-medium shrink-0 w-12 text-right';
    label.textContent = role === 'agent' ? 'Alex' : 'You';

    const content = document.createElement('span');
    content.className = 'transcript-text leading-snug';
    content.textContent = text;

    line.appendChild(label);
    line.appendChild(content);
    transcriptBody.appendChild(line);

    lastTranscriptRole = role;
    lastTranscriptContent = content;
  }
  transcriptBody.scrollTop = transcriptBody.scrollHeight;
}


// ============================================================
// Digest rendering
// ============================================================

function renderDigest(data) {
  digestLoading.classList.add('hidden');
  digestContent.classList.remove('hidden');

  // Summary
  digestSummary.textContent = data.summary || '';

  // Sentiment badge
  const s = data.sentiment || 'neutral';
  sentimentBadge.textContent = s.charAt(0).toUpperCase() + s.slice(1);
  sentimentBadge.className = `text-xs font-medium px-3 py-1 rounded-full shrink-0 sentiment-${s}`;

  // Highlights + pain points as takeaways
  const takeaways = [
    ...(data.highlights || []).map(h => '✦ ' + h),
    ...(data.pain_points || []).map(p => '✗ ' + p),
  ];
  renderList(digestTakeaways, takeaways, '→');

  // Action items
  renderList(digestActions, data.action_items || [], '✓');

  // Danger items
  const hasDangers = data.danger_items?.length > 0;
  document.getElementById('dangersSection').classList.toggle('hidden', !hasDangers);
  if (hasDangers) renderList(digestDangers, data.danger_items, '⚠');

  setState('done');
  setStatus('Interview complete. Here\'s your digest.');
}

function renderList(el, items, icon) {
  el.innerHTML = '';
  for (const item of items) {
    const li = document.createElement('li');
    li.className = 'flex gap-2';
    li.innerHTML = `<span class="shrink-0 opacity-50">${esc(icon)}</span><span>${esc(item)}</span>`;
    el.appendChild(li);
  }
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ============================================================
// UI state machine
// ============================================================

function setState(s) {
  state = s;

  const showStart    = s === 'idle' || s === 'done';
  const showControls = s === 'live';
  const showEnded    = s === 'processing';

  startWrap.classList.toggle('hidden', !showStart);
  callControls.classList.toggle('hidden', !showControls);
  callEndedWrap.classList.toggle('hidden', !showEnded);

  startBtn.textContent = s === 'done' ? 'Start Another Interview' : 'Talk with Agent';
  if (s === 'done') {
    startBtn.innerHTML = `<svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path d="M2 3.5A1.5 1.5 0 013.5 2h1.148a1.5 1.5 0 011.465 1.175l.716 3.223a1.5 1.5 0 01-1.052 1.767l-.933.267c-.41.117-.643.555-.48.95a11.542 11.542 0 006.254 6.254c.395.163.833-.07.95-.48l.267-.933a1.5 1.5 0 011.767-1.052l3.223.716A1.5 1.5 0 0118 15.352V16.5a1.5 1.5 0 01-1.5 1.5H15c-1.149 0-2.263-.15-3.326-.43A13.022 13.022 0 012.43 8.326 13.019 13.019 0 012 5V3.5z"/></svg> Start Another Interview`;
  } else if (s === 'idle') {
    startBtn.innerHTML = `<svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path d="M2 3.5A1.5 1.5 0 013.5 2h1.148a1.5 1.5 0 011.465 1.175l.716 3.223a1.5 1.5 0 01-1.052 1.767l-.933.267c-.41.117-.643.555-.48.95a11.542 11.542 0 006.254 6.254c.395.163.833-.07.95-.48l.267-.933a1.5 1.5 0 011.767-1.052l3.223.716A1.5 1.5 0 0118 15.352V16.5a1.5 1.5 0 01-1.5 1.5H15c-1.149 0-2.263-.15-3.326-.43A13.022 13.022 0 012.43 8.326 13.019 13.019 0 012 5V3.5z"/></svg> Talk with Agent`;
  }
}

function setStatus(text, type = '') {
  statusText.textContent = text;
  statusText.className = {
    error: 'error text-sm mb-6',
    done:  'success text-sm mb-6',
  }[type] ?? 'text-sm mb-6';
}

function setWaveformActive(active, role = 'agent') {
  waveform.classList.toggle('active', active);
  waveform.querySelectorAll('.waveform-bar').forEach(bar => {
    bar.className = `waveform-bar ${role}`;
  });
}

// ============================================================
// Button handlers
// ============================================================

startBtn.addEventListener('click', () => {
  // Reset UI for a new call
  transcriptBody.innerHTML = '';
  transcriptCard.classList.add('hidden');
  digestCard.classList.add('hidden');
  recDot.classList.remove('hidden');
  pulseRing.style.opacity = '0';
  isMuted = false;
  muteLabel.textContent = 'Mute';
  nextPlayTime = 0;
  lastTranscriptRole = null;
  lastTranscriptContent = null;
  pendingAgentText = [];
  connect();
});

hangupBtn.addEventListener('click', () => {
  // Immediately stop audio and update UI — don't wait for server
  clearAudioQueue();
  stopCapture();
  recDot.classList.add('hidden');
  setWaveformActive(false);

  // If no transcript lines exist, skip digest entirely
  if (transcriptBody.children.length === 0) {
    setState('done');
    setStatus('Interview ended — no feedback to summarise.');
    disconnect();
    return;
  }

  setState('processing');
  setStatus('Call ended — generating your digest…');
  digestCard.classList.remove('hidden');
  digestLoading.classList.remove('hidden');
  digestContent.classList.add('hidden');
  disconnect();
});

muteBtn.addEventListener('click', () => {
  isMuted = !isMuted;
  muteLabel.textContent = isMuted ? 'Unmute' : 'Mute';
  muteBtn.classList.toggle('bg-amber-900/40', isMuted);
  muteBtn.classList.toggle('border-amber-700', isMuted);
  muteBtn.classList.toggle('text-amber-300', isMuted);
});

newCallBtn.addEventListener('click', () => {
  transcriptBody.innerHTML = '';
  transcriptCard.classList.add('hidden');
  digestCard.classList.add('hidden');
  recDot.classList.remove('hidden');
  isMuted = false;
  nextPlayTime = 0;
  setState('idle');
  setStatus('Click the button below to begin your interview.');
  connect();
});
