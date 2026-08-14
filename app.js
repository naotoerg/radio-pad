const DB_NAME = 'radio-pad-db';
const STORE = 'sounds';
const LETTER_CONFIG_KEY = 'radio-pad-letter-config';
const READ_LETTERS_KEY = 'radio-pad-read-letters';
let sounds = [];
let letters = [];
let lettersLoading = false;
const playing = new Map();
const audioEngines = new Map();
const scheduledAttempts = new Map();
const timerBuffers = new Map();
let timerAudioContext = null;
let pendingRandomFiles = [];
const shuffleIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="16 3 21 3 21 8"></polyline><line x1="4" y1="20" x2="21" y2="3"></line><polyline points="21 16 21 21 16 21"></polyline><line x1="15" y1="15" x2="21" y2="21"></line><line x1="4" y1="4" x2="9" y2="9"></line></svg>';
const clockIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><polyline points="12 7 12 12 16 14"></polyline></svg>';

const $ = (selector) => document.querySelector(selector);
const ui = { grid: $('#soundGrid'), input: $('#fileInput'), folderInput: $('#folderInput'), addDialog: $('#addDialog'), stop: $('#stopAll'), now: $('#nowPlaying'), dot: $('#statusDot'), dialog: $('#editDialog') };

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function readSounds() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE).objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result.sort((a,b) => a.createdAt - b.createdAt));
    req.onerror = () => reject(req.error);
  });
}

async function saveSound(sound) { const db = await openDb(); return txDone(db.transaction(STORE, 'readwrite'), tx => tx.objectStore(STORE).put(sound)); }
async function removeSound(id) { const db = await openDb(); return txDone(db.transaction(STORE, 'readwrite'), tx => tx.objectStore(STORE).delete(id)); }
function txDone(tx, action) { return new Promise((resolve,reject) => { action(tx); tx.oncomplete=resolve; tx.onerror=()=>reject(tx.error); }); }

function render() {
  syncAudioEngines();
  ui.grid.replaceChildren();
  const cards = [];
  const waveformJobs = [];
  sounds.filter(sound => !sound.group).forEach(sound => {
    const card = $('#soundTemplate').content.firstElementChild.cloneNode(true);
    card.dataset.id = sound.id;
    card.querySelector('.sound-name').textContent = sound.name;
    card.querySelector('.group-label').textContent = sound.scheduleEnabled ? `自動 ${sound.scheduleTime}` : '';
    if (sound.scheduleEnabled) { card.classList.add('scheduled-pad'); card.querySelector('.play-icon').innerHTML=clockIcon; }
    if (!sound.scheduleEnabled) card.querySelector('.card-footer').classList.add('settings-only');
    card.querySelector('.play-pad').addEventListener('click', () => playSound(sound));
    card.querySelector('.edit-button').addEventListener('click', () => editSound(sound));
    waveformJobs.push({ sound, card });
    cards.push({ title:sound.name, card });
  });
  const groups = new Map();
  sounds.filter(s => s.group).forEach(sound => {
    if (!groups.has(sound.group)) groups.set(sound.group, []);
    groups.get(sound.group).push(sound);
  });
  groups.forEach((items, name) => {
    const card = $('#soundTemplate').content.firstElementChild.cloneNode(true);
    const padKey = `group:${name}`;
    card.classList.add('random-pad');
    card.dataset.id = padKey;
    card.querySelector('.play-icon').innerHTML = shuffleIcon;
    card.querySelector('.sound-name').textContent = name;
    const scheduleTime=items.find(item => item.scheduleEnabled)?.scheduleTime;
    card.querySelector('.group-label').textContent = `ランダム・${items.length}音${scheduleTime ? `・自動 ${scheduleTime}` : ''}`;
    if (scheduleTime) { card.classList.add('scheduled-pad'); card.querySelector('.play-icon').innerHTML=clockIcon; }
    card.querySelector('.edit-button').hidden = true;
    card.querySelector('.edit-button').hidden = false;
    card.querySelector('.edit-button').addEventListener('click', () => editGroup(name, items));
    card.querySelector('.play-pad').addEventListener('click', () => {
      const item = items[Math.floor(Math.random() * items.length)];
      playSound(item, padKey, `${name}（${item.name}）`, items.some(entry => entry.overlay));
    });
    waveformJobs.push({ sound:items[0], card });
    cards.push({ title:name, card });
  });
  cards.sort((a,b) => a.title.localeCompare(b.title, undefined, {numeric:true,sensitivity:'base'})).forEach(item => ui.grid.append(item.card));
  refreshPlayingUI();
  prepareWaveforms(waveformJobs);
}

