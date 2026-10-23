// Telegram Mini App «Тренировочная Булочек». Содержимое — в data/workouts.js.

const DATA = window.APP_DATA;
const CONFIG = DATA.config;
const tg = window.Telegram && window.Telegram.WebApp;
const inTelegram = !!(tg && tg.initData);
const user = inTelegram ? tg.initDataUnsafe.user : null;
const app = document.getElementById('app');

if (tg) {
    tg.ready();
    tg.expand();
}

// ---------- Справочник тренировок ----------

const WORKOUTS = {};
DATA.programs.forEach(program => program.workouts.forEach(w => {
    WORKOUTS[w.id] = { ...w, program, counts: true };
}));
Object.values(DATA.extras).forEach(extra => {
    WORKOUTS[extra.id] = { ...extra, counts: false };
});

// ---------- Хранилище: облако Telegram, вне Telegram — браузер ----------

const useCloud = inTelegram && tg.isVersionAtLeast('6.9');

const store = {
    get(key) {
        if (useCloud) {
            return new Promise(resolve => tg.CloudStorage.getItem(key, (err, value) => resolve(err ? null : value || null)));
        }
        try { return Promise.resolve(localStorage.getItem(key)); } catch (e) { return Promise.resolve(null); }
    },
    set(key, value) {
        if (useCloud) {
            return new Promise(resolve => tg.CloudStorage.setItem(key, value, () => resolve()));
        }
        try { localStorage.setItem(key, value); } catch (e) { /* приватный режим */ }
        return Promise.resolve();
    }
};

// Прогресс: { total, history: [{ d: 'YYYY-MM-DD', w: workoutId }] } — последние 100 тренировок
let progress = { total: 0, history: [] };
let lastWeight = null;
let lastWeightDate = null; // 'YYYY-MM-DD'

async function loadProgress() {
    try {
        const saved = JSON.parse(await store.get('progress'));
        if (saved && Array.isArray(saved.history)) progress = saved;
    } catch (e) { /* пусто или повреждено — начинаем с нуля */ }
    lastWeight = parseFloat(await store.get('lastWeight')) || null;
    lastWeightDate = await store.get('lastWeightDate');
    try { access = Object.assign(access, JSON.parse(await store.get('access')) || {}); } catch (e) { /* нет кэша */ }
}

function rememberLastWeight(weight, date) {
    lastWeight = weight;
    lastWeightDate = isoDate(date);
    store.set('lastWeight', String(weight));
    store.set('lastWeightDate', lastWeightDate);
}

// Пора взвешиваться: замеров нет или последний был 7+ дней назад
function weighInDue() {
    if (!lastWeightDate) return true;
    const [y, m, d] = lastWeightDate.split('-').map(Number);
    return (Date.now() - new Date(y, m - 1, d)) / 864e5 >= 7;
}

// ---------- Сервер: Google Apps Script ----------

const apiEnabled = !!(CONFIG.googleScriptUrl && inTelegram);

async function api(method, params = {}) {
    const response = method === 'GET'
        ? await fetch(`${CONFIG.googleScriptUrl}?${new URLSearchParams({ ...params, initData: tg.initData })}`)
        : await fetch(CONFIG.googleScriptUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({ ...params, initData: tg.initData })
        });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const data = await response.json();
    if (data && data.error) throw new Error(data.error);
    return data;
}

// ---------- Рабочие веса ----------

// Введённые подходы текущей тренировки: 'workoutId:index' → [{ weight, reps }]
const session = {};
const loggedKeys = new Set();
let loggedSetsCount = 0;
// Вся история по упражнениям: name → [{ date, sets: [{ weight, reps }] }], от старых к новым
let exerciseLog = {};
let logRequest = null;
let logLoaded = false;
let newRecords = []; // рекорды текущей тренировки: [{ exercise, text }]

function loadExerciseLog() {
    if (!apiEnabled) return Promise.resolve();
    if (logRequest) return logRequest;
    logRequest = api('GET', { action: 'progress' })
        .then(data => {
            if (!Array.isArray(data)) return data;
            // Старая версия скрипта не знает action=progress — берём хотя бы последние тренировки
            return api('GET', { action: 'history' }).then(last => Array.isArray(last) ? {} :
                Object.fromEntries(Object.entries(last).map(([name, session]) => [name, [session]])));
        })
        .then(data => {
            const local = exerciseLog;
            exerciseLog = data;
            // Добавляем то, что записано в этой сессии или ещё не дошло до таблицы
            Object.entries(local).forEach(([exercise, list]) => list.forEach(s => addToLog({ exercise, ...s })));
            readPending().forEach(addToLog);
            logLoaded = true;
        })
        .catch(error => { console.error('История упражнений:', error); logRequest = null; });
    return logRequest;
}

function addToLog({ exercise, date, sets }) {
    const list = exerciseLog[exercise] || (exerciseLog[exercise] = []);
    const time = new Date(date).getTime();
    if (list.some(s => Math.abs(new Date(s.date).getTime() - time) < 2000)) return;
    list.push({ date, sets });
    list.sort((a, b) => new Date(a.date) - new Date(b.date));
}

function lastSession(name) {
    const list = exerciseLog[name];
    return list && list.length ? list[list.length - 1] : null;
}

// Лучший подход тренировки: максимальный вес (при равном — больше повторов), без веса — максимум повторов
function sessionBest(sets) {
    const weighted = sets.filter(s => s.weight !== '' && Number(s.weight) > 0);
    if (weighted.length) {
        const best = weighted.reduce((a, b) => (Number(b.weight) > Number(a.weight) ||
            (Number(b.weight) === Number(a.weight) && Number(b.reps) > Number(a.reps)) ? b : a));
        return { byWeight: true, value: Number(best.weight), reps: best.reps };
    }
    const reps = Math.max(0, ...sets.map(s => Number(s.reps) || 0));
    return reps ? { byWeight: false, value: reps } : null;
}

function bestText(best) {
    if (!best) return '—';
    return best.byWeight
        ? `${formatKg(best.value)} кг${best.reps !== '' && best.reps !== undefined ? ' × ' + best.reps : ''}`
        : `${best.value} ${plural(best.value, 'повтор', 'повтора', 'повторов')}`;
}

// Рекорд по упражнению. Если хоть раз записан вес — сравниваем по весу, иначе по повторам
function personalRecord(list) {
    const bests = (list || []).map(s => sessionBest(s.sets)).filter(Boolean);
    const byWeight = bests.some(b => b.byWeight);
    return bests.filter(b => b.byWeight === byWeight).reduce((a, b) => (!a || b.value > a.value ? b : a), null);
}

function isNewRecord(name, sets) {
    const record = personalRecord(exerciseLog[name]);
    const current = sessionBest(sets);
    return record && current && current.byWeight === record.byWeight && current.value > record.value ? record : null;
}

// "4 × 12" → { sets: 4, reps: '12' }
function parseSets(text) {
    const m = String(text || '').match(/(\d+)\s*[×xх*]\s*(\d+(?:\s*[-–]\s*\d+)?)/i);
    return m ? { sets: Math.min(Number(m[1]), 10), reps: m[2].replace(/\s/g, '') } : { sets: 3, reps: '' };
}

function sessionSets(workout, index) {
    const key = `${workout.id}:${index}`;
    if (!session[key]) {
        session[key] = Array.from({ length: parseSets(workout.exercises[index].sets).sets }, () => ({ weight: '', reps: '' }));
    }
    return session[key];
}

function toNumber(value) {
    const n = parseFloat(String(value).replace(',', '.'));
    return isNaN(n) ? '' : n;
}

