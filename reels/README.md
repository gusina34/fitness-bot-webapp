# Рилсы: Claude — режиссёр, а не монтажёр

Один вызов Claude на ролик. Всё остальное делают код, ffmpeg и Chrome, токены на это не тратятся.

```
видео ─► prep ─► words.txt ("0 Привет 1 всем 2~ эээ / 3 сегодня…")
              │   Whisper: Groq (бесплатно) или локально через faster-whisper
              ▼
         direct ─► plan.json   ← ЕДИНСТВЕННЫЙ вызов сильной модели
              │   (какие куски взять, что вырезать, какую графику и когда показать)
              ▼
         render ─► out/reelN.mp4
              │   код: «эээ»/паузы, ffmpeg: склейка + 9:16 + громкость −14 LUFS,
              │   субтитры ASS, HTML-шаблоны → PNG через headless Chrome
              ▼
         check  ─► размер, звук, длительность, остаточные паузы (без LLM)
         meta   ─► подписи, хэштеги, текст обложки (дешёвая модель)
```

## Установка

```bash
pip install -r requirements.txt          # нужны ещё ffmpeg и Chrome/Chromium
export GROQ_API_KEY=...                  # console.groq.com, бесплатно
export ANTHROPIC_API_KEY=...
export REELS_BRIEF="Тренер по фитнесу. ЦА: женщины 25–45, похудение и спина. Продукт: марафон в боте."
```

## Запуск

```bash
python reels.py all  my_video.mp4        # или по шагам: prep / direct / render / check / meta
```

Результат появится в `my_video_reels/out/`, подписи к постам — в `my_video_reels/meta.json`.
Если что-то не нравится, правьте `plan.json` руками (там номера слов) и запускайте `render` снова: токены не тратятся.

## Настройка

| Что | Где |
|---|---|
| Стиль плашек | `templates/*.html` (обычный HTML/CSS, поле `{{text}}`) |
| Правила режиссёра | `prompts/director.md` |
| Какие слова считать «эээ» | `FILLER_RE` в `reels.py` |
| Насколько жёстко резать паузы | `MAX_GAP`, `PAD` |
| Модели | `REELS_DIRECTOR_MODEL`, `REELS_CHEAP_MODEL` |
| Язык / локальный Whisper | `REELS_LANG=ru`, `REELS_WHISPER=small` |

Сколько это стоит: на часовое видео режиссёру уходит примерно 40–60 тыс. токенов (≈9 тыс. слов) на входе (номера и слова) и около 2 тыс. на выходе. Монтаж и рендер бесплатны.