async function prepareWaveforms(jobs) {
  for (const {sound,card} of jobs) {
    if (!card.isConnected || !sound) continue;
    await ensureWaveform(sound,card);
    await new Promise(resolve => setTimeout(resolve,0));
  }
}

async function ensureWaveform(sound,card) {
  if (!sound.waveform || sound.waveform.length < 90) {
    sound.waveform=await createWaveform(sound.blob);
    if (sound.waveform) await saveSound(sound);
  }
  if (sound.waveform && card?.isConnected) drawWaveform(card,sound.waveform);
}

async function createWaveform(blob) {
  const AudioContextClass=window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;
  let context;
  try {
    context=new AudioContextClass();
    const buffer=await context.decodeAudioData(await blob.arrayBuffer());
    const data=buffer.getChannelData(0); const bars=96; const size=Math.max(1,Math.floor(data.length/bars)); const peaks=[];
    for (let i=0;i<bars;i++) { let peak=0; const end=Math.min(data.length,(i+1)*size); for (let j=i*size;j<end;j+=Math.max(1,Math.floor(size/160))) peak=Math.max(peak,Math.abs(data[j])); peaks.push(peak); }
    const max=Math.max(...peaks,.01); return peaks.map(value => Math.max(.08,value/max));
  } catch { return null; }
  finally { if (context) context.close().catch(()=>{}); }
}

function drawWaveform(card,peaks) {
  const path=peaks.map((peak,index) => { const h=Math.max(2,peak*36); const x=index*2; return `M${x} ${40-h}h1v${h}h-1z`; }).join('');
  const svg=`<svg viewBox="0 0 192 40" preserveAspectRatio="none"><path d="${path}"/></svg>`;
  card.querySelector('.waveform').innerHTML=`<span class="waveform-layer waveform-base">${svg}</span><span class="waveform-layer waveform-played">${svg}</span>`;
}

function ensureAudioEngine(sound) {
  const existing=audioEngines.get(sound.id);
  if (existing) return existing;
  const playableBlob=normalizeAudioBlob(sound.blob,sound.originalName || sound.name);
  const url=URL.createObjectURL(playableBlob);
  const audio=document.createElement('audio');
  audio.className='audio-engine'; audio.src=url; audio.preload='none'; audio.playsInline=true; audio.muted=false; audio.volume=1;
  document.body.append(audio);
  const engine={audio,url}; audioEngines.set(sound.id,engine); return engine;
}

function disposeAudioEngine(soundId) {
  timerBuffers.delete(soundId);
  const engine=audioEngines.get(soundId); if (!engine) return;
  engine.audio.pause(); engine.audio.removeAttribute('src'); engine.audio.load(); engine.audio.remove(); URL.revokeObjectURL(engine.url); audioEngines.delete(soundId);
}

function syncAudioEngines() {
  const ids=new Set(sounds.map(sound => sound.id));
  [...audioEngines.keys()].filter(id => !ids.has(id)).forEach(disposeAudioEngine);
  sounds.forEach(ensureAudioEngine);
}

