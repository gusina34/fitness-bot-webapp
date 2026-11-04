#!/usr/bin/env python3
"""Конвейер рилсов: Claude — режиссёр (1 вызов на ролик), всё остальное — код.

  python reels.py prep   video.mp4     # аудио -> Whisper (Groq или локально) -> words.json / words.txt
  python reels.py direct video.mp4     # ОДИН вызов Claude: номера слов -> plan.json
  python reels.py render video.mp4     # нарезка, паузы/«эээ», субтитры, графика -> out/*.mp4
  python reels.py check  video.mp4     # проверки скриптом (ffprobe/silencedetect), без LLM
  python reels.py meta   video.mp4     # названия/описания/хэштеги дешёвой моделью
  python reels.py all    video.mp4     # всё подряд

Ключи: GROQ_API_KEY (бесплатно на console.groq.com), ANTHROPIC_API_KEY.
"""
import json, os, re, subprocess, sys, shutil
from pathlib import Path

import requests

HERE = Path(__file__).resolve().parent
DIRECTOR_MODEL = os.getenv("REELS_DIRECTOR_MODEL", "claude-sonnet-5-5")
CHEAP_MODEL = os.getenv("REELS_CHEAP_MODEL", "claude-haiku-5-5")
W, H = 1080, 1920

# Слова-паразиты, которые режет код без участия модели (только «чистые» звуки).
FILLER_RE = re.compile(r"^(э+|ээ+|эм+|мм+|м+|а+м*|ам+|uh+|um+|hmm+|erm*)$", re.I)
MAX_GAP = 0.35   # паузу длиннее этого между словами ужимаем до PAD*2
PAD = 0.08       # «воздух» вокруг слова, чтобы не съедать звуки


# ---------- утилиты ----------
def run(cmd, **kw):
    return subprocess.run(cmd, check=True, text=True, capture_output=True, **kw)

def workdir(video):
    d = Path(video).with_suffix("").parent / (Path(video).stem + "_reels")
    d.mkdir(exist_ok=True)
    return d

def probe(path):
    out = run(["ffprobe", "-v", "error", "-print_format", "json",
               "-show_format", "-show_streams", str(path)]).stdout
    return json.loads(out)

def clean(word):
    return re.sub(r"[^\w]", "", word.lower())


# ---------- 1. prep: расшифровка с таймкодами слов ----------
def transcribe_groq(audio):
    key = os.environ["GROQ_API_KEY"]
    with open(audio, "rb") as f:
        r = requests.post(
            "https://api.groq.com/openai/v1/audio/transcriptions",
            headers={"Authorization": f"Bearer {key}"},
            files={"file": (audio.name, f, "audio/mpeg")},
            data={"model": "whisper-large-v3-turbo", "response_format": "verbose_json",
                  "timestamp_granularities[]": "word", "language": os.getenv("REELS_LANG", "ru")},
            timeout=600)
    r.raise_for_status()
    return [{"w": x["word"].strip(), "s": x["start"], "e": x["end"]} for x in r.json()["words"]]

def transcribe_local(audio):
    from faster_whisper import WhisperModel  # pip install faster-whisper
    model = WhisperModel(os.getenv("REELS_WHISPER", "small"), compute_type="int8")
    segs, _ = model.transcribe(str(audio), word_timestamps=True, language=os.getenv("REELS_LANG", "ru"))
    return [{"w": w.word.strip(), "s": w.start, "e": w.end} for s in segs for w in s.words]

def prep(video):
    d = workdir(video)
    audio = d / "audio.mp3"  # 16 кГц моно 32 кбит/с: час ≈ 14 МБ, влезает в лимит Groq 25 МБ
    run(["ffmpeg", "-y", "-i", str(video), "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k", str(audio)])
    words = transcribe_groq(audio) if os.getenv("GROQ_API_KEY") else transcribe_local(audio)
    for i, w in enumerate(words):
        w["i"] = i
        w["filler"] = bool(FILLER_RE.match(clean(w["w"])))
    (d / "words.json").write_text(json.dumps(words, ensure_ascii=False))
    # Компактный текст для режиссёра: «номер слово», «/» — пауза > 0.7 с, «~» — паразит.
    parts, prev_end = [], 0.0
    for w in words:
        if w["s"] - prev_end > 0.7:
            parts.append("/")
        parts.append(f'{w["i"]}{"~" if w["filler"] else ""} {w["w"]}')
        prev_end = w["e"]
    (d / "words.txt").write_text(" ".join(parts))
    print(f"prep: {len(words)} слов -> {d/'words.txt'}")


