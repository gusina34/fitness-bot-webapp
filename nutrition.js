// Раздел «Питание»: норма КБЖУ, рацион на день из рецептов, трекер дня и рецепты.
// Использует общие функции из app.js; рецепты и продукты — в data/recipes.js.

const FOOD = window.NUTRITION;

// ---------- КБЖУ рецептов ----------

const recipeById = Object.fromEntries(FOOD.recipes.map(r => [r.id, r]));
const totalsCache = {};

// КБЖУ одной порции: { kcal, p, f, c }
function recipeTotals(recipe) {
    if (totalsCache[recipe.id]) return totalsCache[recipe.id];
    const sum = { kcal: 0, p: 0, f: 0, c: 0 };
    recipe.ingredients.forEach(item => {
        const product = item.p && FOOD.products[item.p];
        if (!product) return;
        const k = item.g / 100 / recipe.servings;
        sum.kcal += product[0] * k;
        sum.p += product[1] * k;
        sum.f += product[2] * k;
        sum.c += product[3] * k;
    });
    return (totalsCache[recipe.id] = sum);
}

function scaleTotals(t, factor) {
    return { kcal: t.kcal * factor, p: t.p * factor, f: t.f * factor, c: t.c * factor };
}

function round(value, step = 1) {
    return Math.round(value / step) * step;
}

function portionText(factor) {
    const names = { 0.5: '½', 0.75: '¾', 1: '1', 1.25: '1¼', 1.5: '1½', 2: '2' };
    const n = names[factor] || formatKg(factor);
    return `${n} ${factor > 1 ? 'порции' : factor === 1 ? 'порция' : 'порции'}`;
}

function macrosLine(t) {
    return `${round(t.kcal)} ккал · Б ${round(t.p)} · Ж ${round(t.f)} · У ${round(t.c)}`;
}

// ---------- Профиль и норма ----------

const ACTIVITY = [
    { value: 1.2, title: 'Почти без движения', sub: 'Сидячая работа, тренировок нет' },
    { value: 1.375, title: 'Немного активности', sub: 'Тренировки 1–3 раза в неделю' },
    { value: 1.55, title: 'Активно', sub: 'Тренировки 3–5 раз в неделю' },
    { value: 1.725, title: 'Очень активно', sub: 'Тренировки 6–7 раз в неделю или физическая работа' }
];

const GOALS = [
    { value: 'lose', title: 'Снизить вес', sub: 'Мягкий дефицит −15%' },
    { value: 'keep', title: 'Держать форму', sub: 'Без дефицита' },
    { value: 'gain', title: 'Набрать мышцы', sub: 'Небольшой профицит +10%' }
];

const MIN_KCAL = 1200;
let profile = null;
let profileLoaded = false;

async function loadProfile() {
    if (profileLoaded) return profile;
    try { profile = JSON.parse(await store.get('profile')); } catch (e) { profile = null; }
    profileLoaded = true;
    return profile;
}

// Формула Миффлина — Сан Жеора для женщин. Вес берётся из дневника, если он есть.
function calcNorm(pr) {
    if (!pr) return null;
    const weight = lastWeight || pr.weight;
    const heightM = pr.height / 100;
    const bmi = weight / (heightM * heightM);
    const goal = pr.goal === 'lose' && bmi < 18.5 ? 'keep' : pr.goal;

    const bmr = 10 * weight + 6.25 * pr.height - 5 * pr.age - 161;
    const tdee = bmr * pr.activity;
    const kcal = Math.max(MIN_KCAL, round(tdee * (goal === 'lose' ? 0.85 : goal === 'gain' ? 1.1 : 1), 10));

    // При лишнем весе белок и жиры считаем от веса, соответствующего ИМТ 25
    const refWeight = bmi > 27 ? 25 * heightM * heightM : weight;
    const p = round(refWeight * (goal === 'keep' ? 1.6 : 1.8));
    let f = round(refWeight * 0.9);
    let c = round((kcal - p * 4 - f * 9) / 4);
    if (c < 80) {
        f = round(refWeight * 0.7);
        c = Math.max(50, round((kcal - p * 4 - f * 9) / 4));
    }
    const water = Math.min(3500, round(weight * 30, 100));
    return { kcal, p, f, c, water, weight, tdee: round(tdee, 10), goalAdjusted: goal !== pr.goal, bmi };
}

