const DB_NAME = 'radio-pad-db';
const STORE = 'sounds';
const LETTER_CONFIG_KEY = 'radio-pad-letter-config';
const READ_LETTERS_KEY = 'radio-pad-read-letters';
const LETTER_SCALE_KEY = 'radio-pad-letter-scale';
const LETTER_SORT_KEY = 'radio-pad-letter-newest-first';
const LETTER_ALERT_KEY = 'radio-pad-letter-alert';
const BANK_NAMES_KEY = 'radio-pad-bank-names';
const ACTIVE_BANK_KEY = 'radio-pad-active-bank';
let sounds = [];
let letters = [];
let lettersLoading = false;
let lettersLoadedOnce = false;
let pendingLetterAlert = false;
const playing = new Map();
const audioEngines = new Map();
const scheduledAttempts = new Map();
const timerBuffers = new Map();
let timerAudioContext = null;
let pendingRandomFiles = [];
let bankSwipeStart = null;
let suppressPadClickUntil = 0;
let bankTransitioning = false;
let activeBank=['1','2','3'].includes(localStorage.getItem(ACTIVE_BANK_KEY)) ? localStorage.getItem(ACTIVE_BANK_KEY) : '1';
const shuffleIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="16 3 21 3 21 8"></polyline><line x1="4" y1="20" x2="21" y2="3"></line><polyline points="21 16 21 21 16 21"></polyline><line x1="15" y1="15" x2="21" y2="21"></line><line x1="4" y1="4" x2="9" y2="9"></line></svg>';
const clockIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><polyline points="12 7 12 12 16 14"></polyline></svg>';
const repeatIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="17 1 21 5 17 9"></polyline><path d="M3 11V9a4 4 0 0 1 4-4h14"></path><polyline points="7 23 3 19 7 15"></polyline><path d="M21 13v2a4 4 0 0 1-4 4H3"></path></svg>';

const $ = (selector) => document.querySelector(selector);
const ui = { grid: $('#soundGrid'), input: $('#fileInput'), folderInput: $('#folderInput'), addDialog: $('#addDialog'), stop: $('#stopAll'), now: $('#nowPlaying'), dot: $('#statusDot'), dialog: $('#editDialog') };

function updateTopbarHeight() { document.documentElement.style.setProperty('--topbar-height',`${Math.ceil($('.topbar').getBoundingClientRect().height)}px`); }
updateTopbarHeight();
if ('ResizeObserver' in window) new ResizeObserver(updateTopbarHeight).observe($('.topbar'));
window.addEventListener('orientationchange',updateTopbarHeight);

function getBankNames() {
  try { const names=JSON.parse(localStorage.getItem(BANK_NAMES_KEY)); if (Array.isArray(names) && names.length === 3) return names; }
  catch {}
  return ['バンク1','バンク2','バンク3'];
}
let bankNames=getBankNames();
function soundBank(sound) { return String(sound.bank || '1'); }
function groupPadKey(bank,name) { return `group:${bank}:${name}`; }

function updateBankUI() {
  document.querySelectorAll('#bankSwitcher [data-bank]').forEach(button => { const index=Number(button.dataset.bank)-1; const active=button.dataset.bank === activeBank; button.textContent=bankNames[index]; button.classList.toggle('active',active); button.setAttribute('aria-pressed',String(active)); });
  document.querySelectorAll('#editBank option').forEach(option => { option.textContent=bankNames[Number(option.value)-1]; });
}

function switchBank(bank) {
  activeBank=String(bank); localStorage.setItem(ACTIVE_BANK_KEY,activeBank); updateBankUI(); render();
}

function switchBankByOffset(offset) {
  const next=Math.min(3,Math.max(1,Number(activeBank)+offset));
  if (String(next) !== activeBank) animateBankSwitch(next);
}