// Неотправленные записи переживают закрытие приложения и уходят при следующей возможности
function readPending() {
    try { return JSON.parse(localStorage.getItem('pendingLogs')) || []; } catch (e) { return []; }
}
function writePending(entries) {
    try { localStorage.setItem('pendingLogs', JSON.stringify(entries.slice(-50))); } catch (e) { /* приватный режим */ }
}

let flushChain = Promise.resolve();
function flushLogs() {
    flushChain = flushChain.then(async () => {
        const pending = readPending();
        if (!apiEnabled || pending.length === 0) return;
        try {
            await api('POST', { action: 'log', entries: pending });
            writePending(readPending().slice(pending.length));
        } catch (error) {
            console.error('Не удалось отправить рабочие веса, повторим позже:', error);
        }
    });
    return flushChain;
}

function logExercise(workout, index) {
    const key = `${workout.id}:${index}`;
    if (!workout.counts || loggedKeys.has(key) || !session[key]) return;
    const sets = session[key]
        .map(s => ({ weight: toNumber(s.weight), reps: toNumber(s.reps) }))
        .filter(s => s.weight !== '' || s.reps !== '');
    if (sets.length === 0) return;

    loggedKeys.add(key);
    loggedSetsCount += sets.length;
    const exercise = workout.exercises[index].name;
    if (isNewRecord(exercise, sets)) newRecords.push({ exercise, text: bestText(sessionBest(sets)) });
    const entry = { date: new Date().toISOString(), workout: `${workout.program.title}, ${workout.title}`, exercise, sets };
    addToLog(entry);
    writePending(readPending().concat(entry));
    flushLogs();
}

// Запись всех подходов, отметка о тренировке и экран «Тренировка завершена»
function completeWorkout(workout) {
    let sets = 0;
    let records = [];
    if (workout.counts) {
        workout.exercises.forEach((_, i) => logExercise(workout, i));
        sets = loggedSetsCount;
        records = newRecords.slice();
        clearSession(workout);
        markDone(workout.id);
    }
    go('finish', { id: workout.id, sets, records }, true);
}

// «4 подхода × 12 · отдых 1:30»
function setsSummary(workout, index) {
    const ex = workout.exercises[index];
    const plan = parseSets(ex.sets);
    const what = ex.time ? `${ex.time} с` : plan.reps ? `${plan.reps} повт.` : '';
    return `${plan.sets} ${plural(plan.sets, 'подход', 'подхода', 'подходов')}${what ? ' × ' + what : ''} · отдых ${formatTime(restFor(workout, ex))}`;
}

const DEFAULT_REST = 90;
function restFor(workout, ex) {
    return ex.rest || workout.rest || (workout.program && workout.program.rest) || DEFAULT_REST;
}

function clearSession(workout) {
    Object.keys(session).filter(k => k.startsWith(workout.id + ':')).forEach(k => {
        delete session[k];
        loggedKeys.delete(k);
    });
    loggedSetsCount = 0;
    newRecords = [];
}

function markDone(workoutId) {
    progress.total += 1;
    progress.history.push({ d: isoDate(new Date()), w: workoutId });
    progress.history = progress.history.slice(-100);
    return store.set('progress', JSON.stringify(progress));
}

function lastDoneDate(workoutId) {
    for (let i = progress.history.length - 1; i >= 0; i--) {
        if (progress.history[i].w === workoutId) return progress.history[i].d;
    }
    return null;
}

function doneThisWeek() {
    const now = new Date();
    const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
    const from = isoDate(monday);
    return progress.history.filter(h => WORKOUTS[h.w] && WORKOUTS[h.w].counts && h.d >= from).length;
}

// ---------- Утилиты ----------