// ---------- Рацион на день ----------

const SLOTS = [
    { key: 'breakfast', title: 'Завтрак', emoji: '🌅', cats: ['breakfast'], share: 0.25 },
    { key: 'lunch', title: 'Обед', emoji: '☀️', cats: ['main'], share: 0.35 },
    { key: 'dinner', title: 'Ужин', emoji: '🌙', cats: ['main'], share: 0.27 },
    { key: 'snack', title: 'Перекус', emoji: '🍏', cats: ['snack', 'sweet'], share: 0.13 }
];
const SNACK2 = { key: 'snack2', title: 'Второй перекус', emoji: '🥤', cats: ['snack', 'sweet'] };
const plansCache = {};

// При большой норме добавляется второй перекус, иначе порции получились бы огромными
function slotsFor(norm) {
    if (norm.kcal < 1900) return SLOTS;
    const shares = [0.22, 0.32, 0.26, 0.1, 0.1];
    return SLOTS.concat(SNACK2).map((slot, i) => ({ ...slot, share: shares[i] }));
}

// Перебираем сочетания блюд и размеры порций, оцениваем близость к норме
function buildPlans(norm) {
    const key = `${norm.kcal}-${norm.p}-${norm.f}-${norm.c}`;
    if (plansCache[key]) return plansCache[key];

    const slots = slotsFor(norm);
    const choices = slots.map(slot => FOOD.recipes.filter(r => slot.cats.includes(r.category)));
    const factorsList = slots.length > 4 ? [1, 1.25, 1.5] : [0.75, 1, 1.25, 1.5];
    // Все сочетания размеров порций
    let factorSets = [[]];
    slots.forEach(() => { factorSets = factorSets.flatMap(set => factorsList.map(f => set.concat(f))); });
    const results = [];

    const evaluate = (recipes) => {
        const base = recipes.map(recipeTotals);
        let best = null;
        factorSets.forEach(factors => {
            const t = { kcal: 0, p: 0, f: 0, c: 0 };
            const kcals = base.map((b, i) => b.kcal * factors[i]);
            base.forEach((b, i) => { t.kcal += kcals[i]; t.p += b.p * factors[i]; t.f += b.f * factors[i]; t.c += b.c * factors[i]; });
            let score = 3 * Math.abs(t.kcal - norm.kcal) / norm.kcal
                + 2 * Math.max(0, norm.p - t.p) / norm.p
                + 0.3 * Math.max(0, t.p - norm.p * 1.3) / norm.p
                + Math.abs(t.c - norm.c) / norm.c
                + 0.7 * Math.abs(t.f - norm.f) / norm.f;
            // Разумное распределение калорий по приёмам пищи
            slots.forEach((slot, i) => { score += 0.5 * Math.abs(kcals[i] / t.kcal - slot.share); });
            if (!best || score < best.score) best = { score, factors, totals: t };
        });
        return best;
    };

    // Перебор блюд: одно блюдо не повторяется в течение дня
    const walk = (i, picked) => {
        if (i === slots.length) {
            results.push({ slots, recipes: picked, ...evaluate(picked) });
            return;
        }
        choices[i].forEach(r => { if (!picked.includes(r)) walk(i + 1, picked.concat(r)); });
    };
    walk(0, []);

    results.sort((a, b) => a.score - b.score);
    // Берём лучшие варианты, отличающиеся хотя бы двумя блюдами (перестановка обеда и ужина — не новый вариант)
    const options = [];
    for (const r of results) {
        if (options.length >= 10) break;
        if (options.every(o => r.recipes.filter(rec => !o.recipes.includes(rec)).length >= 2)) options.push(r);
    }
    return (plansCache[key] = options);
}