async function unlockTimerAudio() {
  const AudioContextClass=window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return false;
  if (!timerAudioContext) timerAudioContext=new AudioContextClass();
  try { if (timerAudioContext.state !== 'running') await timerAudioContext.resume(); }
  catch { return false; }
  const ready=timerAudioContext.state === 'running';
  const button=$('#enableTimerAudio');
  button.classList.toggle('ready',ready); button.textContent=ready ? 'タイマー準備完了' : '音声を準備';
  return ready;
}

async function getTimerBuffer(sound) {
  if (!timerBuffers.has(sound.id)) {
    timerBuffers.set(sound.id,timerAudioContext.decodeAudioData(await sound.blob.arrayBuffer()).catch(error => { timerBuffers.delete(sound.id); throw error; }));
  }
  return timerBuffers.get(sound.id);
}

async function playScheduledSound(sound,padKey=sound.id,displayName=sound.name,overlay=Boolean(sound.overlay)) {
  if (timerAudioContext && timerAudioContext.state !== 'running') {
    try { await timerAudioContext.resume(); } catch {}
  }
  if (!timerAudioContext || timerAudioContext.state !== 'running') {
    ui.now.textContent='タイマーの音声準備が必要です';
    $('#enableTimerAudio').classList.remove('ready'); $('#enableTimerAudio').textContent='音声を準備';
    return false;
  }
  let buffer;
  try { buffer=await getTimerBuffer(sound); }
  catch (error) { console.error('Scheduled audio decode failed',error); return false; }
  if (playing.has(padKey)) stopPad(padKey);
  if (!overlay) stopAll();
  const source=timerAudioContext.createBufferSource(); source.buffer=buffer; source.connect(timerAudioContext.destination);
  const startedAt=timerAudioContext.currentTime;
  const audio={duration:buffer.duration};
  Object.defineProperty(audio,'currentTime',{get:() => Math.min(buffer.duration,Math.max(0,timerAudioContext.currentTime-startedAt))});
  const progressTimer=setInterval(() => updateProgress(padKey),100);
  playing.set(padKey,{audio,source,progressTimer,soundId:sound.id,name:displayName});
  source.onended=() => stopPad(padKey); source.start(); refreshPlayingUI(); return true;
}

function playSound(sound, padKey = sound.id, displayName = sound.name, overlay = Boolean(sound.overlay)) {
  if (playing.has(padKey)) {
    stopPad(padKey);
    return Promise.resolve(false);
  }
  if (!overlay) stopAll();
  const engine=ensureAudioEngine(sound);
  const audio=engine.audio;
  audio.pause();
  try { audio.currentTime=0; } catch {}
  const ended=() => stopPad(padKey);
  const failed=() => stopPad(padKey);
  const progress=() => updateProgress(padKey);
  playing.set(padKey, { audio, soundId: sound.id, name: displayName, ended, failed, progress });
  refreshPlayingUI();
  const started=audio.play().then(() => true).catch(error => {
    console.error('Audio playback failed',error);
    stopPad(padKey);
    ui.now.textContent='再生できませんでした';
    return false;
  });
  audio.addEventListener('timeupdate', progress);
  audio.addEventListener('loadedmetadata', progress);
  audio.addEventListener('ended', ended, { once:true });
  audio.addEventListener('error', failed, { once:true });
  return started;
}

function normalizeAudioBlob(blob,name) {
  const extension=name.split('.').pop()?.toLowerCase();
  const mimeTypes={mp3:'audio/mpeg',wav:'audio/wav',m4a:'audio/mp4',mp4:'audio/mp4',aac:'audio/aac',aif:'audio/aiff',aiff:'audio/aiff',caf:'audio/x-caf',ogg:'audio/ogg',oga:'audio/ogg',opus:'audio/ogg',flac:'audio/flac'};
  const type=mimeTypes[extension] || (blob.type.startsWith('audio/') ? blob.type : 'audio/mpeg');
  return blob.type === type ? blob : new Blob([blob],{type});
}

function stopAll() {
  [...playing.keys()].forEach(stopPad);
}