function isoDate(date) {
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function humanDate(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}

function signed(value) {
    return (value > 0 ? '+' : value < 0 ? '−' : '') + formatKg(Math.abs(value));
}

function formatKg(value) {
    return value.toLocaleString('ru-RU', { maximumFractionDigits: 1 });
}

function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function haptic(type) {
    if (inTelegram && tg.HapticFeedback) {
        type === 'success' ? tg.HapticFeedback.notificationOccurred('success') : tg.HapticFeedback.impactOccurred('light');
    }
}

function openLink(url) {
    if (inTelegram && /^https:\/\/t\.me\//.test(url)) tg.openTelegramLink(url);
    else if (inTelegram) tg.openLink(url);
    else window.open(url, '_blank');
}

function plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
    return many;
}

// ---------- Таймер для гимнастики и МФР ----------

// total — длительность текущей стороны (больше обычной, если продлили из-за болевых ощущений)
// phase: 'work' — упражнение, 'rest' — отдых перед ним; round — номер круга (с нуля)
const timer = { id: null, index: 0, round: 0, phase: 'work', side: 0, left: 0, total: 0, extended: false, running: false, interval: null };

function resetTimer(id, index, phase = 'work', rest = 0) {
    stopTimer();
    if (timer.id !== id) timer.round = 0;
    timer.id = id;
    timer.index = index;
    timer.side = 0;
    timer.phase = phase === 'rest' && rest > 0 ? 'rest' : 'work';
    timer.left = timer.total = timer.phase === 'rest' ? rest : WORKOUTS[id].exercises[index].duration;
    timer.extended = false;
}

function stopTimer() {
    clearInterval(timer.interval);
    timer.interval = null;
    if (!timer.running) keepScreenOn(false);
}

function formatTime(sec) {
    return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

function exDurationText(ex) {
    const base = ex.sides > 1 ? `${ex.sides} × ${ex.duration} с` : `${ex.duration} с`;
    return ex.maxDuration ? `${base} (до ${formatMinutes(ex.maxDuration)} при боли)` : base;
}

function formatMinutes(sec) {
    return sec % 60 ? formatTime(sec) : `${sec / 60} мин`;
}

function durationText(workout) {
    const rounds = workout.rounds || 1;
    const work = workout.exercises.reduce((sum, ex) => sum + (ex.duration || 0) * (ex.sides || 1), 0);
    const sec = work * rounds
        + (workout.rest || 0) * (workout.exercises.length - 1) * rounds
        + (workout.roundRest || workout.rest || 0) * (rounds - 1);
    return sec ? `≈ ${Math.max(1, Math.round(sec / 60))} мин` : '';
}

// Короткий звуковой сигнал; звук разрешён только после нажатия пользователя
let audioCtx = null;
function unlockAudio() {
    try {
        audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch (e) { /* без звука */ }
}
function beep(freq, ms) {
    if (!audioCtx) return;
    try {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.frequency.value = freq;
        gain.gain.value = 0.15;
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start();
        osc.stop(audioCtx.currentTime + ms / 1000);
    } catch (e) { /* без звука */ }
}

// Экран не гаснет, пока идёт таймер
let wakeLock = null;
function keepScreenOn(on) {
    try {
        if (on && !wakeLock && navigator.wakeLock) {
            navigator.wakeLock.request('screen').then(lock => { wakeLock = lock; }).catch(() => {});
        } else if (!on && wakeLock) {
            wakeLock.release();
            wakeLock = null;
        }
    } catch (e) { /* не поддерживается */ }
}

// ---------- Кнопки «Назад» и главная кнопка ----------

const pageBack = document.getElementById('page-back');
const pageMain = document.getElementById('page-main');
const pageMainBtn = document.getElementById('page-main-btn');
const nativeButtons = inTelegram && tg.isVersionAtLeast('6.1');
let mainHandler = null;

function onMainClick() { if (mainHandler) mainHandler(); }
function onBackClick() { back(); }

if (nativeButtons) {
    tg.MainButton.onClick(onMainClick);
    tg.BackButton.onClick(onBackClick);
} else {
    pageMainBtn.addEventListener('click', onMainClick);
    pageBack.addEventListener('click', onBackClick);
}

let mainText = null;

function setMainButton(text, handler) {
    mainHandler = handler;
    if (text === mainText) return;
    mainText = text;
    if (nativeButtons) {
        if (text) {
            tg.MainButton.setText(text);
            tg.MainButton.show();
        } else {
            tg.MainButton.hide();
        }
    } else {
        pageMainBtn.textContent = text || '';
        pageMain.hidden = !text;
    }
}

function setBackButton(visible) {
    if (nativeButtons) visible ? tg.BackButton.show() : tg.BackButton.hide();
    else pageBack.hidden = !visible;
}

// ---------- Доступ по подписке ----------

// until — до какого момента оплачено (ISO); сервер присылает при каждом открытии приложения
let access = { until: null };
const FREE_SCREENS = new Set(['home', 'nutrition', 'profile', 'plan', 'recipe', 'pregnant', 'paywall', 'finish']);

function hasAccess() {
    return !CONFIG.paywall || (!!access.until && new Date(access.until) > new Date());
}

function isLocked(screen, params = {}) {
    if (hasAccess() || FREE_SCREENS.has(screen)) return false;
    const workout = WORKOUTS[params.id];
    return !((screen === 'workout' || screen === 'timed') && workout && workout.free);
}

function saveAccess(data) {
    access = { until: data && data.until ? data.until : null };
    store.set('access', JSON.stringify(access));
}

// Замочки на кнопках, которые ведут в платные разделы
function markLocked() {
    if (hasAccess()) return;
    app.querySelectorAll('[data-go]').forEach(el => {
        if (isLocked(el.dataset.go, { id: el.dataset.id })) el.classList.add('locked');
    });
}

// Экраны, которые дорисовываются после загрузки данных, тоже получают замочки
new MutationObserver(markLocked).observe(app, { childList: true, subtree: true });

// ---------- Навигация ----------

const stack = [];

function go(screen, params = {}, replace = false) {
    if (isLocked(screen, params)) {
        screen = 'paywall';
        params = {};
    }
    if (replace) stack.pop();
    stack.push({ screen, params });
    render();
}

function back() {
    if (stack.length > 1) stack.pop();
    render();
}

function home() {
    stack.length = 0;
    go('home');
}

// Экран может оставить функцию уборки (таймеры, видео) — она вызывается при уходе с него
let screenCleanup = null;

function render() {
    const { screen, params } = stack[stack.length - 1];
    if (screenCleanup) {
        const cleanup = screenCleanup;
        screenCleanup = null;
        cleanup();
    }
    setMainButton(null);
    setBackButton(stack.length > 1);
    stopTimer();
    if (screen !== 'timed') timer.running = false;
    if (typeof Chart !== 'undefined') destroyCharts();
    window.scrollTo(0, 0);
    SCREENS[screen](params);
    markLocked();
}

// Делегирование кликов: data-go="screen" data-id="..." / data-action="..."
app.addEventListener('click', event => {
    const el = event.target.closest('[data-go], [data-action]');
    if (!el) return;
    haptic();
    if (el.dataset.go) go(el.dataset.go, { id: el.dataset.id, index: Number(el.dataset.index || 0) });
    else ACTIONS[el.dataset.action](el);
});

const ACTIONS = {
    coach: () => openLink(CONFIG.coachLink),
    video: el => openLink(el.dataset.url),
    home: () => home(),
    addSet: el => {
        const workout = WORKOUTS[el.dataset.id];
        const index = Number(el.dataset.index);
        sessionSets(workout, index).push({ weight: '', reps: '' });
        document.getElementById('set-rows').innerHTML = setRowsHtml(workout, index);
    }
};

// Ввод рабочих весов сохраняется сразу, чтобы не потеряться при переходах по списку
app.addEventListener('input', event => {
    const el = event.target;
    if (el.dataset.set === undefined) return;
    const { screen, params } = stack[stack.length - 1];
    if (screen !== 'exercise') return;
    sessionSets(WORKOUTS[params.id], params.index)[Number(el.dataset.set)][el.dataset.field] = el.value;
    updateRecordHint(WORKOUTS[params.id], params.index);
});

// ---------- Экраны ----------

function statsHtml() {
    return `
        <div class="stats">
            <div class="stat"><div class="stat-value">${progress.total}</div><div class="stat-label">${plural(progress.total, 'тренировка', 'тренировки', 'тренировок')}</div></div>
            <div class="stat"><div class="stat-value">${doneThisWeek()}</div><div class="stat-label">на этой неделе</div></div>
            <div class="stat"><div class="stat-value">${lastWeight ? formatKg(lastWeight) : '—'}</div><div class="stat-label">вес, кг</div></div>
        </div>`;
}

function setRowsHtml(workout, index) {
    const ex = workout.exercises[index];
    const sets = sessionSets(workout, index);
    const last = lastSession(ex.name);
    const planReps = parseSets(ex.sets).reps;
    return sets.map((s, i) => {
        const prev = last && last.sets[i];
        const weightHint = prev && prev.weight !== '' ? formatKg(prev.weight) : 'кг';
        const repsHint = prev && prev.reps !== '' ? prev.reps : (planReps || 'раз');
        return `
            <div class="set-row">
                <span class="set-num">${i + 1}</span>
                <input type="text" inputmode="decimal" data-set="${i}" data-field="weight" value="${escapeHtml(s.weight)}" placeholder="${escapeHtml(weightHint)}" autocomplete="off">
                <input type="text" inputmode="numeric" data-set="${i}" data-field="reps" value="${escapeHtml(s.reps)}" placeholder="${escapeHtml(repsHint)}" autocomplete="off">
            </div>`;
    }).join('');
}

function setsText(sets) {
    return sets.map(s => (s.weight !== '' ? formatKg(Number(s.weight)) + ' кг' : '') +
        (s.weight !== '' && s.reps !== '' ? ' × ' : '') + (s.reps !== '' ? s.reps : '')).join(', ');
}

function lastTimeText(name) {
    const last = lastSession(name);
    if (!last || !last.sets.length) return '';
    const record = personalRecord(exerciseLog[name]);
    return `В прошлый раз (${humanDate(isoDate(new Date(last.date)))}): ${setsText(last.sets)}` +
        (record ? `\nРекорд: ${bestText(record)} 🏆` : '');
}

function updateRecordHint(workout, index) {
    const hint = document.getElementById('record-hint');
    if (!hint) return;
    const name = workout.exercises[index].name;
    const sets = sessionSets(workout, index)
        .map(s => ({ weight: toNumber(s.weight), reps: toNumber(s.reps) }))
        .filter(s => s.weight !== '' || s.reps !== '');
    const beaten = loggedKeys.has(`${workout.id}:${index}`) ? null : isNewRecord(name, sets);
    if (beaten && hint.hidden) haptic('success');
    hint.hidden = !beaten;
    if (beaten) hint.textContent = `🏆 Новый рекорд! Было ${bestText(beaten)}`;
}

function rowHtml({ emoji, title, sub, go, id, done }) {
    const left = done === undefined
        ? `<span class="row-emoji">${emoji}</span>`
        : `<span class="check ${done ? 'done' : ''}">${done ? '✓' : ''}</span>`;
    return `
        <button class="row" data-go="${go}" data-id="${escapeHtml(id)}">
            ${left}
            <span class="row-body"><div class="row-title">${escapeHtml(title)}</div>${sub ? `<div class="row-sub">${escapeHtml(sub)}</div>` : ''}</span>
            <span class="row-arrow">›</span>
        </button>`;
}

const SCREENS = {
    home() {
        const { warmup, cooldown, gift } = DATA.extras;
        const name = user && user.first_name ? `, ${escapeHtml(user.first_name)}` : '';
        app.innerHTML = `
            <h1>Привет${name}! 💪</h1>
            <p class="hint">${CONFIG.paywall && hasAccess() && access.until ? `Подписка активна до ${new Date(access.until).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}` : 'Выбери, где тренируемся сегодня'}</p>
            ${!hasAccess() ? `
                <button class="banner gift-banner" data-go="workout" data-id="${gift.id}">
                    <span class="row-emoji">🎁</span>
                    <span class="row-body"><div class="row-title">Твой подарок: ${escapeHtml(gift.title)}</div><div class="banner-sub">Тренировка на ягодицы с таймером · ${durationText(gift)}</div></span>
                    <span>›</span>
                </button>
                <div class="list" style="margin-top:8px">
                    ${rowHtml({ emoji: '🧮', title: 'Моя норма КБЖУ и рацион', sub: 'Рассчитай калории и получи меню на день', go: 'nutrition', id: '' })}
                </div>
                <button class="banner unlock-banner" data-go="paywall">
                    <span class="row-emoji">🔓</span>
                    <span class="row-body"><div class="row-title">Открыть всё</div><div class="banner-sub">Программы, дневник весов, рацион каждый день · ${escapeHtml(CONFIG.price)}</div></span>
                    <span>›</span>
                </button>
                <h2>В полной версии</h2>` : ''}
            ${CONFIG.googleScriptUrl && hasAccess() && weighInDue() ? `
                <button class="banner" data-go="weight">
                    <span class="row-emoji">⚖️</span>
                    <span class="row-body"><div class="row-title">Пора взвеситься</div><div class="banner-sub">${lastWeightDate ? 'Прошла неделя с последнего замера' : 'Запиши свой стартовый вес'}</div></span>
                    <span>›</span>
                </button>` : ''}
            ${statsHtml()}
            <div class="tiles">
                ${DATA.programs.map(p => `
                    <button class="tile" data-go="program" data-id="${p.id}">
                        <span class="tile-emoji">${p.emoji}</span>
                        <span class="tile-title">${escapeHtml(p.title)}</span>
                        <span class="tile-sub">${p.workouts.length} ${plural(p.workouts.length, 'тренировка', 'тренировки', 'тренировок')}</span>
                    </button>`).join('')}
            </div>
            <div class="list" style="margin-top:10px">
                ${rowHtml({ emoji: '🥗', title: 'Питание', sub: 'Норма КБЖУ, рацион на день, рецепты, вода', go: 'nutrition', id: '' })}
            </div>
            <h2>Разминка и восстановление</h2>
            <div class="list">
                ${hasAccess() ? rowHtml({ emoji: gift.emoji, title: gift.title, sub: `Тренировка на ягодицы с таймером · ${durationText(gift)}`, go: 'workout', id: gift.id }) : ''}
                ${rowHtml({ emoji: warmup.emoji, title: warmup.title, sub: `${warmup.subtitle || 'Перед тренировкой'} · ${durationText(warmup)}`, go: 'workout', id: warmup.id })}
                ${rowHtml({ emoji: cooldown.emoji, title: cooldown.title, sub: `${cooldown.subtitle || 'После тренировки'} · ${durationText(cooldown)}`, go: 'workout', id: cooldown.id })}
            </div>
            <h2>Мой прогресс</h2>
            <div class="list">
                ${rowHtml({ emoji: '⚖️', title: 'Дневник веса', sub: 'Записать вес и посмотреть график', go: 'weight', id: '' })}
                ${rowHtml({ emoji: '📊', title: 'Мой прогресс', sub: 'Графики веса тела и рабочих весов', go: 'progressAll', id: '' })}
                <button class="row" data-action="coach"><span class="row-emoji">💬</span><span class="row-body"><div class="row-title">Написать тренеру</div></span><span class="row-arrow">›</span></button>
            </div>`;
    },

    program({ id }) {
        const program = DATA.programs.find(p => p.id === id);
        app.innerHTML = `
            <h1>${program.emoji} ${escapeHtml(program.title)}</h1>
            <p class="hint">Не забудь размяться перед тренировкой</p>
            <div class="list">
                ${program.workouts.map(w => {
                    const last = lastDoneDate(w.id);
                    const sub = `${w.exercises.length} ${plural(w.exercises.length, 'упражнение', 'упражнения', 'упражнений')}` + (last ? ` · выполнена ${humanDate(last)}` : '');
                    return rowHtml({ title: w.title, sub, go: 'workout', id: w.id, done: !!last });
                }).join('')}
            </div>`;
    },

    workout({ id }) {
        const workout = WORKOUTS[id];
        if (workout.timed) return SCREENS.timedOverview(workout);
        const { warmup, cooldown } = DATA.extras;
        const title = workout.program ? `${workout.program.emoji} ${escapeHtml(workout.title)}` : `${workout.emoji} ${escapeHtml(workout.title)}`;
        app.innerHTML = `
            <h1>${title}</h1>
            <p class="hint">${workout.program ? escapeHtml(workout.program.title) : ''}</p>
            ${workout.counts ? `<div class="list" style="margin-bottom:16px">${rowHtml({ emoji: warmup.emoji, title: `Сначала: ${warmup.title}`, go: 'workout', id: warmup.id })}</div>` : ''}
            <div class="list">
                ${workout.exercises.map((ex, i) => `
                    <button class="row" data-go="stories" data-id="${workout.id}" data-index="${i}">
                        <span class="check">${i + 1}</span>
                        <span class="row-body"><div class="row-title">${escapeHtml(ex.name)}</div><div class="row-sub">${escapeHtml(setsSummary(workout, i))}</div></span>
                        <span class="row-arrow">›</span>
                    </button>`).join('')}
            </div>
            ${workout.counts ? `<div class="list" style="margin-top:16px">${rowHtml({ emoji: cooldown.emoji, title: `После: ${cooldown.title}`, go: 'workout', id: cooldown.id })}</div>` : ''}`;
        if (workout.counts) loadExerciseLog();
        setMainButton('Начать ▶', () => go('stories', { id, index: 0 }));
    },

    exercise({ id, index }) {
        const workout = WORKOUTS[id];
        const ex = workout.exercises[index];
        const isLast = index === workout.exercises.length - 1;
        const isMp4 = ex.video && /\.mp4(\?|$)/i.test(ex.video);

        app.innerHTML = `
            <p class="hint" style="margin:0">${escapeHtml(workout.title)} · упражнение ${index + 1} из ${workout.exercises.length}</p>
            <div class="progress"><div style="width:${((index + 1) / workout.exercises.length) * 100}%"></div></div>
            <h1>${escapeHtml(ex.name)}</h1>
            ${ex.sets ? `<div class="sets">${escapeHtml(ex.sets)}</div>` : ''}
            ${isMp4 ? `<video src="${escapeHtml(ex.video)}" controls playsinline preload="metadata"></video>` : ''}
            ${ex.video && !isMp4 ? `<button class="btn secondary" data-action="video" data-url="${escapeHtml(ex.video)}">▶ Смотреть видео</button>` : ''}
            ${ex.description ? `<p class="description">${escapeHtml(ex.description)}</p>` : ''}
            ${workout.counts ? `
                <h2>Рабочие веса</h2>
                <div class="sets-head"><span>Подход</span><span>Вес, кг</span><span>Повторы</span></div>
                <div id="set-rows">${setRowsHtml(workout, index)}</div>
                <div class="record-hint" id="record-hint" hidden></div>
                <button class="link" data-action="addSet" data-id="${workout.id}" data-index="${index}">＋ Добавить подход</button>
                <p class="hint description" id="last-time">${escapeHtml(lastTimeText(ex.name))}</p>
                ${apiEnabled ? `<button class="link" data-go="exerciseProgress" data-id="${escapeHtml(ex.name)}">📈 Мой прогресс в упражнении</button><br>` : ''}` : ''}
            <button class="link" data-action="list">📋 Список упражнений</button>`;

        // История могла догрузиться уже после открытия экрана
        if (workout.counts) updateRecordHint(workout, index);
        if (workout.counts && logRequest) {
            logRequest.then(() => {
                const current = stack[stack.length - 1];
                if (current.screen !== 'exercise' || current.params.id !== id || current.params.index !== index) return;
                document.getElementById('last-time').textContent = lastTimeText(ex.name);
                document.getElementById('set-rows').innerHTML = setRowsHtml(workout, index);
                updateRecordHint(workout, index);
            });
        }

        ACTIONS.list = () => { logExercise(workout, index); back(); };
        setMainButton(isLast ? 'Завершить тренировку ✅' : 'Следующее ▸', () => {
            haptic();
            if (isLast) {
                completeWorkout(workout);
            } else {
                logExercise(workout, index);
                go('exercise', { id, index: index + 1 }, true);
            }
        });
    },

    paywall() {
        app.innerHTML = `
            <div class="finish">
                <div class="finish-emoji">🔓</div>
                <h1>Открой полную версию</h1>
                <p class="hint">Всё для красивых ягодиц и здорового питания — в одном приложении</p>
            </div>
            <div class="card">
                <ul class="features">
                    <li>🏋️ Программы тренировок в зале и дома</li>
                    <li>📝 Дневник рабочих весов, рекорды и графики прогресса</li>
                    <li>🥗 Рацион каждый день под твою норму и рецепты с КБЖУ</li>
                    <li>📅 Трекер воды, белка, углеводов и калорий</li>
                    <li>⚖️ Дневник веса с еженедельными напоминаниями</li>
                    <li>🤸 Разминка и 🌀 МФР с таймером</li>
                    <li>💬 Связь с тренером</li>
                </ul>
            </div>
            <div class="price">${escapeHtml(CONFIG.price)}</div>
            <p class="hint" style="text-align:center">Нажми кнопку — откроется бот, там выбери тариф и оплати.<br>После оплаты вернись сюда и нажми «Я оплатила».</p>
            <button class="btn secondary" data-action="refreshAccess">🔄 Я оплатила — проверить</button>
            <button class="link" data-action="coach" style="display:block;margin:8px auto 0">Вопрос по оплате? Написать тренеру</button>`;

        ACTIONS.refreshAccess = el => {
            el.disabled = true;
            el.textContent = 'Проверяю…';
            checkAccess().then(ok => {
                if (stack[stack.length - 1].screen !== 'paywall') return;
                el.disabled = false;
                el.textContent = '🔄 Я оплатила — проверить';
                const text = ok
                    ? `Готово! Доступ открыт до ${new Date(access.until).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })} 🎉`
                    : 'Оплата пока не найдена. Если ты только что оплатила — подожди минуту и нажми ещё раз. Не получается — напиши тренеру.';
                inTelegram ? tg.showAlert(text) : alert(text);
                if (ok) home();
            });
        };
        setMainButton(`Оформить подписку · ${CONFIG.price}`, () => openLink(CONFIG.payLink));
    },

    timedOverview(workout) {
        app.innerHTML = `
            <h1>${workout.emoji} ${escapeHtml(workout.title)}</h1>
            <p class="hint">${escapeHtml(workout.subtitle || '')}</p>
            <div class="tags">
                <span class="tag">⏱ ${durationText(workout)}</span>
                <span class="tag">${workout.exercises.length} ${plural(workout.exercises.length, 'упражнение', 'упражнения', 'упражнений')}${workout.rounds > 1 ? ` × ${workout.rounds} ${plural(workout.rounds, 'круг', 'круга', 'кругов')}` : ''}</span>
                ${workout.equipment ? `<span class="tag">🧰 ${escapeHtml(workout.equipment)}</span>` : ''}
            </div>
            ${workout.intro ? `<p class="description">${escapeHtml(workout.intro)}</p>` : ''}
            ${workout.rules ? `
                <div class="card tip">
                    <div class="row-title" style="margin-bottom:6px">⚠️ Важно</div>
                    <ul class="rules">${workout.rules.map(r => `<li>${escapeHtml(r)}</li>`).join('')}</ul>
                </div>` : ''}
            <h2>Упражнения</h2>
            <div class="list">
                ${workout.exercises.map((ex, i) => `
                    <button class="row" data-go="timed" data-id="${workout.id}" data-index="${i}">
                        <span class="check">${i + 1}</span>
                        <span class="row-body">
                            <div class="row-title">${escapeHtml(ex.name)}</div>
                            <div class="row-sub">${exDurationText(ex)}${ex.equipment ? ' · ' + escapeHtml(ex.equipment) : ''}</div>
                        </span>
                        <span class="row-arrow">›</span>
                    </button>`).join('')}
            </div>
            <p class="hint" style="margin-top:12px">Нажми «Начать» — приложение само поведёт по упражнениям: таймер, смена сторон и переход к следующему. Телефон можно положить рядом.</p>`;
        setMainButton('Начать ▶', () => {
            timer.id = null;
            resetTimer(workout.id, 0);
            go('timed', { id: workout.id, index: 0 });
        });
    },

    timed({ id, index }) {
        const workout = WORKOUTS[id];
        const ex = workout.exercises[index];
        const sides = ex.sides || 1;
        const rounds = workout.rounds || 1;
        const isLastInRound = index === workout.exercises.length - 1;
        const isMp4 = ex.video && /\.mp4(\?|$)/i.test(ex.video);
        if (timer.id !== id || timer.index !== index) resetTimer(id, index);
        const isRest = () => timer.phase === 'rest';
        const upcoming = isLastInRound
            ? (timer.round < rounds - 1 ? { ex: workout.exercises[0], text: `Круг ${timer.round + 2}: ` } : null)
            : { ex: workout.exercises[index + 1], text: '' };

        app.innerHTML = `
            <p class="hint" style="margin:0">${escapeHtml(workout.title)}${rounds > 1 ? ` · круг ${timer.round + 1} из ${rounds}` : ''} · ${index + 1} из ${workout.exercises.length}</p>
            <div class="progress"><div style="width:${((timer.round * workout.exercises.length + index + 1) / (rounds * workout.exercises.length)) * 100}%"></div></div>
            <div class="rest-label" id="rest-label" hidden>Отдых — приготовься к упражнению</div>
            <h1>${escapeHtml(ex.name)}</h1>
            ${ex.equipment ? `<div class="tags"><span class="tag">🧰 ${escapeHtml(ex.equipment)}</span></div>` : ''}
            <div class="timer" id="timer-box">
                <svg viewBox="0 0 120 120" aria-hidden="true">
                    <circle class="timer-track" cx="60" cy="60" r="54"></circle>
                    <circle class="timer-ring" id="timer-ring" cx="60" cy="60" r="54"></circle>
                </svg>
                <div class="timer-center">
                    <div class="timer-value" id="timer-value"></div>
                    <div class="timer-side" id="timer-side"></div>
                </div>
            </div>
            ${ex.maxDuration ? `<button class="btn secondary pain-btn" id="pain-btn" data-action="timerExtend"></button>` : ''}
            <div class="timer-controls">
                <button class="link" data-action="timerPrev" ${index === 0 ? 'disabled' : ''}>‹ Предыдущее</button>
                <button class="link" data-action="timerRestart">↺ Заново</button>
                <button class="link" data-action="timerSkip" id="skip-btn"></button>
            </div>
            ${isMp4 ? `<video src="${escapeHtml(ex.video)}" controls playsinline preload="metadata"></video>` : ''}
            ${ex.video && !isMp4 ? `<button class="btn secondary" data-action="video" data-url="${escapeHtml(ex.video)}">▶ Смотреть видео</button>` : ''}
            ${ex.description ? `<p class="description">${escapeHtml(ex.description)}</p>` : ''}
            <div class="next-up">${upcoming ? `Дальше: ${upcoming.text}<b>${escapeHtml(upcoming.ex.name)}</b> · ${exDurationText(upcoming.ex)}` : 'Это последнее упражнение 💪'}</div>`;

        // Следующее упражнение (с отдыхом перед ним), следующий круг или финиш
        const goNext = () => {
            if (!isLastInRound) {
                resetTimer(id, index + 1, 'rest', workout.rest);
                go('timed', { id, index: index + 1 }, true);
            } else if (timer.round < rounds - 1) {
                timer.round += 1;
                resetTimer(id, 0, 'rest', workout.roundRest || workout.rest);
                go('timed', { id, index: 0 }, true);
            } else {
                timer.running = false;
                timer.id = null;
                go('finish', { id }, true);
            }
        };

        const startWork = () => {
            timer.phase = 'work';
            timer.side = 0;
            timer.left = timer.total = ex.duration;
            timer.extended = false;
        };

        const update = () => {
            const circumference = 2 * Math.PI * 54;
            document.getElementById('timer-ring').style.strokeDashoffset = String(circumference * (1 - timer.left / timer.total));
            document.getElementById('timer-value').textContent = formatTime(timer.left);
            document.getElementById('timer-box').classList.toggle('resting', isRest());
            document.getElementById('rest-label').hidden = !isRest();
            document.getElementById('timer-side').textContent = isRest()
                ? (timer.index === 0 && timer.round > 0 ? `Отдых перед кругом ${timer.round + 1}` : 'Отдых')
                : sides > 1 ? (timer.side === 0 ? 'Первая сторона' : 'Вторая сторона') : '';
            document.getElementById('skip-btn').textContent = isRest()
                ? 'Начать сразу ›'
                : upcoming ? 'Пропустить ›' : 'Завершить ›';
            const painBtn = document.getElementById('pain-btn');
            if (painBtn) {
                painBtn.hidden = isRest();
                painBtn.disabled = timer.extended;
                painBtn.textContent = timer.extended
                    ? `✓ Продлено до ${formatMinutes(ex.maxDuration)} — катай медленно`
                    : `😣 Болит — продлить до ${formatMinutes(ex.maxDuration)}`;
            }
            const fresh = timer.left === timer.total && timer.side === 0 && !timer.extended && !isRest();
            setMainButton(timer.running ? '⏸ Пауза' : fresh ? '▶ Старт' : '▶ Продолжить', toggle);
        };

        const tick = () => {
            timer.left -= 1;
            if (timer.left > 0 && timer.left <= 3) { beep(660, 80); haptic(); }
            if (timer.left > 0) return update();
            if (isRest()) {
                startWork();
                beep(990, 250);
                haptic('success');
                return update();
            }
            if (timer.side < sides - 1) {
                timer.side += 1;
                timer.left = timer.total = ex.duration;
                timer.extended = false;
                beep(990, 250);
                haptic('success');
                document.getElementById('timer-side').classList.add('flash');
                return update();
            }
            beep(990, 350);
            haptic('success');
            stopTimer();
            goNext();
        };

        const start = () => {
            timer.running = true;
            unlockAudio();
            keepScreenOn(true);
            stopTimer();
            timer.interval = setInterval(tick, 1000);
            update();
        };
        const toggle = () => {
            haptic();
            if (timer.running) {
                timer.running = false;
                stopTimer();
                keepScreenOn(false);
                update();
            } else {
                start();
            }
        };

        // Болевые ощущения: время этой стороны увеличивается до maxDuration, уже пройденное засчитывается
        ACTIONS.timerExtend = () => {
            if (!ex.maxDuration || timer.extended || isRest()) return;
            timer.left += ex.maxDuration - timer.total;
            timer.total = ex.maxDuration;
            timer.extended = true;
            haptic();
            update();
            if (!timer.running) start();
        };
        ACTIONS.timerSkip = () => {
            if (isRest()) {
                startWork();
                update();
                return;
            }
            stopTimer();
            goNext();
        };
        ACTIONS.timerPrev = () => {
            if (index === 0) return;
            resetTimer(id, index - 1);
            go('timed', { id, index: index - 1 }, true);
        };
        ACTIONS.timerRestart = () => { startWork(); stopTimer(); update(); if (timer.running) start(); };

        update();
        if (timer.running) start();
    },

    finish({ id, sets, records = [] }) {
        const workout = WORKOUTS[id];
        const { cooldown } = DATA.extras;
        haptic('success');
        app.innerHTML = `
            <div class="finish">
                <div class="finish-emoji">🎉</div>
                <h1>${workout.counts ? 'Тренировка завершена!' : 'Готово!'}</h1>
                <p class="hint">${workout.counts ? 'Ты молодец! Так держать 🔥' : id === DATA.extras.warmup.id ? 'Мышцы разогреты — можно начинать тренировку 💪' : 'Отличная работа! Мышцы скажут спасибо 🙏'}</p>
                ${sets ? `<p class="hint">Записано подходов: ${sets} 📝</p>` : ''}
            </div>
            ${records.length ? `
                <div class="card records">
                    <div class="row-title">🏆 ${records.length > 1 ? 'Новые рекорды' : 'Новый рекорд'}!</div>
                    ${records.map(r => `<div class="history-row"><span>${escapeHtml(r.exercise)}</span><b>${escapeHtml(r.text)}</b></div>`).join('')}
                </div>` : ''}
            ${workout.counts ? statsHtml() : ''}
            <div class="list">
                ${workout.counts ? rowHtml({ emoji: cooldown.emoji, title: cooldown.title, sub: 'Восстановление после тренировки', go: 'workout', id: cooldown.id }) : ''}
                ${rowHtml({ emoji: '⚖️', title: 'Записать вес', go: 'weight', id: '' })}
                <button class="row" data-action="coach"><span class="row-emoji">💬</span><span class="row-body"><div class="row-title">Рассказать тренеру, как прошло</div></span><span class="row-arrow">›</span></button>
            </div>`;
        setMainButton('На главную', home);
    },

    records() {
        app.innerHTML = `
            <h1>📈 Прогресс в упражнениях</h1>
            <p class="hint">Твои рекорды и история рабочих весов</p>
            <div id="records-body"></div>`;
        const body = document.getElementById('records-body');
        if (!apiEnabled) {
            body.innerHTML = '<div class="message">Открой приложение через бота, чтобы увидеть свой прогресс 🤖</div>';
            return;
        }
        if (!logLoaded) {
            body.innerHTML = '<div class="message">Загрузка…</div>';
            loadExerciseLog().then(() => {
                const current = stack[stack.length - 1];
                if (current.screen !== 'records') return;
                if (logLoaded) render();
                else body.innerHTML = '<div class="message">Не получилось загрузить данные 😢</div>';
            });
            return;
        }
        const names = Object.keys(exerciseLog)
            .filter(name => exerciseLog[name].length)
            .sort((a, b) => new Date(lastSession(b).date) - new Date(lastSession(a).date));
        if (names.length === 0) {
            body.innerHTML = '<div class="message">Пока нет записей.<br>Вписывай вес и повторы во время тренировки — здесь появится твой прогресс 💪</div>';
            return;
        }
        body.innerHTML = `<div class="list">${names.map(name => {
            const count = exerciseLog[name].length;
            const sub = `Рекорд: ${bestText(personalRecord(exerciseLog[name]))} · ${count} ${plural(count, 'тренировка', 'тренировки', 'тренировок')}`;
            return rowHtml({ emoji: '🏆', title: name, sub, go: 'exerciseProgress', id: name });
        }).join('')}</div>`;
    },

    // Оба графика на одном экране: вес тела и рабочие веса в выбранном упражнении
    progressAll() {
        app.innerHTML = `
            <h1>📊 Мой прогресс</h1>
            <div class="chips" id="period">
                ${[[30, 'Месяц'], [90, '3 месяца'], [0, 'Всё время']].map(([days, title]) =>
                    `<button class="chip ${progressPeriod === days ? 'active' : ''}" data-action="period" data-id="${days}">${title}</button>`).join('')}
            </div>
            <h2>⚖️ Вес тела</h2>
            <div id="body-weight"><div class="message">Загрузка…</div></div>
            <h2>🏋️ Рабочие веса</h2>
            <div id="lifts"><div class="message">Загрузка…</div></div>`;

        ACTIONS.period = el => { progressPeriod = Number(el.dataset.id); render(); };
        ACTIONS.pickExercise = el => { progressExercise = el.dataset.id; drawLifts(); };

        if (!apiEnabled) {
            const text = '<div class="message">Открой приложение через бота, чтобы увидеть свой прогресс 🤖</div>';
            document.getElementById('body-weight').innerHTML = text;
            document.getElementById('lifts').innerHTML = '';
            return;
        }

        const inPeriod = date => !progressPeriod || Date.now() - new Date(date) <= progressPeriod * 864e5;
        const isCurrent = () => stack[stack.length - 1].screen === 'progressAll';

        // Вес тела
        (weightEntries ? Promise.resolve(weightEntries) : fetchWeightEntries()).then(entries => {
            if (!isCurrent()) return;
            const el = document.getElementById('body-weight');
            const shown = entries.filter(e => inPeriod(e.date));
            if (shown.length === 0) {
                el.innerHTML = `<div class="card empty">${entries.length ? 'За этот период замеров нет' : 'Пока нет замеров'}<br><button class="link" data-go="weight">⚖️ Записать вес</button></div>`;
                return;
            }
            const first = shown[0].weight;
            const last = shown[shown.length - 1].weight;
            const diff = last - first;
            el.innerHTML = `
                <div class="stats">
                    <div class="stat"><div class="stat-value">${formatKg(first)}</div><div class="stat-label">было, кг</div></div>
                    <div class="stat"><div class="stat-value">${formatKg(last)}</div><div class="stat-label">сейчас, кг</div></div>
                    <div class="stat"><div class="stat-value">${signed(diff)}</div><div class="stat-label">изменение</div></div>
                </div>
                ${shown.length > 1 ? '<div class="card"><canvas id="body-chart"></canvas></div>' : '<p class="hint">График появится после второго замера</p>'}
                <button class="link" data-go="weight">⚖️ Записать вес</button>`;
            if (shown.length > 1) {
                lineChart(document.getElementById('body-chart'),
                    shown.map(e => e.date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })),
                    shown.map(e => e.weight),
                    v => formatKg(v) + ' кг');
            }
        }).catch(error => {
            console.error('Вес тела:', error);
            if (isCurrent()) document.getElementById('body-weight').innerHTML = '<div class="message">Не получилось загрузить вес 😢</div>';
        });

        // Рабочие веса
        const drawLifts = () => {
            const el = document.getElementById('lifts');
            if (!el) return;
            const names = Object.keys(exerciseLog)
                .filter(name => exerciseLog[name].some(s => inPeriod(s.date)))
                .sort((a, b) => new Date(lastSession(b).date) - new Date(lastSession(a).date));
            if (names.length === 0) {
                el.innerHTML = `<div class="card empty">${Object.keys(exerciseLog).length ? 'За этот период тренировок с записанными весами нет' : 'Вписывай вес и повторы во время тренировки — здесь появится график'}</div>`;
                return;
            }
            if (!names.includes(progressExercise)) progressExercise = names[0];
            const series = exerciseSeries(progressExercise, inPeriod);
            const { points, byWeight, record } = series;
            const fmt = v => (v === null || v === undefined ? '—' : byWeight ? formatKg(v) : String(v));
            const unit = byWeight ? 'кг' : 'повт.';
            el.innerHTML = `
                <div class="chips scroll">
                    ${names.map(name => `<button class="chip ${name === progressExercise ? 'active' : ''}" data-action="pickExercise" data-id="${escapeHtml(name)}">${escapeHtml(name)}</button>`).join('')}
                </div>
                <div class="stats">
                    <div class="stat"><div class="stat-value">${fmt(points[0] && points[0].best.value)}</div><div class="stat-label">было, ${unit}</div></div>
                    <div class="stat"><div class="stat-value">${fmt(points.length ? points[points.length - 1].best.value : null)}</div><div class="stat-label">сейчас, ${unit}</div></div>
                    <div class="stat"><div class="stat-value">${fmt(record && record.value)}</div><div class="stat-label">рекорд 🏆</div></div>
                </div>
                ${points.length > 1 ? '<div class="card"><canvas id="lift-chart"></canvas></div>' : '<p class="hint">График появится после второй тренировки с этим упражнением</p>'}
                <button class="link" data-go="exerciseProgress" data-id="${escapeHtml(progressExercise)}">📋 Вся история упражнения</button><br>
                <button class="link" data-go="records">🏆 Все упражнения и рекорды</button>`;
            if (points.length > 1) {
                lineChart(document.getElementById('lift-chart'),
                    points.map(s => new Date(s.date).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })),
                    points.map(s => s.best.value),
                    v => byWeight ? formatKg(v) + ' кг' : v + ' повт.');
            }
        };
        loadExerciseLog().then(() => {
            if (!isCurrent()) return;
            if (logLoaded) drawLifts();
            else document.getElementById('lifts').innerHTML = '<div class="message">Не получилось загрузить данные 😢</div>';
        });
    },

    exerciseProgress({ id: name }) {
        app.innerHTML = `
            <h1>${escapeHtml(name)}</h1>
            <p class="hint">Прогресс рабочих весов</p>
            <div id="progress-body"><div class="message">Загрузка…</div></div>`;
        const body = document.getElementById('progress-body');

        if (!logLoaded) {
            loadExerciseLog().then(() => {
                const current = stack[stack.length - 1];
                if (current.screen === 'exerciseProgress' && logLoaded) render();
            });
            if (apiEnabled) return;
        }
        const list = exerciseLog[name] || [];
        if (list.length === 0) {
            body.innerHTML = '<div class="message">Пока нет записей по этому упражнению 📝</div>';
            return;
        }

        const { sessions, points, byWeight, record } = exerciseSeries(name);
        const unit = byWeight ? 'кг' : 'повт.';
        const first = points[0] && points[0].best.value;
        const last = points.length ? points[points.length - 1].best.value : null;
        const fmt = v => (v === null || v === undefined ? '—' : byWeight ? formatKg(v) : String(v));

        body.innerHTML = `
            <div class="stats">
                <div class="stat"><div class="stat-value">${fmt(first)}</div><div class="stat-label">старт, ${unit}</div></div>
                <div class="stat"><div class="stat-value">${fmt(last)}</div><div class="stat-label">сейчас, ${unit}</div></div>
                <div class="stat"><div class="stat-value">${fmt(record && record.value)}</div><div class="stat-label">рекорд 🏆</div></div>
            </div>
            ${points.length > 1 ? '<div class="card"><canvas id="progress-chart"></canvas></div>' : ''}
            <h2>История</h2>
            <div class="card">
                ${sessions.slice().reverse().map(s => `
                    <div class="history-row">
                        <span>${new Date(s.date).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}${s.isRecord ? ' 🏆' : ''}</span>
                        <span class="history-sets">${escapeHtml(setsText(s.sets))}</span>
                    </div>`).join('')}
            </div>`;

        if (points.length > 1) {
            lineChart(document.getElementById('progress-chart'),
                points.map(s => new Date(s.date).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })),
                points.map(s => s.best.value),
                v => byWeight ? formatKg(v) + ' кг' : v + ' повт.');
        }
    },

    weight() {
        app.innerHTML = `
            <h1>⚖️ Дневник веса</h1>
            <p class="hint">Взвешивайся утром натощак — так цифры честнее</p>
            <form class="weight-form" id="weight-form">
                <input id="weight-input" type="text" inputmode="decimal" placeholder="Вес, кг" autocomplete="off">
                <button class="btn" type="submit">Сохранить</button>
            </form>
            <div id="weight-body"><div class="message">Загрузка…</div></div>`;

        document.getElementById('weight-form').addEventListener('submit', event => {
            event.preventDefault();
            const input = document.getElementById('weight-input');
            const value = parseFloat(input.value.replace(',', '.'));
            if (!(value > 20 && value < 300)) {
                input.focus();
                if (inTelegram) tg.showAlert('Введи вес в килограммах, например 62,5');
                return;
            }
            input.blur();
            input.value = '';
            loadWeights(value);
        });
        loadWeights();
    }
};