function animateBankSwitch(bank) {
  const next=String(bank); if (next === activeBank || bankTransitioning) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { switchBank(next); return; }
  bankTransitioning=true;
  const forward=Number(next) > Number(activeBank);
  const exitClass=forward ? 'bank-exit-left' : 'bank-exit-right';
  const enterClass=forward ? 'bank-enter-right' : 'bank-enter-left';
  ui.grid.classList.add(exitClass);
  setTimeout(() => {
    ui.grid.classList.remove(exitClass);
    switchBank(next);
    ui.grid.classList.add(enterClass);
    setTimeout(() => { ui.grid.classList.remove(enterClass); bankTransitioning=false; },120);
  },80);
}

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
  sounds.filter(sound => !sound.group && soundBank(sound) === activeBank).forEach(sound => {
    const card = $('#soundTemplate').content.firstElementChild.cloneNode(true);
    card.dataset.id = sound.id;
    card.querySelector('.sound-name').textContent = sound.name;
    card.querySelector('.group-label').textContent = [sound.loop ? 'ループ' : '',sound.scheduleEnabled ? `自動 ${sound.scheduleTime}` : ''].filter(Boolean).join('・');
    if (sound.scheduleEnabled) card.classList.add('scheduled-pad');
    if (sound.loop) card.classList.add('loop-pad');
    card.querySelector('.play-icon').innerHTML=sound.loop ? repeatIcon : sound.scheduleEnabled ? clockIcon : '▶';
    if (!sound.scheduleEnabled && !sound.loop) card.querySelector('.card-footer').classList.add('settings-only');
    card.querySelector('.play-pad').addEventListener('click', () => { if (Date.now() >= suppressPadClickUntil) playSound(sound,sound.id,sound.name,Boolean(sound.overlay),{loop:Boolean(sound.loop)}); });
    card.querySelector('.edit-button').addEventListener('click', () => editSound(sound));
    waveformJobs.push({ sound, card });
    cards.push({ title:sound.name, card });
  });
  const groups = new Map();
  sounds.filter(s => s.group && soundBank(s) === activeBank).forEach(sound => {
    if (!groups.has(sound.group)) groups.set(sound.group, []);
    groups.get(sound.group).push(sound);
  });
  groups.forEach((items, name) => {
    const card = $('#soundTemplate').content.firstElementChild.cloneNode(true);
    const padKey = groupPadKey(activeBank,name);
    card.classList.add('random-pad');
    card.dataset.id = padKey;
    card.querySelector('.play-icon').innerHTML = shuffleIcon;
    card.querySelector('.sound-name').textContent = name;
    const scheduleTime=items.find(item => item.scheduleEnabled)?.scheduleTime;
    const loop=items.some(item => item.loop);
    card.querySelector('.group-label').textContent = `ランダム・${items.length}音${loop ? '・ループ' : ''}${scheduleTime ? `・自動 ${scheduleTime}` : ''}`;
    if (scheduleTime) card.classList.add('scheduled-pad');
    if (loop) card.classList.add('loop-pad');
    card.querySelector('.play-icon').innerHTML=loop ? repeatIcon : scheduleTime ? clockIcon : shuffleIcon;
    card.querySelector('.edit-button').hidden = true;
    card.querySelector('.edit-button').hidden = false;
    card.querySelector('.edit-button').addEventListener('click', () => editGroup(name, items, activeBank));
    card.querySelector('.play-pad').addEventListener('click', () => {
      if (Date.now() < suppressPadClickUntil) return;
      playRandomGroup(items,padKey,name,items.some(entry => entry.overlay),loop);
    });
    waveformJobs.push({ sound:items[0], card });
    cards.push({ title:name, card });
  });
  cards.sort((a,b) => a.title.localeCompare(b.title, undefined, {numeric:true,sensitivity:'base'})).forEach(item => ui.grid.append(item.card));
  if (!cards.length) { const empty=document.createElement('p'); empty.className='bank-empty'; empty.textContent=`${bankNames[Number(activeBank)-1]}にはまだ音がありません`; ui.grid.append(empty); }
  refreshPlayingUI();
  prepareWaveforms(waveformJobs);
  populateLetterAlertPads();
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
  if (ready && pendingLetterAlert) { pendingLetterAlert=false; setTimeout(playNewLetterAlert,0); }
  return ready;
}

