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

function setMainButton(text, handler) {
    mainHandler = handler;
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

// ---------- Навигация ----------

const stack = [];

function go(screen, params = {}, replace = false) {
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

function render() {
    const { screen, params } = stack[stack.length - 1];
    setMainButton(null);
    setBackButton(stack.length > 1);
    window.scrollTo(0, 0);
    SCREENS[screen](params);
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
        const { warmup, cooldown } = DATA.extras;
        const name = user && user.first_name ? `, ${escapeHtml(user.first_name)}` : '';
        app.innerHTML = `
            <h1>Привет${name}! 💪</h1>
            <p class="hint">Выбери, где тренируемся сегодня</p>
            ${CONFIG.googleScriptUrl && weighInDue() ? `
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
            <h2>Разминка и восстановление</h2>
            <div class="list">
                ${rowHtml({ emoji: warmup.emoji, title: warmup.title, sub: 'Перед тренировкой', go: 'workout', id: warmup.id })}
                ${rowHtml({ emoji: cooldown.emoji, title: cooldown.title, sub: 'После тренировки', go: 'workout', id: cooldown.id })}
            </div>
            <h2>Мой прогресс</h2>
            <div class="list">
                ${rowHtml({ emoji: '⚖️', title: 'Дневник веса', sub: 'Записать вес и посмотреть график', go: 'weight', id: '' })}
                ${rowHtml({ emoji: '📈', title: 'Прогресс в упражнениях', sub: 'Рекорды и история рабочих весов', go: 'records', id: '' })}
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
        const { warmup, cooldown } = DATA.extras;
        const title = workout.program ? `${workout.program.emoji} ${escapeHtml(workout.title)}` : `${workout.emoji} ${escapeHtml(workout.title)}`;
        app.innerHTML = `
            <h1>${title}</h1>
            <p class="hint">${workout.program ? escapeHtml(workout.program.title) : ''}</p>
            ${workout.counts ? `<div class="list" style="margin-bottom:16px">${rowHtml({ emoji: warmup.emoji, title: `Сначала: ${warmup.title}`, go: 'workout', id: warmup.id })}</div>` : ''}
            <div class="list">
                ${workout.exercises.map((ex, i) => `
                    <button class="row" data-go="exercise" data-id="${workout.id}" data-index="${i}">
                        <span class="check">${i + 1}</span>
                        <span class="row-body"><div class="row-title">${escapeHtml(ex.name)}</div>${ex.sets ? `<div class="row-sub">${escapeHtml(ex.sets)}</div>` : ''}</span>
                        <span class="row-arrow">›</span>
                    </button>`).join('')}
            </div>
            ${workout.counts ? `<div class="list" style="margin-top:16px">${rowHtml({ emoji: cooldown.emoji, title: `После: ${cooldown.title}`, go: 'workout', id: cooldown.id })}</div>` : ''}`;
        if (workout.counts) loadExerciseLog();
        setMainButton('Начать ▶', () => go('exercise', { id, index: 0 }));
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
                let sets = 0;
                let records = [];
                if (workout.counts) {
                    workout.exercises.forEach((_, i) => logExercise(workout, i));
                    sets = loggedSetsCount;
                    records = newRecords.slice();
                    clearSession(workout);
                    markDone(workout.id);
                }
                go('finish', { id, sets, records }, true);
            } else {
                logExercise(workout, index);
                go('exercise', { id, index: index + 1 }, true);
            }
        });
    },

    finish({ id, sets, records = [] }) {
        const workout = WORKOUTS[id];
        const { cooldown } = DATA.extras;
        haptic('success');
        app.innerHTML = `
            <div class="finish">
                <div class="finish-emoji">🎉</div>
                <h1>${workout.counts ? 'Тренировка завершена!' : 'Готово!'}</h1>
                <p class="hint">${workout.counts ? 'Ты молодец! Так держать 🔥' : 'Отличная работа'}</p>
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

        const record = personalRecord(list);
        const byWeight = record ? record.byWeight : false;
        const unit = byWeight ? 'кг' : 'повт.';
        // Лучший результат каждой тренировки и отметка, был ли он рекордом на тот момент
        let max = -Infinity;
        const sessions = list.map(s => {
            const best = sessionBest(s.sets);
            const comparable = best && best.byWeight === byWeight;
            const isRecord = comparable && best.value > max && max !== -Infinity;
            if (comparable) max = Math.max(max, best.value);
            return { ...s, best: comparable ? best : null, isRecord };
        });
        const points = sessions.filter(s => s.best);
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

let chart;

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
        const data = newWeight
            ? await api('POST', { action: 'weight', weight: newWeight })
            : await api('GET');
        if (!Array.isArray(data)) throw new Error('Неверный ответ');

        const entries = data
            .map(row => ({ date: new Date(row.date), weight: parseFloat(String(row.weight).replace(',', '.')) }))
            .filter(e => !isNaN(e.date) && !isNaN(e.weight))
            .sort((a, b) => a.date - b.date);

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
            <div class="stat"><div class="stat-value">${diff > 0 ? '+' : ''}${formatKg(diff)}</div><div class="stat-label">изменение</div></div>
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

function lineChart(canvas, labels, values, formatValue) {
    if (typeof Chart === 'undefined' || !canvas) return;
    const theme = (tg && tg.themeParams) || {};
    const color = theme.button_color || '#e0567a';
    const textColor = theme.hint_color || '#8e8e93';
    if (chart) chart.destroy();
    chart = new Chart(canvas, {
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
                x: { ticks: { color: textColor }, grid: { display: false } },
                y: { ticks: { color: textColor }, grid: { color: textColor + '33' } }
            }
        }
    });
}

// ---------- Старт ----------

// Регистрируем клиента для еженедельных напоминаний и узнаём дату последнего замера
function hello() {
    if (!apiEnabled) return;
    api('POST', { action: 'hello' })
        .then(data => {
            if (!data.lastWeightDate) return;
            const date = new Date(data.lastWeightDate);
            if (lastWeightDate && isoDate(date) <= lastWeightDate) return;
            rememberLastWeight(data.lastWeight, date);
            if (stack.length && stack[stack.length - 1].screen === 'home') render();
        })
        .catch(error => console.error('Регистрация клиента:', error));
}

loadProgress().then(() => {
    hello();
    flushLogs();
    // Сразу открыть нужный экран: адрес кнопки ...fitness-bot-webapp/?open=weight
    // или ссылка t.me/Nina_fitbody_bot/app?startapp=weight
    const start = new URLSearchParams(location.search).get('open') || (inTelegram && tg.initDataUnsafe.start_param);
    home();
    if (start === 'weight') go('weight');
    else if (start && WORKOUTS[start]) go('workout', { id: start });
});