// ---------- Дневник веса (Google Таблица через Apps Script) ----------

let weightEntries = null;
let progressPeriod = 0;
let progressExercise = null;

// Лучший результат каждой тренировки и отметка, был ли он рекордом на тот момент
function exerciseSeries(name, filter = () => true) {
    const list = exerciseLog[name] || [];
    const record = personalRecord(list);
    const byWeight = record ? record.byWeight : false;
    let max = -Infinity;
    const sessions = list.map(s => {
        const best = sessionBest(s.sets);
        const comparable = best && best.byWeight === byWeight;
        const isRecord = comparable && best.value > max && max !== -Infinity;
        if (comparable) max = Math.max(max, best.value);
        return { ...s, best: comparable ? best : null, isRecord };
    });
    const points = sessions.filter(s => s.best && filter(s.date));
    return { sessions, points, byWeight, record };
}

async function fetchWeightEntries(newWeight) {
    const data = newWeight
        ? await api('POST', { action: 'weight', weight: newWeight })
        : await api('GET');
    if (!Array.isArray(data)) throw new Error('Неверный ответ');
    weightEntries = data
        .map(row => ({ date: new Date(row.date), weight: parseFloat(String(row.weight).replace(',', '.')) }))
        .filter(e => !isNaN(e.date) && !isNaN(e.weight))
        .sort((a, b) => a.date - b.date);
    return weightEntries;
}