function dayHash(date) {
    return date.split('').reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 1000003, 7);
}

async function planFor(date, norm) {
    const options = buildPlans(norm);
    const shift = parseInt(await store.get('planShift_' + date), 10) || 0;
    return options[(dayHash(date) + shift) % options.length];
}

// ---------- Трекер дня ----------

const dayCache = {};

function todayIso() {
    return isoDate(new Date());
}

async function loadDay(date) {
    if (dayCache[date]) return dayCache[date];
    let day = null;
    try { day = JSON.parse(await store.get('day_' + date)); } catch (e) { /* пусто */ }
    return (dayCache[date] = Object.assign({ date, water: 0, protein: 0, carbs: 0, burned: 0, eaten: {} }, day || {}));
}

let syncTimer = null;
function saveDay(day) {
    store.set('day_' + day.date, JSON.stringify(day));
    if (!apiEnabled) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
        api('POST', { action: 'day', day: { date: day.date, water: day.water, protein: round(day.protein), carbs: round(day.carbs), burned: day.burned } })
            .catch(error => console.error('Питание за день не сохранилось в таблицу:', error));
    }, 1500);
}

function bar(value, goal) {
    const pct = goal ? Math.min(100, (value / goal) * 100) : 0;
    return `<div class="progress food-progress"><div style="width:${pct}%"></div></div>`;
}

function liters(ml) {
    return (ml / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 2 });
}

// ---------- Экраны ----------