function stopPad(padKey) {
  const entry = playing.get(padKey);
  if (!entry) return;
  if (entry.source) {
    entry.source.onended=null;
    try { entry.source.stop(); } catch {}
    clearInterval(entry.progressTimer);
    playing.delete(padKey); refreshPlayingUI(); return;
  }
  entry.audio.pause(); entry.audio.currentTime = 0;
  entry.audio.removeEventListener('ended',entry.ended);
  entry.audio.removeEventListener('error',entry.failed);
  entry.audio.removeEventListener('timeupdate',entry.progress);
  entry.audio.removeEventListener('loadedmetadata',entry.progress);
  playing.delete(padKey);
  refreshPlayingUI();
}

function updateProgress(padKey) {
  const entry = playing.get(padKey);
  if (!entry) return;
  const card = document.querySelector(`.sound-card[data-id="${CSS.escape(padKey)}"]`);
  if (!card) return;
  const duration = Number.isFinite(entry.audio.duration) ? entry.audio.duration : 0;
  const elapsed = entry.audio.currentTime || 0;
  const percent=duration ? elapsed / duration * 100 : 0;
  card.querySelector('.progress-fill').style.width = `${percent}%`;
  card.style.setProperty('--wave-progress',`${percent}%`);
  card.querySelector('.elapsed').textContent = formatTime(elapsed);
  card.querySelector('.duration').textContent = formatTime(duration);
}

function formatTime(seconds) {
  const value = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
}

function refreshPlayingUI() {
  const entries = [...playing.values()];
  ui.now.textContent = entries.length === 0 ? '待機中' : entries.length === 1 ? entries[0].name : `${entries.length}個の音を再生中`;
  ui.dot.classList.toggle('active', entries.length > 0); ui.stop.disabled = entries.length === 0;
  document.querySelectorAll('.sound-card').forEach(card => {
    const isPlaying = playing.has(card.dataset.id);
    card.classList.toggle('playing', isPlaying);
    const icon = card.querySelector('.play-icon');
    if (isPlaying) icon.textContent = '■';
    else if (card.classList.contains('scheduled-pad')) icon.innerHTML = clockIcon;
    else if (card.classList.contains('random-pad')) icon.innerHTML = shuffleIcon;
    else icon.textContent = '▶';
    card.querySelector('.play-pad').setAttribute('aria-label', isPlaying ? `${card.querySelector('.sound-name').textContent}を停止` : `${card.querySelector('.sound-name').textContent}を再生`);
    card.querySelector('.progress-wrap').hidden = !isPlaying;
    if (!isPlaying) { card.querySelector('.progress-fill').style.width = '0%'; card.style.setProperty('--wave-progress','0%'); }
  });
}

async function addFiles(files, group = '') {
  for (const file of files) {
    if (!isAudioFile(file)) continue;
    const displayName=file.name.replace(/\.[^.]+$/, '');
    const sound = { id: crypto.randomUUID(), name: displayName, originalName:file.name, group, overlay: false, blob: normalizeAudioBlob(file,file.name), createdAt: Date.now() };
    await saveSound(sound); sounds.push(sound);
  }
  ui.input.value = ''; ui.folderInput.value = ''; ui.addDialog.close(); render();
}

function isAudioFile(file) { return file.type.startsWith('audio/') || /\.(mp3|wav|m4a|aac|ogg|oga|flac|aif|aiff|caf|opus)$/i.test(file.name); }

function fillScheduleSettings(source) { $('#editScheduleEnabled').checked=Boolean(source.scheduleEnabled); $('#editScheduleTime').value=source.scheduleTime || '12:00'; }
function openEditDialog() { ui.dialog.showModal(); ui.dialog.querySelector('h2').focus({preventScroll:true}); }
function editSound(sound) { $('#editId').value=sound.id; $('#editName').value=sound.name; $('#editOverlay').checked=Boolean(sound.overlay); fillScheduleSettings(sound); openEditDialog(); }
function editGroup(name, items) { $('#editId').value=`group:${name}`; $('#editName').value=name; $('#editOverlay').checked=items.some(item => item.overlay); fillScheduleSettings(items.find(item => item.scheduleEnabled) || items[0]); openEditDialog(); }
function escapeHtml(value) { const div=document.createElement('div'); div.textContent=value; return div.innerHTML; }