async function loadWeights(newWeight) {
    const body = document.getElementById('weight-body');
    if (!CONFIG.googleScriptUrl) {
        body.innerHTML = '<div class="message">Дневник веса скоро заработает 🛠</div>';
        return;
    }
    if (!inTelegram) {
        body.innerHTML = '<div class="message">Открой приложение через бота, чтобы увидеть свой вес 🤖</div>';
        return;
    }
    body.innerHTML = `<div class="message">${newWeight ? 'Сохраняю…' : 'Загрузка…'}</div>`;

    try {
        const entries = await fetchWeightEntries(newWeight);
        if (newWeight) haptic('success');
        renderWeights(entries);
    } catch (error) {
        console.error('Ошибка дневника веса:', error);
        body.innerHTML = `<div class="message">${newWeight ? 'Не получилось сохранить' : 'Не получилось загрузить данные'} 😢<br><button class="link" id="weight-retry">Попробовать снова</button></div>`;
        document.getElementById('weight-retry').addEventListener('click', () => loadWeights(newWeight));
    }
}

function renderWeights(entries) {
    const body = document.getElementById('weight-body');
    if (entries.length === 0) {
        body.innerHTML = '<div class="message">Пока нет ни одного замера. Запиши первый! ⚖️</div>';
        return;
    }

    rememberLastWeight(entries[entries.length - 1].weight, entries[entries.length - 1].date);

    const diff = lastWeight - entries[0].weight;
    body.innerHTML = `
        <div class="stats">
            <div class="stat"><div class="stat-value">${formatKg(entries[0].weight)}</div><div class="stat-label">старт</div></div>
            <div class="stat"><div class="stat-value">${formatKg(lastWeight)}</div><div class="stat-label">сейчас</div></div>
            <div class="stat"><div class="stat-value">${signed(diff)}</div><div class="stat-label">изменение</div></div>
        </div>
        ${entries.length > 1 ? '<div class="card"><canvas id="weight-chart"></canvas></div>' : ''}
        <h2>История</h2>
        <div class="card">
            ${entries.slice(-10).reverse().map(e => `
                <div class="history-row">
                    <span>${e.date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}</span>
                    <b>${formatKg(e.weight)} кг</b>
                </div>`).join('')}
        </div>`;

    if (entries.length > 1) {
        lineChart(document.getElementById('weight-chart'),
            entries.map(e => e.date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })),
            entries.map(e => e.weight),
            v => formatKg(v) + ' кг');
    }
}