# ---------- 2. direct: ОДИН вызов Claude ----------
def claude(model, system, user, max_tokens):
    r = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={"x-api-key": os.environ["ANTHROPIC_API_KEY"],
                 "anthropic-version": "2023-06-01", "content-type": "application/json"},
        json={"model": model, "max_tokens": max_tokens, "system": system,
              "messages": [{"role": "user", "content": user}]},
        timeout=600)
    r.raise_for_status()
    text = "".join(b.get("text", "") for b in r.json()["content"])
    m = re.search(r"\{.*\}", text, re.S)
    return json.loads(m.group(0))

def direct(video):
    d = workdir(video)
    system = (HERE / "prompts" / "director.md").read_text()
    brief = os.getenv("REELS_BRIEF", "Фитнес-эксперт. Аудитория: женщины 25–45, хотят похудеть и убрать боль в спине.")
    user = f"Бриф: {brief}\nДлительность исходника: {probe(video)['format']['duration']} с\n\nСЛОВА:\n{(d/'words.txt').read_text()}"
    plan = claude(DIRECTOR_MODEL, system, user, 4000)
    (d / "plan.json").write_text(json.dumps(plan, ensure_ascii=False, indent=2))
    print(f"direct: {len(plan.get('reels', []))} рилсов -> {d/'plan.json'}")


# ---------- 3. render: всё делает код + ffmpeg ----------
def keep_segments(words, a, b, cuts):
    """Слова a..b минус вырезанное режиссёром минус паразиты -> склеенные отрезки исходника."""
    cut = set()
    for x, y in cuts:
        cut.update(range(x, y + 1))
    kept = [w for w in words[a:b + 1] if w["i"] not in cut and not w["filler"]]
    segs = []
    for w in kept:
        s, e = max(0.0, w["s"] - PAD), w["e"] + PAD
        if segs and s - segs[-1][1] < MAX_GAP:
            segs[-1][1] = e
        else:
            segs.append([s, e])
    return segs, kept

def to_out_time(segs):
    """Функция: время исходника -> время готового ролика."""
    def f(t):
        acc = 0.0
        for s, e in segs:
            if t <= e:
                return acc + max(0.0, t - s)
            acc += e - s
        return acc
    return f

def ass_time(t):
    h, t = divmod(t, 3600); m, s = divmod(t, 60)
    return f"{int(h)}:{int(m):02d}:{s:05.2f}"

def write_subs(kept, tmap, path):
    """Крупные субтитры по 3 слова — 80% рилсов смотрят без звука."""
    head = ("[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\n\n[V4+ Styles]\n"
            "Format: Name,Fontname,Fontsize,PrimaryColour,OutlineColour,BackColour,Bold,Outline,Shadow,Alignment,MarginV\n"
            "Style: Default,DejaVu Sans,78,&H00FFFFFF,&H00000000,&H80000000,1,6,0,2,520\n\n"
            "[Events]\nFormat: Layer,Start,End,Style,Text\n")
    lines = []
    for k in range(0, len(kept), 3):
        g = kept[k:k + 3]
        s, e = tmap(g[0]["s"]), tmap(g[-1]["e"])
        if k + 3 < len(kept):
            e = max(e, tmap(kept[k + 3]["s"]))  # без мигания между фразами
        text = " ".join(w["w"] for w in g).upper()
        lines.append(f"Dialogue: 0,{ass_time(s)},{ass_time(e)},Default,{text}")
    path.write_text(head + "\n".join(lines))

def render_overlay_png(template, fields, out_png):
    """HTML-шаблон -> прозрачный PNG локально (Playwright), без токенов.
    Для анимированной графики сюда же можно подключить HyperFrames."""
    import html as htmlmod
    page = (HERE / "templates" / f"{template}.html").read_text()
    for k, v in fields.items():
        page = page.replace("{{" + k + "}}", htmlmod.escape(str(v)))
    src = out_png.with_suffix(".html")
    src.write_text(page)
    chrome = os.getenv("CHROME") or next(
        (c for c in ("google-chrome", "chromium", "chromium-browser",
                     "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome") if shutil.which(c) or os.path.exists(c)),
        "google-chrome")
    run([chrome, "--headless", "--no-sandbox", "--disable-gpu", "--hide-scrollbars",
         "--default-background-color=00000000", f"--window-size={W},{H}",
         f"--screenshot={out_png.resolve()}", src.resolve().as_uri()])

