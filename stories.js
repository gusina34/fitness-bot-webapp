// Тренировка в формате сторис: каждое упражнение — серия сторис, по одной на подход.
// Видео на весь экран, полоски сверху, таймер отдыха заполняет полоску подхода.
// Жесты: тап справа — дальше, тап слева — назад, удержание — пауза, свайп вниз — закрыть.

// phase: 'work' — выполняем подход, 'rest' — отдых после него
const story = { id: null, index: 0, set: 0, phase: 'work', left: 0, total: 0, paused: false, interval: null };

function storyVideo(ex) {
    if (ex.loop) return ex.loop;
    return ex.video && /\.mp4(\?|$)/i.test(ex.video) ? ex.video : null;
}

function storyStart(id, index, set = 0) {
    story.id = id;
    story.index = index;
    story.set = set;
    story.paused = false;
    storyWork();
}

function storyWork() {
    const ex = WORKOUTS[story.id].exercises[story.index];
    story.phase = 'work';
    story.left = story.total = ex.time || 0;
}

function storyRest() {
    const workout = WORKOUTS[story.id];
    story.phase = 'rest';
    story.left = story.total = restFor(workout, workout.exercises[story.index]);
}

Object.assign(SCREENS, {
    stories({ id, index }) {
        const workout = WORKOUTS[id];
        const ex = workout.exercises[index];
        const sets = sessionSets(workout, index);
        const plan = parseSets(ex.sets);
        const total = workout.exercises.length;
        const nextEx = workout.exercises[index + 1];
        const src = storyVideo(ex);
        if (story.id !== id || story.index !== index) storyStart(id, index);
        story.paused = false;
        let recordShown = false;
        if (workout.counts) loadExerciseLog();

        setMainButton(null);
        pageBack.hidden = true;
        if (inTelegram && tg.isVersionAtLeast('7.7')) tg.disableVerticalSwipes();
        keepScreenOn(true);

        app.innerHTML = `
            <div class="stories" id="stories">
                <div class="story-media">
                    ${src
                        ? `<video id="story-video" src="${escapeHtml(src)}" autoplay muted loop playsinline webkit-playsinline preload="auto"></video>`
                        : `<div class="story-fallback"><span>🏋️</span><small>Видео скоро появится</small></div>`}
                </div>
                <div class="story-shade"></div>

                <div class="story-tap story-tap-left" data-story="prev"></div>
                <div class="story-tap story-tap-right" data-story="next"></div>

                <div class="story-top">
                    <div class="story-bars">${sets.map(() => '<div class="story-bar"><div class="story-fill"></div></div>').join('')}</div>
                    <div class="story-head">
                        <div class="story-avatar">${index + 1}</div>
                        <div class="story-title">
                            <b>${escapeHtml(ex.name)}</b>
                            <span>Упражнение ${index + 1} из ${total} · ${escapeHtml(workout.title)}</span>
                        </div>
                        <button class="story-icon" data-story="info" aria-label="Техника">ⓘ</button>
                        <button class="story-icon" data-story="close" aria-label="Закрыть">✕</button>
                    </div>
                </div>

                <div class="story-paused" id="story-paused" hidden>⏸ Пауза</div>
                <div class="story-toast" id="story-toast" hidden></div>
                <div class="story-panel" id="story-panel"></div>

                <div class="story-sheet" id="story-sheet" hidden>
                    <div class="story-sheet-card">
                        <div class="story-sheet-head"><b>${escapeHtml(ex.name)}</b><button class="story-icon dark" data-story="info">✕</button></div>
                        <p class="hint" style="margin:0 0 10px">${escapeHtml(setsSummary(workout, index))}</p>
                        ${ex.description ? `<p class="description">${escapeHtml(ex.description)}</p>` : '<p class="hint">Описание техники скоро появится.</p>'}
                        ${ex.video && ex.video !== src ? `<button class="btn secondary" data-story="video">▶ Полное видео с объяснением</button>` : ''}
                        ${workout.counts && apiEnabled ? `<button class="btn secondary" data-story="progress">📈 Мой прогресс в упражнении</button>` : ''}
                        <button class="btn secondary" data-story="addSet">＋ Добавить подход</button>
                    </div>
                </div>
                ${nextEx && storyVideo(nextEx) ? `<video src="${escapeHtml(storyVideo(nextEx))}" preload="auto" muted hidden></video>` : ''}
            </div>`;

        const root = document.getElementById('stories');
        const video = document.getElementById('story-video');
        const panel = document.getElementById('story-panel');
        const isTimed = !!ex.time;

        // ---------- Отрисовка текущего подхода ----------

        const lastText = () => {
            const last = lastSession(ex.name);
            return last && last.sets.length ? `В прошлый раз: ${setsText(last.sets)}` : '';
        };

        const hints = i => {
            const last = lastSession(ex.name);
            const prev = last && (last.sets[i] || last.sets[last.sets.length - 1]);
            return {
                weight: prev && prev.weight !== '' ? String(prev.weight).replace('.', ',') : '',
                reps: prev && prev.reps !== '' ? String(prev.reps) : plan.reps
            };
        };

        const drawPanel = () => {
            const i = story.set;
            const s = sets[i];
            const h = hints(i);
            if (story.phase === 'rest') {
                const isLastSet = i === sets.length - 1;
                const nextText = !isLastSet
                    ? `Подход ${i + 2} из ${sets.length}${plan.reps ? ` · ${plan.reps} повт.` : ''}`
                    : nextEx ? `Упражнение ${index + 2}: <b>${escapeHtml(nextEx.name)}</b>` : '';
                panel.innerHTML = `
                    <div class="story-rest-label">Отдых</div>
                    <div class="story-countdown" id="story-countdown">${formatTime(story.left)}</div>
                    ${nextText ? `<div class="story-next">Дальше: ${nextText}</div>` : ''}
                    <div class="story-actions">
                        <button class="story-btn ghost" data-story="plus">+15 с</button>
                        <button class="story-btn" data-story="skipRest">Пропустить отдых ›</button>
                    </div>`;
                return;
            }
            panel.innerHTML = `
                <div class="story-set">Подход ${i + 1} из ${sets.length}</div>
                ${isTimed
                    ? `<div class="story-countdown" id="story-countdown">${formatTime(story.left)}</div>`
                    : `<div class="story-target">${plan.reps ? `${escapeHtml(plan.reps)} повторений` : 'Сколько получится 💪'}</div>`}
                ${workout.counts ? `
                    <div class="story-inputs">
                        <label><input data-field="weight" type="text" inputmode="decimal" autocomplete="off" value="${escapeHtml(s.weight)}" placeholder="${escapeHtml(h.weight || '—')}"><span>кг</span></label>
                        <span class="story-x">×</span>
                        <label><input data-field="reps" type="text" inputmode="numeric" autocomplete="off" value="${escapeHtml(s.reps)}" placeholder="${escapeHtml(h.reps || '—')}"><span>повт.</span></label>
                    </div>
                    <div class="story-last">${escapeHtml(lastText())}</div>` : ''}
                ${isTimed ? '' : `<button class="story-done" data-story="done">✓ Подход выполнен</button>`}`;
        };

        const drawBars = () => {
            root.querySelectorAll('.story-fill').forEach((fill, i) => {
                const bar = fill.parentElement;
                bar.classList.toggle('pulse', i === story.set && story.phase === 'work' && !isTimed);
                let width = i < story.set ? 1 : i > story.set ? 0 : 0;
                if (i === story.set) {
                    if (story.phase === 'rest') width = story.total ? 1 - story.left / story.total : 1;
                    else if (isTimed) width = story.total ? 1 - story.left / story.total : 0;
                }
                fill.style.width = `${width * 100}%`;
            });
        };

        const drawTime = () => {
            const countdown = document.getElementById('story-countdown');
            if (countdown) countdown.textContent = formatTime(story.left);
            drawBars();
        };

        const draw = () => {
            drawPanel();
            drawBars();
            document.getElementById('story-paused').hidden = !story.paused;
            if (video) story.paused ? video.pause() : video.play().catch(() => {});
        };

        const toast = text => {
            const el = document.getElementById('story-toast');
            el.textContent = text;
            el.hidden = false;
            clearTimeout(toast.timer);
            toast.timer = setTimeout(() => { el.hidden = true; }, 2500);
        };

        // ---------- Переходы ----------

        const nextExercise = () => {
            logExercise(workout, index);
            if (nextEx) {
                storyStart(id, index + 1);
                go('stories', { id, index: index + 1 }, true);
            } else {
                story.id = null;
                completeWorkout(workout);
            }
        };

        // Подход выполнен: пустые поля берутся из подсказок (прошлый раз / план)
        const completeSet = () => {
            const i = story.set;
            const s = sets[i];
            const h = hints(i);
            if (workout.counts) {
                if (s.weight === '' && h.weight) s.weight = h.weight;
                if (s.reps === '' && h.reps && /^\d+$/.test(h.reps)) s.reps = h.reps;
                const done = sets.slice(0, i + 1)
                    .map(x => ({ weight: toNumber(x.weight), reps: toNumber(x.reps) }))
                    .filter(x => x.weight !== '' || x.reps !== '');
                const beaten = isNewRecord(ex.name, done);
                if (beaten && !recordShown) {
                    recordShown = true;
                    toast(`🏆 Новый рекорд! Было ${bestText(beaten)}`);
                }
            }
            haptic('success');
            beep(990, 200);
            const isLastSet = i === sets.length - 1;
            if (isLastSet && !nextEx) return nextExercise();
            storyRest();
            draw();
        };

        const afterRest = () => {
            beep(990, 300);
            haptic('success');
            if (story.set < sets.length - 1) {
                story.set += 1;
                storyWork();
                draw();
            } else {
                nextExercise();
            }
        };

        const goPrev = () => {
            if (story.phase === 'rest') {
                storyWork();
            } else if (story.set > 0) {
                story.set -= 1;
                storyWork();
            } else if (index > 0) {
                storyStart(id, index - 1);
                go('stories', { id, index: index - 1 }, true);
                return;
            }
            draw();
        };

        const goNext = () => {
            if (story.phase === 'rest') return afterRest();
            if (story.set < sets.length - 1) {
                story.set += 1;
                storyWork();
                draw();
            } else {
                nextExercise();
            }
        };

        // ---------- Таймер ----------

        const tick = () => {
            if (story.paused || story.total === 0) return;
            story.left -= 1;
            if (story.left > 0 && story.left <= 3) { beep(660, 80); haptic(); }
            if (story.left > 0) return drawTime();
            if (story.phase === 'rest') afterRest();
            else completeSet();
        };
        clearInterval(story.interval);
        story.interval = setInterval(tick, 1000);

        screenCleanup = () => {
            clearInterval(story.interval);
            story.interval = null;
            keepScreenOn(false);
            if (inTelegram && tg.isVersionAtLeast('7.7')) tg.enableVerticalSwipes();
        };

        // ---------- Управление ----------

        const actions = {
            done: completeSet,
            next: goNext,
            prev: goPrev,
            skipRest: afterRest,
            plus: () => { story.left += 15; story.total += 15; drawTime(); },
            close: () => back(),
            info: () => {
                const sheet = document.getElementById('story-sheet');
                sheet.hidden = !sheet.hidden;
                story.paused = !sheet.hidden;
                draw();
            },
            video: () => openLink(ex.video),
            progress: () => go('exerciseProgress', { id: ex.name }),
            addSet: () => {
                sets.push({ weight: '', reps: '' });
                render();
            }
        };

        // Удержание пальца на видео — пауза, как в сторис
        let holdTimer = null;
        let held = false;
        let startY = null;
        root.addEventListener('pointerdown', event => {
            startY = event.clientY;
            if (!event.target.closest('.story-tap')) return;
            held = false;
            holdTimer = setTimeout(() => {
                held = true;
                story.paused = true;
                draw();
            }, 300);
        });
        root.addEventListener('pointerup', event => {
            clearTimeout(holdTimer);
            // Свайп вниз — закрыть
            if (startY !== null && event.clientY - startY > 120) {
                startY = null;
                back();
                return;
            }
            startY = null;
            if (held) {
                story.paused = false;
                draw();
            }
        });
        root.addEventListener('click', event => {
            const el = event.target.closest('[data-story]');
            if (!el) return;
            if (held && el.classList.contains('story-tap')) { held = false; return; }
            event.stopPropagation();
            haptic();
            unlockAudio();
            actions[el.dataset.story]();
        });
        root.addEventListener('input', event => {
            const field = event.target.dataset.field;
            if (field) sets[story.set][field] = event.target.value;
        });

        // История прошлых тренировок может догрузиться позже — обновим подсказки
        if (workout.counts && logRequest) {
            logRequest.then(() => {
                const current = stack[stack.length - 1];
                if (current.screen === 'stories' && current.params.id === id && current.params.index === index && story.phase === 'work') drawPanel();
            });
        }

        draw();
    }
});