const charts = [];

function destroyCharts() {
    while (charts.length) charts.pop().destroy();
}

function lineChart(canvas, labels, values, formatValue) {
    if (typeof Chart === 'undefined' || !canvas) return;
    const theme = (tg && tg.themeParams) || {};
    const color = theme.button_color || '#e0567a';
    const textColor = theme.hint_color || '#8e8e93';
    const existing = Chart.getChart(canvas);
    if (existing) existing.destroy();
    charts.push(new Chart(canvas, {
        type: 'line',
        data: {
            labels,
            datasets: [{
                data: values,
                borderColor: color,
                backgroundColor: color + '22',
                fill: true,
                borderWidth: 3,
                tension: 0.3,
                pointRadius: 4,
                pointBackgroundColor: color
            }]
        },
        options: {
            plugins: {
                legend: { display: false },
                tooltip: { callbacks: { label: ctx => formatValue(ctx.parsed.y) } }
            },
            scales: {
                x: { ticks: { color: textColor, maxRotation: 0, autoSkip: true, maxTicksLimit: 5 }, grid: { display: false } },
                y: { ticks: { color: textColor, maxTicksLimit: 6 }, grid: { color: textColor + '33' } }
            }
        }
    }));
}

// ---------- Старт ----------

// Регистрируем клиента для еженедельных напоминаний и узнаём дату последнего замера
function hello() {
    if (!apiEnabled) return Promise.resolve(null);
    return api('POST', { action: 'hello' })
        .then(data => {
            if (data.access) {
                const before = hasAccess();
                saveAccess(data.access);
                const screen = stack.length && stack[stack.length - 1].screen;
                if (before !== hasAccess() && (screen === 'home' || screen === 'paywall')) render();
            }
            if (!data.lastWeightDate) return data;
            const date = new Date(data.lastWeightDate);
            if (lastWeightDate && isoDate(date) <= lastWeightDate) return data;
            rememberLastWeight(data.lastWeight, date);
            if (stack.length && stack[stack.length - 1].screen === 'home') render();
            return data;
        })
        .catch(error => {
            console.error('Регистрация клиента:', error);
            return null;
        });
}

// Повторная проверка подписки (кнопка «Я оплатила»)
function checkAccess() {
    return hello().then(() => hasAccess());
}

loadProgress().then(() => {
    hello();
    flushLogs();
    // Сразу открыть нужный экран: адрес кнопки ...fitness-bot-webapp/?open=weight
    // или ссылка t.me/Nina_fitbody_bot/app?startapp=weight
    const start = new URLSearchParams(location.search).get('open') || (inTelegram && tg.initDataUnsafe.start_param);
    home();
    if (start === 'gift') go('workout', { id: 'gift' });
    else if (start === 'weight') go('weight');
    else if (start === 'nutrition' || start === 'day') go(start);
    else if (start && WORKOUTS[start]) go('workout', { id: start });
});