async function getTimerBuffer(sound) {
  if (!timerBuffers.has(sound.id)) {
    timerBuffers.set(sound.id,timerAudioContext.decodeAudioData(await sound.blob.arrayBuffer()).catch(error => { timerBuffers.delete(sound.id); throw error; }));
  }
  return timerBuffers.get(sound.id);
}

async function playScheduledSound(sound,padKey=sound.id,displayName=sound.name,overlay=Boolean(sound.overlay),options={}) {
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
  const source=timerAudioContext.createBufferSource(); source.buffer=buffer; source.loop=Boolean(options.loop); source.connect(timerAudioContext.destination);
  const startedAt=timerAudioContext.currentTime;
  const audio={duration:buffer.duration};
  Object.defineProperty(audio,'currentTime',{get:() => Math.min(buffer.duration,Math.max(0,timerAudioContext.currentTime-startedAt))});
  const progressTimer=setInterval(() => updateProgress(padKey),100);
  playing.set(padKey,{audio,source,progressTimer,soundId:sound.id,name:displayName});
  source.onended=() => { stopPad(padKey); if (options.onEnded) options.onEnded(); }; source.start(); refreshPlayingUI(); return true;
}

function playSound(sound, padKey = sound.id, displayName = sound.name, overlay = Boolean(sound.overlay), options = {}) {
  if (playing.has(padKey)) {
    stopPad(padKey);
    return Promise.resolve(false);
  }
  if (!overlay) stopAll();
  const engine=ensureAudioEngine(sound);
  const audio=engine.audio;
  audio.pause();
  audio.loop=Boolean(options.loop);
  try { audio.currentTime=0; } catch {}
  const ended=() => { stopPad(padKey); if (options.onEnded) options.onEnded(); };
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

function pickRandomSound(items,previousId='') {
  const choices=items.length > 1 ? items.filter(item => item.id !== previousId) : items;
  return choices[Math.floor(Math.random()*choices.length)];
}

function playRandomGroup(items,padKey,name,overlay,loop,previousId='') {
  if (playing.has(padKey)) { stopPad(padKey); return Promise.resolve(false); }
  const sound=pickRandomSound(items,previousId);
  return playSound(sound,padKey,`${name}（${sound.name}）`,overlay,{onEnded:loop ? () => playRandomGroup(items,padKey,name,overlay,true,sound.id) : null});
}

function playScheduledRandomGroup(items,padKey,name,overlay,loop,previousId='') {
  const sound=pickRandomSound(items,previousId);
  return playScheduledSound(sound,padKey,`${name}（${sound.name}）`,overlay,{onEnded:loop ? () => playScheduledRandomGroup(items,padKey,name,overlay,true,sound.id) : null});
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
  entry.audio.pause(); entry.audio.loop=false; entry.audio.currentTime = 0;
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
  const alertPlaying=[...playing.keys()].some(key => String(key).startsWith('letter-alert:'));
  const alertButton=$('#playLetterAlert');
  alertButton.classList.toggle('playing',alertPlaying);
  alertButton.setAttribute('aria-label',alertPlaying ? 'お便りの通知音を停止' : 'お便りの通知音を再生');
  document.querySelectorAll('.sound-card').forEach(card => {
    const isPlaying = playing.has(card.dataset.id);
    card.classList.toggle('playing', isPlaying);
    const icon = card.querySelector('.play-icon');
    if (isPlaying) icon.textContent = '■';
    else if (card.classList.contains('loop-pad')) icon.innerHTML = repeatIcon;
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
    const sound = { id: crypto.randomUUID(), name: displayName, originalName:file.name, group, bank:activeBank, overlay: false, blob: normalizeAudioBlob(file,file.name), createdAt: Date.now() };
    await saveSound(sound); sounds.push(sound);
  }
  ui.input.value = ''; ui.folderInput.value = ''; ui.addDialog.close(); render();
}

function isAudioFile(file) { return file.type.startsWith('audio/') || /\.(mp3|wav|m4a|aac|ogg|oga|flac|aif|aiff|caf|opus)$/i.test(file.name); }

function fillScheduleSettings(source) { $('#editScheduleEnabled').checked=Boolean(source.scheduleEnabled); $('#editScheduleTime').value=source.scheduleTime || '12:00'; }
function openEditDialog() { ui.dialog.showModal(); ui.dialog.querySelector('h2').focus({preventScroll:true}); }
function editSound(sound) { $('#editId').value=sound.id; $('#editName').value=sound.name; $('#editBank').value=soundBank(sound); $('#editOverlay').checked=Boolean(sound.overlay); $('#editLoop').checked=Boolean(sound.loop); fillScheduleSettings(sound); openEditDialog(); }
function editGroup(name, items, bank) { $('#editId').value=`group:${bank}:${name}`; $('#editName').value=name; $('#editBank').value=bank; $('#editOverlay').checked=items.some(item => item.overlay); $('#editLoop').checked=items.some(item => item.loop); fillScheduleSettings(items.find(item => item.scheduleEnabled) || items[0]); openEditDialog(); }
function parseGroupEditId(id) { const parts=id.split(':'); return {bank:parts[1],name:parts.slice(2).join(':')}; }
function escapeHtml(value) { const div=document.createElement('div'); div.textContent=value; return div.innerHTML; }

updateBankUI();
document.querySelectorAll('#bankSwitcher [data-bank]').forEach(button => button.addEventListener('click',() => switchBank(button.dataset.bank)));
$('#samplerView').addEventListener('touchstart',event => {
  if (event.touches.length !== 1 || event.target.closest('.bank-switcher,.bank-settings-button')) { bankSwipeStart=null; return; }
  const touch=event.touches[0]; bankSwipeStart={x:touch.clientX,y:touch.clientY,time:Date.now()};
},{passive:true});
$('#samplerView').addEventListener('touchend',event => {
  if (!bankSwipeStart || !event.changedTouches.length) return;
  const touch=event.changedTouches[0]; const dx=touch.clientX-bankSwipeStart.x; const dy=touch.clientY-bankSwipeStart.y; const elapsed=Date.now()-bankSwipeStart.time;
  bankSwipeStart=null;
  if (elapsed > 900 || Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy)*1.25) return;
  suppressPadClickUntil=Date.now()+450;
  switchBankByOffset(dx < 0 ? 1 : -1);
},{passive:true});
$('#samplerView').addEventListener('touchcancel',() => { bankSwipeStart=null; },{passive:true});
$('#openBankSettings').addEventListener('click',() => { bankNames.forEach((name,index) => { $(`#bankName${index+1}`).value=name; }); $('#bankSettingsDialog').showModal(); });
document.querySelectorAll('[data-close-bank-settings]').forEach(button => button.addEventListener('click',() => $('#bankSettingsDialog').close()));
$('[data-close-letter-settings]').addEventListener('click',() => $('#letterDisplayDialog').close());
$('#bankSettingsForm').addEventListener('submit',event => {
  event.preventDefault();
  bankNames=[1,2,3].map(index => $(`#bankName${index}`).value.trim() || `バンク${index}`);
  localStorage.setItem(BANK_NAMES_KEY,JSON.stringify(bankNames)); updateBankUI(); $('#bankSettingsDialog').close();
});

$('#openAddDialog').addEventListener('click', () => ui.addDialog.showModal());
$('[data-close-add]').addEventListener('click', () => ui.addDialog.close());
ui.input.addEventListener('change', () => addFiles([...ui.input.files]));
ui.folderInput.addEventListener('change', () => {
  pendingRandomFiles=[...ui.folderInput.files].filter(isAudioFile);
  if (!pendingRandomFiles.length) { ui.folderInput.value=''; return; }
  ui.addDialog.close();
  $('#groupNameInput').value=`ランダム ${new Set(sounds.filter(sound => sound.group && soundBank(sound) === activeBank).map(sound => sound.group)).size+1}`;
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
  event.preventDefault(); const id=$('#editId').value; const name=$('#editName').value.trim(); const bank=$('#editBank').value; const overlay=$('#editOverlay').checked; const loop=$('#editLoop').checked; const scheduleEnabled=$('#editScheduleEnabled').checked; const scheduleTime=$('#editScheduleTime').value || '12:00';
  if (id.startsWith('group:')) {
    const old=parseGroupEditId(id); const items=sounds.filter(sound => sound.group === old.name && soundBank(sound) === old.bank);
    stopPad(groupPadKey(old.bank,old.name));
    for (const item of items) { item.group=name; item.bank=bank; item.overlay=overlay; item.loop=loop; item.scheduleEnabled=scheduleEnabled; item.scheduleTime=scheduleTime; await saveSound(item); }
  } else {
    const sound=sounds.find(item => item.id === id); if (!sound) return;
    sound.name=name; sound.bank=bank; sound.overlay=overlay; sound.loop=loop; sound.scheduleEnabled=scheduleEnabled; sound.scheduleTime=scheduleTime; await saveSound(sound);
  }
  ui.dialog.close(); render(); refreshPlayingUI();
});
$('#deleteSound').addEventListener('click', async () => {
  const id=$('#editId').value;
  if (id.startsWith('group:')) {
    const group=parseGroupEditId(id); stopPad(groupPadKey(group.bank,group.name)); const items=sounds.filter(sound => sound.group === group.name && soundBank(sound) === group.bank);
    for (const item of items) { disposeAudioEngine(item.id); await removeSound(item.id); }
    sounds=sounds.filter(sound => !(sound.group === group.name && soundBank(sound) === group.bank));
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
  const ignition=new Date(now); ignition.setHours(20,0,0,0);
  const remaining=ignition.getTime()-now.getTime();
  $('#ignitionCountdown').textContent=remaining > 0 ? `点火まで ${Math.ceil(remaining/60000)}分` : '点火済み';
  const hhmm=`${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  const day=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  const groups=new Map(); sounds.filter(sound => sound.group).forEach(sound => { const key=`${soundBank(sound)}\u0000${sound.group}`; if (!groups.has(key)) groups.set(key,[]); groups.get(key).push(sound); });
  sounds.filter(sound => !sound.group && sound.scheduleEnabled && sound.scheduleTime === hhmm).forEach(sound => runScheduled(sound.id,day,hhmm,() => playScheduledSound(sound,sound.id,sound.name,Boolean(sound.overlay))));
  groups.forEach(items => { const name=items[0].group; const bank=soundBank(items[0]); const scheduled=items.find(item => item.scheduleEnabled && item.scheduleTime === hhmm); if (!scheduled) return; const padKey=groupPadKey(bank,name); runScheduled(padKey,day,hhmm,() => playScheduledRandomGroup(items,padKey,name,items.some(entry => entry.overlay),false)); });
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
document.addEventListener('pointerdown',() => { unlockTimerAudio(); },{capture:true});

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
  $('#openLetterDisplaySettings').hidden=name !== 'letters';
  if (name === 'letters' && !letters.length && getLetterConfig().endpoint) loadLetters();
}

function setLetterScale(value,save=true) {
  const scale=Math.min(2,Math.max(.75,Number(value) || 1));
  $('#lettersView').style.setProperty('--letters-scale',String(scale));
  $('#letterScaleInput').value=String(scale);
  $('#letterScaleOutput').textContent=`${Math.round(scale*100)}%`;
  if (save) localStorage.setItem(LETTER_SCALE_KEY,String(scale));
}

function formatLetterTime(value) {
  const date=new Date(value);
  if (Number.isNaN(date.getTime())) return value || '';
  return new Intl.DateTimeFormat('ja-JP',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(date);
}

function letterSortValue(letter) {
  const timestamp=new Date(letter.timestamp).getTime();
  return Number.isFinite(timestamp) ? timestamp : Number(letter.id) || 0;
}

function sortLetters() {
  const newestFirst=localStorage.getItem(LETTER_SORT_KEY) !== 'false';
  letters.sort((a,b) => {
    const order=letterSortValue(a)-letterSortValue(b) || Number(a.id)-Number(b.id);
    return newestFirst ? -order : order;
  });
}

function getLetterAlertConfig() {
  try { return JSON.parse(localStorage.getItem(LETTER_ALERT_KEY)) || {enabled:false,pad:''}; }
  catch { return {enabled:false,pad:''}; }
}

function saveLetterAlertConfig() {
  localStorage.setItem(LETTER_ALERT_KEY,JSON.stringify({enabled:$('#letterAlertEnabled').checked,pad:$('#letterAlertPad').value}));
  updateLetterAlertSetting();
}

function populateLetterAlertPads() {
  const select=$('#letterAlertPad'); if (!select) return;
  const config=getLetterAlertConfig(); const options=[];
  sounds.filter(sound => !sound.group).forEach(sound => options.push({value:`sound:${sound.id}`,label:`${bankNames[Number(soundBank(sound))-1]}・${sound.name}`}));
  const groups=new Map(); sounds.filter(sound => sound.group).forEach(sound => { const key=groupPadKey(soundBank(sound),sound.group); if (!groups.has(key)) groups.set(key,[]); groups.get(key).push(sound); });
  groups.forEach(items => { const bank=soundBank(items[0]); const name=items[0].group; options.push({value:groupPadKey(bank,name),label:`${bankNames[Number(bank)-1]}・${name}（ランダム）`}); });
  options.sort((a,b) => a.label.localeCompare(b.label,undefined,{numeric:true,sensitivity:'base'}));
  select.replaceChildren(...options.map(item => new Option(item.label,item.value)));
  if (options.some(item => item.value === config.pad)) select.value=config.pad;
  else if (options.length) {
    select.value=options[0].value;
    if (config.enabled) localStorage.setItem(LETTER_ALERT_KEY,JSON.stringify({enabled:true,pad:select.value}));
  }
  select.disabled=!options.length || !config.enabled;
  updateLetterAlertSetting();
}

function updateLetterAlertSetting() {
  const enabled=$('#letterAlertEnabled').checked;
  $('.letter-alert-setting').classList.toggle('disabled',!enabled);
  $('#letterAlertPad').disabled=!enabled || !$('#letterAlertPad').options.length;
  $('#testLetterAlert').disabled=!enabled || !$('#letterAlertPad').options.length;
  $('#playLetterAlert').disabled=!getLetterAlertConfig().pad;
}

async function playNewLetterAlert(force=false) {
  const config=getLetterAlertConfig(); if ((!config.enabled && !force) || !config.pad) return;
  if (config.pad.startsWith('sound:')) {
    const sound=sounds.find(item => item.id === config.pad.slice(6));
    if (sound) await playLetterAlertSound(sound,`letter-alert:${config.pad}`);
    return;
  }
  if (config.pad.startsWith('group:')) {
    const group=parseGroupEditId(config.pad); const items=sounds.filter(item => item.group === group.name && soundBank(item) === group.bank); if (!items.length) return;
    const sound=items[Math.floor(Math.random()*items.length)];
    await playLetterAlertSound(sound,`letter-alert:${config.pad}`);
  }
}

async function playLetterAlertSound(sound,padKey) {
  let started=await playScheduledSound(sound,padKey,'新しいお便り',true);
  if (!started) started=await playSound(sound,padKey,'新しいお便り',true);
  pendingLetterAlert=!started;
  return started;
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
    meta.append(time,author); footer.append(toggle); card.append(meta,message,footer); list.append(card);
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
  status.hidden=true; status.classList.remove('error');
  $('#refreshLetters').classList.add('loading');
  $('#refreshLetters').disabled=true;
  try {
    const data=await fetchLettersJsonp(config.endpoint,config.token);
    if (!data.ok) throw new Error(data.error || 'アクセスできませんでした');
    const incoming=data.letters || [];
    const previousIds=new Set(letters.map(letter => String(letter.id)));
    const hasNewLetters=lettersLoadedOnce && incoming.some(letter => !previousIds.has(String(letter.id)));
    letters=incoming; lettersLoadedOnce=true; sortLetters();
    renderLetters(); status.hidden=letters.length > 0;
    if (hasNewLetters) playNewLetterAlert().catch(error => { pendingLetterAlert=true; console.error('Letter alert playback failed',error); });
    if (!letters.length) { status.replaceChildren(); const empty=document.createElement('strong'); empty.textContent='お便りはまだありません'; status.append(empty); }
  } catch (error) {
    status.hidden=false; status.classList.add('error'); status.replaceChildren();
    const title=document.createElement('strong'); title.textContent='お便りを読み込めませんでした';
    const detail=document.createElement('span'); detail.textContent='接続設定のURLとアクセスキーを確認してください。';
    status.append(title,detail); console.error('Letter fetch failed',error);
  } finally { lettersLoading=false; $('#refreshLetters').classList.remove('loading'); $('#refreshLetters').disabled=false; }
}

document.querySelectorAll('.view-tab').forEach(button => button.addEventListener('click',() => switchView(button.dataset.view)));
setLetterScale(localStorage.getItem(LETTER_SCALE_KEY) || 1,false);
$('#letterSortNewestFirst').checked=localStorage.getItem(LETTER_SORT_KEY) !== 'false';
const initialLetterAlert=getLetterAlertConfig(); $('#letterAlertEnabled').checked=Boolean(initialLetterAlert.enabled); populateLetterAlertPads(); updateLetterAlertSetting();
$('#openLetterDisplaySettings').addEventListener('click',() => {
  populateLetterAlertPads();
  const config=getLetterConfig(); $('#letterEndpoint').value=config.endpoint || ''; $('#letterToken').value=config.token || '';
  $('#letterDisplayDialog').showModal();
});
$('#letterScaleInput').addEventListener('input',event => setLetterScale(event.target.value));
$('#resetLetterScale').addEventListener('click',() => setLetterScale(1));
$('#letterSortNewestFirst').addEventListener('change',event => {
  localStorage.setItem(LETTER_SORT_KEY,String(event.target.checked));
  sortLetters(); renderLetters();
});
$('#letterAlertEnabled').addEventListener('change',saveLetterAlertConfig);
$('#letterAlertPad').addEventListener('change',saveLetterAlertConfig);
$('#testLetterAlert').addEventListener('click',async () => { await unlockTimerAudio(); playNewLetterAlert(); });
$('#playLetterAlert').addEventListener('click',async () => {
  const playingKey=[...playing.keys()].find(key => String(key).startsWith('letter-alert:'));
  if (playingKey) { stopPad(playingKey); return; }
  await unlockTimerAudio(); playNewLetterAlert(true);
});
$('#refreshLetters').addEventListener('click',loadLetters);
$('#saveLetterConnection').addEventListener('click',() => {
  const endpoint=$('#letterEndpoint').value.trim(); const token=$('#letterToken').value.trim();
  if (!endpoint || !token) return;
  localStorage.setItem(LETTER_CONFIG_KEY,JSON.stringify({endpoint,token}));
  $('#saveLetterConnection').textContent='保存しました';
  setTimeout(() => { $('#saveLetterConnection').textContent='接続を保存'; },1200);
  loadLetters();
});

if (getLetterConfig().endpoint && getLetterConfig().token) loadLetters();
setInterval(() => {
  const config=getLetterConfig();
  if (config.endpoint && config.token && document.visibilityState === 'visible') loadLetters();
},60000);
document.addEventListener('visibilitychange',() => {
  const config=getLetterConfig();
  if (document.visibilityState === 'visible' && config.endpoint && config.token) loadLetters();
});