def render(video):
    d = workdir(video)
    words = json.loads((d / "words.json").read_text())
    plan = json.loads((d / "plan.json").read_text())
    out = d / "out"; out.mkdir(exist_ok=True)
    for n, reel in enumerate(plan["reels"], 1):
        segs, kept = keep_segments(words, reel["from"], reel["to"], reel.get("cut", []))
        tmap = to_out_time(segs)
        subs = d / f"reel{n}.ass"
        write_subs(kept, tmap, subs)

        inputs, overlays = ["-i", str(video)], []
        for j, ov in enumerate(reel.get("overlays", [])):
            png = d / f"reel{n}_ov{j}.png"
            render_overlay_png(ov["template"], ov, png)
            inputs += ["-i", str(png)]
            t0 = tmap(words[ov["at"]]["s"])
            t1 = tmap(words[ov.get("until", ov["at"])]["e"]) if "until" in ov else t0 + 2.5
            overlays.append((j + 1, t0, t1))

        f = []
        for i, (s, e) in enumerate(segs):
            f.append(f"[0:v]trim={s:.3f}:{e:.3f},setpts=PTS-STARTPTS[v{i}];"
                     f"[0:a]atrim={s:.3f}:{e:.3f},asetpts=PTS-STARTPTS,afade=t=in:d=0.01[a{i}]")
        f.append("".join(f"[v{i}][a{i}]" for i in range(len(segs))) + f"concat=n={len(segs)}:v=1:a=1[cv][ca]")
        f.append(f"[cv]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},setsar=1[base0]")
        last = "base0"
        for k, (idx, t0, t1) in enumerate(overlays):
            f.append(f"[{last}][{idx}:v]overlay=0:0:enable='between(t,{t0:.2f},{t1:.2f})'[base{k+1}]")
            last = f"base{k+1}"
        f.append(f"[{last}]subtitles={subs}[vout]")
        f.append("[ca]loudnorm=I=-14:TP=-1.5:LRA=11[aout]")  # громкость под Instagram/TikTok

        dst = out / f"reel{n}.mp4"
        run(["ffmpeg", "-y", *inputs, "-filter_complex", ";".join(f),
             "-map", "[vout]", "-map", "[aout]", "-c:v", "libx264", "-preset", "medium", "-crf", "20",
             "-pix_fmt", "yuv420p", "-r", "30", "-c:a", "aac", "-b:a", "160k",
             "-movflags", "+faststart", str(dst)])
        reel["file"] = str(dst)
        reel["text"] = " ".join(w["w"] for w in kept)
        print(f"render: {dst}  ({sum(e - s for s, e in segs):.1f} с)")
    (d / "plan.json").write_text(json.dumps(plan, ensure_ascii=False, indent=2))


# ---------- 4. check: проверки скриптом ----------
def check(video):
    d = workdir(video)
    plan = json.loads((d / "plan.json").read_text())
    ok = True
    for reel in plan["reels"]:
        p = probe(reel["file"])
        v = next(s for s in p["streams"] if s["codec_type"] == "video")
        has_a = any(s["codec_type"] == "audio" for s in p["streams"])
        dur = float(p["format"]["duration"])
        sil = run(["ffmpeg", "-i", reel["file"], "-af", "silencedetect=n=-35dB:d=0.8", "-f", "null", "-"]).stderr
        gaps = len(re.findall(r"silence_end", sil))
        problems = []
        if (v["width"], v["height"]) != (W, H): problems.append(f"размер {v['width']}x{v['height']}")
        if not has_a: problems.append("нет звука")
        if not 7 <= dur <= 90: problems.append(f"длительность {dur:.0f} с")
        if gaps: problems.append(f"паузы > 0.8 с: {gaps}")
        ok &= not problems
        print(("OK  " if not problems else "FAIL") + f" {Path(reel['file']).name} {dur:.1f}с " + "; ".join(problems))
    return ok


# ---------- 5. meta: названия и описания дешёвой моделью ----------
def meta(video):
    d = workdir(video)
    plan = json.loads((d / "plan.json").read_text())
    system = ("Ты SMM-редактор рилсов. На каждый рилс верни: caption (до 300 знаков, первая строка — крючок, "
              "в конце призыв: «напиши СПИНА в комментарии — пришлю программу»), 5 хэштегов, cover_text (до 5 слов). "
              'Ответ строго JSON: {"items":[{"n":1,"caption":"","hashtags":[],"cover_text":""}]}')
    user = "\n\n".join(f"#{i} Хук: {r.get('hook','')}\n{r.get('text','')[:1500]}" for i, r in enumerate(plan["reels"], 1))
    res = claude(CHEAP_MODEL, system, user, 2000)
    (d / "meta.json").write_text(json.dumps(res, ensure_ascii=False, indent=2))
    print(f"meta -> {d/'meta.json'}")


if __name__ == "__main__":
    if len(sys.argv) != 3 or sys.argv[1] not in {"prep", "direct", "render", "check", "meta", "all"}:
        sys.exit(__doc__)
    cmd, video = sys.argv[1], sys.argv[2]
    steps = [prep, direct, render, check, meta] if cmd == "all" else [globals()[cmd]]
    for step in steps:
        res = step(video)
        if step is check and res is False and cmd == "all":
            print("check: есть проблемы, но продолжаю к meta")