Object.assign(SCREENS, {
    nutrition() {
        app.innerHTML = '<div class="message">Загрузка…</div>';
        loadProfile().then(async pr => {
            if (stack[stack.length - 1].screen !== 'nutrition') return;
            const norm = pr && !pr.pregnant ? calcNorm(pr) : null;
            const day = await loadDay(todayIso());
            app.innerHTML = `
                <h1>🥗 Питание</h1>
                ${pr && pr.pregnant ? `
                    <div class="card">
                        <div class="row-title">🤍 Норму подберёт тренер</div>
                        <p class="hint" style="margin:6px 0 0">Во время беременности и кормления расчёт делается индивидуально.</p>
                        <button class="link" data-action="coach">Написать тренеру</button> · <button class="link" data-go="profile">Изменить данные</button>
                    </div>` : norm ? `
                    <div class="card norm-card">
                        <div class="row-title">Твоя норма на день</div>
                        <div class="norm-kcal">${norm.kcal} ккал</div>
                        <div class="norm-macros">
                            <span><b>${norm.p}</b> г белка</span><span><b>${norm.f}</b> г жиров</span><span><b>${norm.c}</b> г углеводов</span>
                        </div>
                        <div class="hint" style="margin:8px 0 0">💧 Вода: ${liters(norm.water)} л в день · рассчитано для веса ${formatKg(norm.weight)} кг</div>
                        <button class="link" data-go="profile">Изменить данные</button>
                    </div>` : `
                    <button class="banner" data-go="profile">
                        <span class="row-emoji">🧮</span>
                        <span class="row-body"><div class="row-title">Рассчитать мою норму КБЖУ</div><div class="banner-sub">1 минута — и рацион на день соберётся сам</div></span>
                        <span>›</span>
                    </button>`}
                <h2>Сегодня</h2>
                <div class="list">
                    ${rowHtml({ emoji: '📅', title: 'Мой день', sub: norm ? `💧 ${liters(day.water)} из ${liters(norm.water)} л · белок ${round(day.protein)} из ${norm.p} г` : 'Вода, белок, углеводы, потраченные калории', go: 'day', id: '' })}
                    ${norm ? rowHtml({ emoji: '🍽', title: 'Рацион на сегодня', sub: 'Собран из рецептов под твою норму', go: 'plan', id: '' }) : ''}
                </div>
                <h2>Рецепты</h2>
                <div class="list">
                    ${FOOD.categories.map(cat => {
                        const count = FOOD.recipes.filter(r => r.category === cat.id).length;
                        return rowHtml({ emoji: cat.emoji, title: cat.title, sub: `${count} ${plural(count, 'рецепт', 'рецепта', 'рецептов')}`, go: 'recipes', id: cat.id });
                    }).join('')}
                </div>`;
        });
    },

    profile() {
        loadProfile().then(pr => {
            const p = pr || {};
            const weight = lastWeight || p.weight || '';
            app.innerHTML = `
                <h1>🧮 Расчёт нормы</h1>
                <p class="hint">Расчёт для женщин по формуле Миффлина — Сан Жеора</p>
                <form id="profile-form" class="form">
                    <label>Возраст<input name="age" type="text" inputmode="numeric" value="${escapeHtml(p.age || '')}" placeholder="лет"></label>
                    <label>Рост<input name="height" type="text" inputmode="numeric" value="${escapeHtml(p.height || '')}" placeholder="см"></label>
                    <label>Вес<input name="weight" type="text" inputmode="decimal" value="${escapeHtml(weight ? String(weight).replace('.', ',') : '')}" placeholder="кг"></label>
                    ${lastWeight ? '<p class="hint" style="margin:-4px 0 8px">Вес берётся из дневника и обновится сам при новом замере</p>' : ''}

                    <h2>Активность</h2>
                    <div class="list">
                        ${ACTIVITY.map(a => `
                            <label class="row choice">
                                <input type="radio" name="activity" value="${a.value}" ${p.activity === a.value ? 'checked' : ''}>
                                <span class="row-body"><div class="row-title">${a.title}</div><div class="row-sub">${a.sub}</div></span>
                            </label>`).join('')}
                    </div>

                    <h2>Цель</h2>
                    <div class="list">
                        ${GOALS.map(g => `
                            <label class="row choice">
                                <input type="radio" name="goal" value="${g.value}" ${p.goal === g.value ? 'checked' : ''}>
                                <span class="row-body"><div class="row-title">${g.title}</div><div class="row-sub">${g.sub}</div></span>
                            </label>`).join('')}
                    </div>

                    <label class="row choice" style="margin-top:16px">
                        <input type="checkbox" name="pregnant" ${p.pregnant ? 'checked' : ''}>
                        <span class="row-body"><div class="row-title">Беременна или кормлю грудью</div></span>
                    </label>
                </form>`;

            setMainButton('Рассчитать', () => {
                const form = new FormData(document.getElementById('profile-form'));
                const num = name => parseFloat(String(form.get(name) || '').replace(',', '.'));
                const data = {
                    age: num('age'), height: num('height'), weight: num('weight'),
                    activity: parseFloat(form.get('activity')), goal: form.get('goal'), pregnant: form.get('pregnant') === 'on'
                };
                const error =
                    !(data.age >= 14 && data.age <= 90) ? 'Укажи возраст от 14 до 90 лет' :
                    !(data.height >= 130 && data.height <= 220) ? 'Укажи рост в сантиметрах, например 165' :
                    !(data.weight >= 35 && data.weight <= 250) ? 'Укажи вес в килограммах, например 62,5' :
                    !data.activity ? 'Выбери уровень активности' :
                    !data.goal ? 'Выбери цель' : '';
                if (error) {
                    inTelegram ? tg.showAlert(error) : alert(error);
                    return;
                }
                profile = data;
                store.set('profile', JSON.stringify(data));
                haptic('success');
                go(data.pregnant ? 'pregnant' : 'nutrition', {}, true);
            });
        });
    },

    pregnant() {
        app.innerHTML = `
            <div class="finish">
                <div class="finish-emoji">🤍</div>
                <h1>Подберём питание вместе</h1>
                <p class="hint">Во время беременности и кормления стандартные формулы не подходят. Напиши тренеру — норму рассчитаем индивидуально.</p>
            </div>
            <button class="btn" data-action="coach">Написать тренеру</button>
            <button class="btn secondary" data-go="profile">Изменить данные</button>`;
    },

    plan() {
        app.innerHTML = '<div class="message">Собираю рацион…</div>';
        loadProfile().then(async pr => {
            const norm = calcNorm(pr);
            if (!norm || pr.pregnant) { go('profile', {}, true); return; }
            const date = todayIso();
            const plan = await planFor(date, norm);
            const day = await loadDay(date);
            if (stack[stack.length - 1].screen !== 'plan') return;

            const t = plan.totals;
            app.innerHTML = `
                <h1>🍽 Рацион на сегодня</h1>
                <p class="hint">Собран под твою норму: ${norm.kcal} ккал · Б ${norm.p} · Ж ${norm.f} · У ${norm.c}</p>
                <div class="card plan-total">
                    <div class="plan-total-kcal">${round(t.kcal)} ккал</div>
                    <div class="norm-macros"><span>Б <b>${round(t.p)}</b></span><span>Ж <b>${round(t.f)}</b></span><span>У <b>${round(t.c)}</b></span></div>
                </div>
                <div class="list" style="margin-top:12px">
                    ${plan.slots.map((slot, i) => {
                        const recipe = plan.recipes[i];
                        const factor = plan.factors[i];
                        const mt = scaleTotals(recipeTotals(recipe), factor);
                        const eaten = !!day.eaten[`${slot.key}:${recipe.id}`];
                        return `
                            <div class="meal">
                                <button class="row meal-main" data-go="recipe" data-id="${recipe.id}" data-index="${factor}">
                                    <span class="row-emoji">${recipe.emoji}</span>
                                    <span class="row-body">
                                        <div class="row-sub">${slot.emoji} ${slot.title} · ${portionText(factor)}</div>
                                        <div class="row-title">${escapeHtml(recipe.title)}</div>
                                        <div class="row-sub">${macrosLine(mt)}</div>
                                    </span>
                                    <span class="row-arrow">›</span>
                                </button>
                                <button class="eat-btn ${eaten ? 'done' : ''}" data-action="eatSlot" data-id="${slot.key}:${recipe.id}" data-index="${i}">${eaten ? '✓ Съела' : 'Съела'}</button>
                            </div>`;
                    }).join('')}
                </div>
                <p class="hint" style="margin-top:12px">Нажми «Съела» — белок и углеводы добавятся в «Мой день».</p>`;

            ACTIONS.eatSlot = el => {
                const slot = el.dataset.id;
                const i = Number(el.dataset.index);
                const mt = scaleTotals(recipeTotals(plan.recipes[i]), plan.factors[i]);
                if (day.eaten[slot]) {
                    day.protein = Math.max(0, day.protein - day.eaten[slot].p);
                    day.carbs = Math.max(0, day.carbs - day.eaten[slot].c);
                    delete day.eaten[slot];
                } else {
                    day.eaten[slot] = { p: round(mt.p), c: round(mt.c) };
                    day.protein += round(mt.p);
                    day.carbs += round(mt.c);
                    haptic('success');
                }
                saveDay(day);
                el.classList.toggle('done', !!day.eaten[slot]);
                el.textContent = day.eaten[slot] ? '✓ Съела' : 'Съела';
            };

            setMainButton('🔄 Другой вариант', async () => {
                const key = 'planShift_' + date;
                const shift = (parseInt(await store.get(key), 10) || 0) + 1;
                await store.set(key, String(shift));
                render();
            });
        });
    },

    day() {
        app.innerHTML = '<div class="message">Загрузка…</div>';
        Promise.all([loadProfile(), loadDay(todayIso())]).then(([pr, day]) => {
            if (stack[stack.length - 1].screen !== 'day') return;
            const norm = calcNorm(pr && !pr.pregnant ? pr : null);
            const waterGoal = norm ? norm.water : 2000;

            const draw = () => {
                app.innerHTML = `
                    <h1>📅 Мой день</h1>
                    <p class="hint">${humanDate(day.date)}${norm ? '' : ' · <button class="link inline-link" data-go="profile">рассчитай норму</button>, чтобы видеть цели'}</p>

                    <div class="card tracker">
                        <div class="tracker-head"><span>💧 Вода</span><b>${liters(day.water)} / ${liters(waterGoal)} л</b></div>
                        ${bar(day.water, waterGoal)}
                        <div class="glasses">${Array.from({ length: Math.ceil(waterGoal / 250) }, (_, i) =>
                            `<span class="glass ${day.water >= (i + 1) * 250 ? 'full' : ''}">🥛</span>`).join('')}</div>
                        <div class="tracker-buttons">
                            <button class="btn secondary" data-action="water" data-id="-250">− стакан</button>
                            <button class="btn" data-action="water" data-id="250">+ стакан 250 мл</button>
                        </div>
                    </div>

                    ${trackerCard('protein', '🥩 Белок', day.protein, norm && norm.p, 'г')}
                    ${trackerCard('carbs', '🍚 Углеводы', day.carbs, norm && norm.c, 'г')}

                    <div class="card tracker">
                        <div class="tracker-head"><span>🔥 Потрачено за день</span><b>${day.burned ? day.burned + ' ккал' : '—'}</b></div>
                        <p class="hint" style="margin:6px 0 10px">Активные калории из часов или фитнес-браслета</p>
                        <form class="weight-form" data-form="burned">
                            <input type="text" inputmode="numeric" placeholder="ккал" value="${day.burned || ''}" autocomplete="off">
                            <button class="btn" type="submit">Сохранить</button>
                        </form>
                    </div>

                    ${norm ? rowHtml({ emoji: '🍽', title: 'Рацион на сегодня', sub: 'Отмечай съеденное — белок и углеводы посчитаются сами', go: 'plan', id: '' }) : ''}
                    <h2>Последние 7 дней</h2>
                    <div class="card" id="week"><div class="message">Загрузка…</div></div>`;
                drawWeek(norm);
            };

            ACTIONS.water = el => {
                day.water = Math.max(0, day.water + Number(el.dataset.id));
                if (Number(el.dataset.id) > 0) haptic();
                saveDay(day);
                draw();
            };

            draw();
            // Ввод белка, углеводов и потраченных калорий
            app.onsubmit = event => {
                const form = event.target.closest('[data-form]');
                if (!form) return;
                event.preventDefault();
                const value = parseFloat(form.querySelector('input').value.replace(',', '.'));
                if (isNaN(value)) return;
                const field = form.dataset.form;
                if (field === 'burned') day.burned = Math.max(0, Math.min(5000, round(value)));
                else day[field] = Math.max(0, day[field] + value);
                haptic('success');
                saveDay(day);
                draw();
            };
        });
    },

    recipes({ id }) {
        const cat = FOOD.categories.find(c => c.id === id);
        const recipes = FOOD.recipes.filter(r => r.category === id);
        app.innerHTML = `
            <h1>${cat.emoji} ${escapeHtml(cat.title)}</h1>
            <p class="hint">КБЖУ на 1 порцию</p>
            <div class="recipe-grid">
                ${recipes.map(r => {
                    const t = recipeTotals(r);
                    return `
                        <button class="recipe-card" data-go="recipe" data-id="${r.id}">
                            <span class="recipe-emoji">${r.emoji}</span>
                            <span class="recipe-title">${escapeHtml(r.title)}</span>
                            <span class="recipe-meta">⏱ ${r.time} мин</span>
                            <span class="recipe-kcal">${round(t.kcal)} ккал</span>
                            <span class="recipe-meta">Б ${round(t.p)} · Ж ${round(t.f)} · У ${round(t.c)}</span>
                        </button>`;
                }).join('')}
            </div>`;
    },

    // index — размер порции из рациона (0.75 / 1 / 1.25 / 1.5)
    recipe({ id, index }) {
        const recipe = recipeById[id];
        const factor = index || 1;
        let portions = recipe.servings;
        const per = recipeTotals(recipe);

        const draw = () => {
            const k = portions / recipe.servings;
            const fmtAmount = item => {
                if (!item.p) return '';
                if (item.pcs) return `${formatKg(item.pcs * k)} шт`;
                const amount = item.g * k;
                return `${amount >= 20 ? round(amount, 5) : formatKg(round(amount, 0.5))} ${item.unit || 'г'}`;
            };
            app.innerHTML = `
                <div class="recipe-hero">${recipe.emoji}</div>
                <h1>${escapeHtml(recipe.title)}</h1>
                <div class="tags">${['⏱ ' + recipe.time + ' мин'].concat(recipe.tags || []).map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>

                <div class="card macros-card">
                    <div class="macros-title">На 1 порцию</div>
                    <div class="macros">
                        <div><b>${round(per.kcal)}</b><span>ккал</span></div>
                        <div><b>${round(per.p)}</b><span>белки</span></div>
                        <div><b>${round(per.f)}</b><span>жиры</span></div>
                        <div><b>${round(per.c)}</b><span>углеводы</span></div>
                    </div>
                    ${factor !== 1 ? `<div class="hint" style="margin:8px 0 0">В твоём рационе ${portionText(factor)}: ${macrosLine(scaleTotals(per, factor))}</div>` : ''}
                </div>

                <div class="section-head">
                    <h2>Ингредиенты</h2>
                    <div class="stepper">
                        <button data-action="portions" data-id="-1">−</button>
                        <span>${portions} ${plural(portions, 'порция', 'порции', 'порций')}</span>
                        <button data-action="portions" data-id="1">+</button>
                    </div>
                </div>
                <div class="card ingredients">
                    ${recipe.ingredients.map(item => `
                        <div class="history-row">
                            <span>${escapeHtml(item.p || item.text)}${item.label && k === 1 ? ` <span class="ing-note">(${escapeHtml(item.label)})</span>` : ''}</span>
                            <b>${fmtAmount(item)}</b>
                        </div>`).join('')}
                </div>

                <h2>Приготовление</h2>
                <ol class="steps">${recipe.steps.map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ol>
                ${recipe.tip ? `<div class="card tip">💡 ${escapeHtml(recipe.tip)}</div>` : ''}
                <p class="hint" style="margin-top:16px">КБЖУ рассчитано по справочным данным и может отличаться от этикетки на 5–10%.</p>`;
        };

        ACTIONS.portions = el => {
            portions = Math.max(1, Math.min(12, portions + Number(el.dataset.id)));
            draw();
        };

        draw();
        setMainButton(`Съела ${factor !== 1 ? portionText(factor) : 'порцию'} ✓`, async () => {
            const t = scaleTotals(per, factor);
            const day = await loadDay(todayIso());
            day.protein += round(t.p);
            day.carbs += round(t.c);
            saveDay(day);
            haptic('success');
            const text = `Добавлено в «Мой день»: белок ${round(t.p)} г, углеводы ${round(t.c)} г`;
            inTelegram ? tg.showAlert(text) : alert(text);
        });
    }
});