$('#openAddDialog').addEventListener('click', () => ui.addDialog.showModal());
$('[data-close-add]').addEventListener('click', () => ui.addDialog.close());
ui.input.addEventListener('change', () => addFiles([...ui.input.files]));
ui.folderInput.addEventListener('change', () => {
  pendingRandomFiles=[...ui.folderInput.files].filter(isAudioFile);
  if (!pendingRandomFiles.length) { ui.folderInput.value=''; return; }
  ui.addDialog.close();
  $('#groupNameInput').value=`ランダム ${new Set(sounds.filter(sound => sound.group).map(sound => sound.group)).size+1}`;
  $('#groupNameDialog').showModal();
  $('#groupNameDialog h2').focus({preventScroll:true});
});
$('#groupNameForm').addEventListener('submit', event => { event.preventDefault(); const name=$('#groupNameInput').value.trim(); if (!name) return; $('#groupNameDialog').close(); addFiles(pendingRandomFiles,name); pendingRandomFiles=[]; });
$('[data-cancel-group]').addEventListener('click', () => { pendingRandomFiles=[]; ui.folderInput.value=''; $('#groupNameDialog').close(); });
ui.stop.addEventListener('click', stopAll);
$('[data-close]').addEventListener('click', () => ui.dialog.close());
document.querySelectorAll('[data-native-name]').forEach(button => button.addEventListener('click', () => {
  const input=document.getElementById(button.dataset.nativeName);
  let value=null;
  try { value=window.prompt('表示名を入力してください',input.value); }
  catch { input.focus(); return; }
  if (value !== null && value.trim()) input.value=value.trim().slice(0,30);
}));
$('#editForm').addEventListener('submit', async event => {
  event.preventDefault(); const id=$('#editId').value; const name=$('#editName').value.trim(); const overlay=$('#editOverlay').checked; const scheduleEnabled=$('#editScheduleEnabled').checked; const scheduleTime=$('#editScheduleTime').value || '12:00';
  if (id.startsWith('group:')) {
    const oldName=id.slice(6); const items=sounds.filter(sound => sound.group === oldName);
    for (const item of items) { item.group=name; item.overlay=overlay; item.scheduleEnabled=scheduleEnabled; item.scheduleTime=scheduleTime; await saveSound(item); }
  } else {
    const sound=sounds.find(item => item.id === id); if (!sound) return;
    sound.name=name; sound.overlay=overlay; sound.scheduleEnabled=scheduleEnabled; sound.scheduleTime=scheduleTime; await saveSound(sound);
  }
  ui.dialog.close(); render(); refreshPlayingUI();
});
$('#deleteSound').addEventListener('click', async () => {
  const id=$('#editId').value;
  if (id.startsWith('group:')) {
    const group=id.slice(6); stopPad(id); const items=sounds.filter(sound => sound.group === group);
    for (const item of items) { disposeAudioEngine(item.id); await removeSound(item.id); }
    sounds=sounds.filter(sound => sound.group !== group);
  } else {
    stopPad(id); disposeAudioEngine(id); await removeSound(id); sounds=sounds.filter(sound => sound.id !== id);
  }
  ui.dialog.close(); render(); refreshPlayingUI();
});

readSounds().then(items => { sounds=items; render(); }).catch(() => { ui.now.textContent='保存領域を開けませんでした'; });
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js'));

