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

async function loadProgress() {
    try {
        const saved = JSON.parse(await store.get('progress'));
        if (saved && Array.isArray(saved.history)) progress = saved;
    } catch (e) { /* пусто или повреждено — начинаем с нуля */ }
    lastWeight = parseFloat(await store.get('lastWeight')) || null;
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
    home: () => home()
};

// ---------- Экраны ----------

function statsHtml() {
    return `
        <div class="stats">
            <div class="stat"><div class="stat-value">${progress.total}</div><div class="stat-label">${plural(progress.total, 'тренировка', 'тренировки', 'тренировок')}</div></div>
            <div class="stat"><div class="stat-value">${doneThisWeek()}</div><div class="stat-label">на этой неделе</div></div>
            <div class="stat"><div class="stat-value">${lastWeight ? formatKg(lastWeight) : '—'}</div><div class="stat-label">вес, кг</div></div>
        </div>`;
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
            <button class="link" data-action="list">📋 Список упражнений</button>`;

        ACTIONS.list = () => back();
        setMainButton(isLast ? 'Завершить тренировку ✅' : 'Следующее ▸', () => {
            haptic();
            if (isLast) {
                if (workout.counts) markDone(workout.id);
                go('finish', { id }, true);
            } else {
                go('exercise', { id, index: index + 1 }, true);
            }
        });
    },

    finish({ id }) {
        const workout = WORKOUTS[id];
        const { cooldown } = DATA.extras;
        haptic('success');
        app.innerHTML = `
            <div class="finish">
                <div class="finish-emoji">🎉</div>
                <h1>${workout.counts ? 'Тренировка завершена!' : 'Готово!'}</h1>
                <p class="hint">${workout.counts ? 'Ты молодец! Так держать 🔥' : 'Отличная работа'}</p>
            </div>
            ${workout.counts ? statsHtml() : ''}
            <div class="list">
                ${workout.counts ? rowHtml({ emoji: cooldown.emoji, title: cooldown.title, sub: 'Восстановление после тренировки', go: 'workout', id: cooldown.id }) : ''}
                ${rowHtml({ emoji: '⚖️', title: 'Записать вес', go: 'weight', id: '' })}
                <button class="row" data-action="coach"><span class="row-emoji">💬</span><span class="row-body"><div class="row-title">Рассказать тренеру, как прошло</div></span><span class="row-arrow">›</span></button>
            </div>`;
        setMainButton('На главную', home);
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
        const response = newWeight
            ? await fetch(CONFIG.googleScriptUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'text/plain;charset=utf-8' },
                body: JSON.stringify({ initData: tg.initData, weight: newWeight })
            })
            : await fetch(`${CONFIG.googleScriptUrl}?initData=${encodeURIComponent(tg.initData)}`);
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const data = await response.json();
        if (!Array.isArray(data)) throw new Error(data && data.error);

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

    lastWeight = entries[entries.length - 1].weight;
    store.set('lastWeight', String(lastWeight));

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

    if (entries.length < 2 || typeof Chart === 'undefined') return;
    const theme = (tg && tg.themeParams) || {};
    const color = theme.button_color || '#e0567a';
    const textColor = theme.hint_color || '#8e8e93';
    if (chart) chart.destroy();
    chart = new Chart(document.getElementById('weight-chart'), {
        type: 'line',
        data: {
            labels: entries.map(e => e.date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })),
            datasets: [{
                data: entries.map(e => e.weight),
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
                tooltip: { callbacks: { label: ctx => formatKg(ctx.parsed.y) + ' кг' } }
            },
            scales: {
                x: { ticks: { color: textColor }, grid: { display: false } },
                y: { ticks: { color: textColor }, grid: { color: textColor + '33' } }
            }
        }
    });
}

// ---------- Старт ----------

loadProgress().then(() => {
    // Ссылка вида t.me/Nina_fitbody_bot/app?startapp=weight откроет сразу дневник веса
    const start = inTelegram && tg.initDataUnsafe.start_param;
    home();
    if (start === 'weight') go('weight');
    else if (start && WORKOUTS[start]) go('workout', { id: start });
});