function trackerCard(field, title, value, goal, unit) {
    return `
        <div class="card tracker">
            <div class="tracker-head"><span>${title}</span><b>${round(value)}${goal ? ' / ' + goal : ''} ${unit}</b></div>
            ${goal ? bar(value, goal) : ''}
            <form class="weight-form" data-form="${field}">
                <input type="text" inputmode="decimal" placeholder="+ ${unit}" autocomplete="off">
                <button class="btn" type="submit">Добавить</button>
            </form>
            <p class="hint" style="margin:6px 0 0">Ошиблась? Введи число с минусом, например −20</p>
        </div>`;
}

async function drawWeek(norm) {
    const days = [];
    for (let i = 0; i < 7; i++) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        days.push(await loadDay(isoDate(d)));
    }
    const el = document.getElementById('week');
    if (!el) return;
    el.innerHTML = days.map(d => {
        const ok = norm && d.water >= norm.water && d.protein >= norm.p * 0.9;
        return `
            <div class="history-row week-row">
                <span>${humanDate(d.date)}${ok ? ' ✅' : ''}</span>
                <span class="history-sets">💧 ${liters(d.water)} л · Б ${round(d.protein)} · У ${round(d.carbs)} · 🔥 ${d.burned || 0}</span>
            </div>`;
    }).join('');
}