function updateClockAndSchedules() {
  const now=new Date();
  $('#currentClock').textContent=new Intl.DateTimeFormat('ja-JP',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(now);
  const hhmm=`${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  const day=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  const groups=new Map(); sounds.filter(sound => sound.group).forEach(sound => { if (!groups.has(sound.group)) groups.set(sound.group,[]); groups.get(sound.group).push(sound); });
  sounds.filter(sound => !sound.group && sound.scheduleEnabled && sound.scheduleTime === hhmm).forEach(sound => runScheduled(sound.id,day,hhmm,() => playScheduledSound(sound)));
  groups.forEach((items,name) => { const scheduled=items.find(item => item.scheduleEnabled && item.scheduleTime === hhmm); if (!scheduled) return; runScheduled(`group:${name}`,day,hhmm,() => { const item=items[Math.floor(Math.random()*items.length)]; return playScheduledSound(item,`group:${name}`,`${name}（${item.name}）`,items.some(entry => entry.overlay)); }); });
}

function runScheduled(key,day,time,action) {
  const storageKey=`radio-pad-schedule-${key}`; const marker=`${day} ${time}`;
  if (localStorage.getItem(storageKey) === marker) return;
  const lastAttempt=scheduledAttempts.get(storageKey) || 0;
  if (Date.now()-lastAttempt < 5000) return;
  scheduledAttempts.set(storageKey,Date.now());
  Promise.resolve(action()).then(started => {
    if (started !== false) {
      localStorage.setItem(storageKey,marker);
      scheduledAttempts.delete(storageKey);
    }
  }).catch(error => console.error('Scheduled playback failed',error));
}

updateClockAndSchedules();
setInterval(updateClockAndSchedules,500);
$('#enableTimerAudio').addEventListener('click',unlockTimerAudio);
document.addEventListener('pointerdown',event => { if (event.target.closest('.play-pad')) unlockTimerAudio(); },{capture:true});

function getLetterConfig() {
  try { return JSON.parse(localStorage.getItem(LETTER_CONFIG_KEY)) || {}; }
  catch { return {}; }
}

function getReadLetterIds() {
  try { return new Set(JSON.parse(localStorage.getItem(READ_LETTERS_KEY)) || []); }
  catch { return new Set(); }
}

function switchView(name) {
  document.querySelectorAll('.view-tab').forEach(button => {
    const active=button.dataset.view === name;
    button.classList.toggle('active',active);
    button.setAttribute('aria-selected',String(active));
  });
  $('#samplerView').hidden=name !== 'sampler';
  $('#lettersView').hidden=name !== 'letters';
  $('#openAddDialog').hidden=name !== 'sampler';
  if (name === 'letters' && !letters.length && getLetterConfig().endpoint) loadLetters();
}

function formatLetterTime(value) {
  const date=new Date(value);
  if (Number.isNaN(date.getTime())) return value || '';
  return new Intl.DateTimeFormat('ja-JP',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(date);
}

function updateUnreadBadge() {
  const read=getReadLetterIds();
  const unread=letters.filter(letter => !read.has(String(letter.id))).length;
  const badge=$('#unreadBadge');
  badge.hidden=unread === 0;
  badge.textContent=unread > 99 ? '99+' : String(unread);
  $('#lettersSummary').textContent=letters.length ? `${letters.length}件・未読 ${unread}件` : 'お便りはまだありません';
}

function renderLetters() {
  const list=$('#lettersList');
  const read=getReadLetterIds();
  list.replaceChildren();
  letters.forEach(letter => {
    const id=String(letter.id);
    const card=document.createElement('article');
    card.className=`letter-card${read.has(id) ? '' : ' unread'}`;
    const meta=document.createElement('div'); meta.className='letter-meta';
    const author=document.createElement('strong'); author.className='letter-author'; author.textContent=letter.name || '匿名';
    const time=document.createElement('time'); time.className='letter-time'; time.textContent=formatLetterTime(letter.timestamp);
    const message=document.createElement('p'); message.className='letter-message'; message.textContent=letter.message || '';
    const footer=document.createElement('div'); footer.className='letter-footer';
    const toggle=document.createElement('button'); toggle.className='read-toggle'; toggle.type='button'; toggle.textContent=read.has(id) ? '未読に戻す' : '既読にする';
    toggle.addEventListener('click',() => toggleLetterRead(id));
    meta.append(author,time); footer.append(toggle); card.append(meta,message,footer); list.append(card);
  });
  updateUnreadBadge();
}

function toggleLetterRead(id) {
  const read=getReadLetterIds();
  read.has(id) ? read.delete(id) : read.add(id);
  localStorage.setItem(READ_LETTERS_KEY,JSON.stringify([...read]));
  renderLetters();
}

function fetchLettersJsonp(endpoint,token) {
  return new Promise((resolve,reject) => {
    const callback=`radioPadLetters${Date.now()}${Math.floor(Math.random()*10000)}`;
    const script=document.createElement('script');
    const separator=endpoint.includes('?') ? '&' : '?';
    const cleanup=() => { clearTimeout(timer); script.remove(); delete window[callback]; };
    const timer=setTimeout(() => { cleanup(); reject(new Error('接続がタイムアウトしました')); },15000);
    window[callback]=data => { cleanup(); resolve(data); };
    script.onerror=() => { cleanup(); reject(new Error('Apps Scriptへ接続できませんでした')); };
    script.src=`${endpoint}${separator}token=${encodeURIComponent(token)}&callback=${encodeURIComponent(callback)}&_=${Date.now()}`;
    document.head.append(script);
  });
}

async function loadLetters() {
  if (lettersLoading) return;
  const config=getLetterConfig();
  const status=$('#lettersStatus');
  if (!config.endpoint || !config.token) { status.hidden=false; status.classList.remove('error'); return; }
  lettersLoading=true;
  status.hidden=false; status.classList.remove('error'); status.replaceChildren();
  const loading=document.createElement('strong'); loading.textContent='お便りを読み込んでいます…'; status.append(loading);
  $('#refreshLetters').disabled=true;
  try {
    const data=await fetchLettersJsonp(config.endpoint,config.token);
    if (!data.ok) throw new Error(data.error || 'アクセスできませんでした');
    letters=(data.letters || []).sort((a,b) => new Date(b.timestamp)-new Date(a.timestamp));
    renderLetters(); status.hidden=letters.length > 0;
    if (!letters.length) { status.replaceChildren(); const empty=document.createElement('strong'); empty.textContent='お便りはまだありません'; status.append(empty); }
  } catch (error) {
    status.hidden=false; status.classList.add('error'); status.replaceChildren();
    const title=document.createElement('strong'); title.textContent='お便りを読み込めませんでした';
    const detail=document.createElement('span'); detail.textContent='接続設定のURLとアクセスキーを確認してください。';
    status.append(title,detail); console.error('Letter fetch failed',error);
  } finally { lettersLoading=false; $('#refreshLetters').disabled=false; }
}

document.querySelectorAll('.view-tab').forEach(button => button.addEventListener('click',() => switchView(button.dataset.view)));
$('#refreshLetters').addEventListener('click',loadLetters);
$('#openLetterConfig').addEventListener('click',() => {
  const config=getLetterConfig(); $('#letterEndpoint').value=config.endpoint || ''; $('#letterToken').value=config.token || ''; $('#letterConfigDialog').showModal();
});
$('[data-close-letter-config]').addEventListener('click',() => $('#letterConfigDialog').close());
$('#letterConfigForm').addEventListener('submit',event => {
  event.preventDefault();
  const endpoint=$('#letterEndpoint').value.trim(); const token=$('#letterToken').value.trim();
  localStorage.setItem(LETTER_CONFIG_KEY,JSON.stringify({endpoint,token}));
  $('#letterConfigDialog').close(); loadLetters();
});

if (getLetterConfig().endpoint && getLetterConfig().token) loadLetters();
setInterval(() => {
  const config=getLetterConfig();
  if (config.endpoint && config.token && document.visibilityState === 'visible') loadLetters();
},30000);
document.addEventListener('visibilitychange',() => {
  const config=getLetterConfig();
  if (document.visibilityState === 'visible' && config.endpoint && config.token) loadLetters();
});
