#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11,<3.13"
# dependencies = ["funasr", "modelscope", "torch", "torchaudio"]
# ///
"""把 Space 录音转写成带发言人的文字稿。

扩展或 tools/download.mjs 下载时会在 m4a 旁边放一份 .speakers.json（谁在什么时间说话）。
本脚本先转写，再按时间把每个字归给当时音量最大的那个人，最后按术语表纠正专有名词。

    uv run tools/transcribe.py 录音.m4a
    uv run tools/transcribe.py 录音.m4a --duration 600
    uv run --with mlx-whisper tools/transcribe.py 录音.m4a --engine whisper

默认引擎是 FunASR 的中文 Paraformer：标点、断句和中文用词明显好于 Whisper，
两小时录音几分钟就能转完，模型缓存在 ~/AI-Services/models/modelscope。
发言人姓名、账号、标题里的英文词和术语表会作为热词。英文专有名词主要靠术语表替换来纠正。

术语表默认读 tools/glossary.txt，录音旁边的「<同名>.glossary.txt」会合并进来。
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_GLOSSARY = SCRIPT_DIR / "glossary.txt"
MODELSCOPE_CACHE = Path.home() / "AI-Services/models/modelscope"
FUNASR_MODEL = "iic/speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch"
LOCAL_TURBO = Path.home() / "AI-Services/models/whisper-large-v3-turbo"
WHISPER_MODEL = "mlx-community/whisper-large-v3-turbo"
MERGE_GAP = 1.2
# 片头音乐、杂音会被识别成零星的字：间隔超过 RUN_GAP 就断开，每秒不足 MIN_RATE 个字的一串丢掉。
RUN_GAP = 1.5
MIN_RATE = 2.0
UNIT = re.compile(r"[A-Za-z0-9']+|[\u3400-\u9fff\uf900-\ufaff]")
ASCII_WORD = re.compile(r"[A-Za-z0-9][A-Za-z0-9'.+-]*")


def clock(seconds):
    total = max(0, int(round(seconds)))
    hours, rest = divmod(total, 3600)
    minutes, secs = divmod(rest, 60)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}"


def load_speakers(path):
    with path.open(encoding="utf-8") as handle:
        document = json.load(handle)
    samples = document.get("raw", {}).get("samples") or []
    samples.sort(key=lambda item: item[0])
    document.setdefault("raw", {})["samples"] = samples
    return document


def clip_document(document, duration):
    if not duration:
        return document
    document = json.loads(json.dumps(document))
    turns = []
    for turn in document.get("turns") or []:
        if turn["start"] >= duration:
            continue
        turn["end"] = min(turn["end"], duration)
        if turn["end"] > turn["start"]:
            turns.append(turn)
    document["turns"] = turns
    samples = [item for item in document.get("raw", {}).get("samples") or [] if item[0] <= duration]
    document["raw"]["samples"] = samples
    profiles = {person["handle"].lower(): person for person in document.get("speakers") or []}
    stats = {}
    for turn in turns:
        key = turn["speaker"].lower()
        profile = profiles.get(key, {"handle": turn["speaker"], "name": "", "id": "", "role": "speaker"})
        current = stats.setdefault(key, {**profile, "talkSeconds": 0, "turns": 0, "firstSeen": turn["start"], "lastSeen": turn["end"]})
        current["talkSeconds"] += turn["end"] - turn["start"]
        current["turns"] += 1
        current["firstSeen"] = min(current["firstSeen"], turn["start"])
        current["lastSeen"] = max(current["lastSeen"], turn["end"])
    document["speakers"] = sorted(stats.values(), key=lambda person: (-person["talkSeconds"], person["handle"]))
    return document


def parse_glossary(text):
    entries = []
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        term, _, rest = line.partition(":")
        if not rest and "：" in term:
            term, _, rest = term.partition("：")
        term = term.strip()
        if not term:
            continue
        aliases = [alias.strip() for alias in re.split(r"[,，]", rest) if alias.strip()]
        entries.append({"term": term, "aliases": aliases})
    return entries


def load_glossary(paths):
    merged = {}
    used = []
    for path in paths:
        if not path or not path.is_file():
            continue
        used.append(str(path))
        for entry in parse_glossary(path.read_text(encoding="utf-8")):
            current = merged.setdefault(entry["term"], {"term": entry["term"], "aliases": []})
            for alias in entry["aliases"]:
                if alias not in current["aliases"]:
                    current["aliases"].append(alias)
    return list(merged.values()), used


def alias_pattern(alias):
    if re.fullmatch(r"[A-Za-z0-9' .+-]+", alias):
        words = [re.escape(word) for word in alias.split()]
        return re.compile(r"(?<![A-Za-z0-9])" + r"\s*".join(words) + r"(?![A-Za-z0-9])", re.IGNORECASE)
    return re.compile(re.escape(alias), re.IGNORECASE)


def glossary_rules(entries):
    rules = []
    for entry in entries:
        for alias in entry["aliases"]:
            rules.append((len(alias), alias_pattern(alias), entry["term"]))
        if re.fullmatch(r"[A-Za-z0-9' .+-]+", entry["term"]):
            rules.append((len(entry["term"]), alias_pattern(entry["term"]), entry["term"]))
    rules.sort(key=lambda rule: -rule[0])
    return [(pattern, term) for _, pattern, term in rules]


def apply_glossary(text, rules):
    # 先把命中的位置换成占位符，避免短词把已经替换好的长词再改一遍。
    found = []

    def hold(term):
        def replace(_match):
            found.append(term)
            return f"\0{len(found) - 1}\0"

        return replace

    for pattern, term in rules:
        text = pattern.sub(hold(term), text)
    return re.sub(r"\0(\d+)\0", lambda match: found[int(match.group(1))], text)


def auto_hotwords(document, entries):
    words = []
    space = document.get("space") or {}
    people = list(document.get("speakers") or [])
    if space.get("host"):
        people.append(space["host"])
    for person in people:
        for value in (person.get("name"), person.get("handle")):
            if value:
                words.append(value)
    words.extend(word for word in ASCII_WORD.findall(space.get("title") or "") if len(word) >= 3)
    words.extend(entry["term"] for entry in entries)
    seen = set()
    unique = []
    for word in words:
        key = word.lower()
        if key not in seen:
            seen.add(key)
            unique.append(word)
    return unique


def speaker_at(samples, start, end, threshold):
    window_start = start - 0.15
    window_end = max(end, start) + 0.15
    totals = {}
    nearest = None
    nearest_distance = 0.6
    midpoint = (start + max(end, start)) / 2
    for time, levels in samples:
        if time < window_start - 0.6:
            continue
        audible = {handle: level for handle, level in levels.items() if level > threshold}
        if window_start <= time <= window_end:
            for handle, level in audible.items():
                totals[handle] = totals.get(handle, 0) + level
        distance = abs(time - midpoint)
        if audible and distance < nearest_distance:
            nearest = max(audible, key=audible.get)
            nearest_distance = distance
        if time > window_end + 0.6 and (totals or nearest):
            break
    if totals:
        return max(totals, key=totals.get)
    return nearest


def whisper_words(result):
    words = []
    for segment in result.get("segments") or []:
        timed = segment.get("words") or []
        if timed:
            for word in timed:
                text = word.get("word") or ""
                if not str(text).strip():
                    continue
                words.append({"start": float(word["start"]), "end": float(word["end"]), "text": str(text)})
        elif str(segment.get("text") or "").strip():
            words.append(
                {
                    "start": float(segment["start"]),
                    "end": float(segment["end"]),
                    "text": str(segment["text"]),
                }
            )
    return words


def sentence_units(sentence):
    text = sentence.get("text") or ""
    stamps = sentence.get("timestamp") or []
    matches = list(UNIT.finditer(text))
    if not matches or len(matches) != len(stamps):
        if not text.strip():
            return []
        return [{"start": sentence["start"] / 1000, "end": sentence["end"] / 1000, "text": text}]
    units = []
    for index, match in enumerate(matches):
        stop = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        begin = 0 if index == 0 else match.start()
        piece = text[begin:stop]
        tail = len(piece) - len(piece.rstrip())
        lead = " " if index > 0 and text[match.start() - 1].isspace() else ""
        units.append(
            {
                "start": stamps[index][0] / 1000,
                "end": stamps[index][1] / 1000,
                "text": lead + piece[: len(piece) - tail] if tail else lead + piece,
            }
        )
    return units


def drop_sparse(units):
    runs = []
    for unit in units:
        if runs and unit["start"] - runs[-1][-1]["end"] <= RUN_GAP:
            runs[-1].append(unit)
        else:
            runs.append([unit])
    kept = []
    dropped = 0
    for run in runs:
        span = run[-1]["end"] - run[0]["start"]
        # 单独成句的“嗯”“好的”要留；被长停顿隔开、孤零零的一个字多半是杂音。
        lonely = len(run) == 1 and len(runs) > 1
        sparse = len(run) >= 2 and len(run) / max(span, 0.1) < MIN_RATE
        if lonely or sparse:
            dropped += len(run)
        else:
            kept.extend(run)
    if dropped and kept:
        ending = re.search(r"[，。？！、,.?!]+$", units[-1]["text"])
        if ending and not re.search(r"[，。？！、,.?!]$", kept[-1]["text"]):
            kept[-1] = {**kept[-1], "text": kept[-1]["text"] + ending.group(0)}
    return kept, dropped


def funasr_words(result):
    words = []
    dropped = 0
    for item in result if isinstance(result, list) else [result]:
        for sentence in item.get("sentence_info") or []:
            kept, count = drop_sparse(sentence_units(sentence))
            words.extend(kept)
            dropped += count
    return words, dropped


def group_words(words, samples, threshold):
    segments = []
    current = None
    for word in words:
        handle = speaker_at(samples, word["start"], word["end"], threshold)
        gap = word["start"] - current["end"] if current else 0
        # 气口处音量会掉到阈值以下，短词会对不上人。紧挨着上一句时沿用上一句的发言人。
        if handle is None and current and current["handle"] and gap <= MERGE_GAP:
            handle = current["handle"]
        if current and current["handle"] == handle and gap <= MERGE_GAP:
            current["end"] = word["end"]
            current["words"].append(word)
        else:
            if current:
                segments.append(finish_segment(current))
            current = {"handle": handle, "start": word["start"], "end": word["end"], "words": [word]}
    if current:
        segments.append(finish_segment(current))
    return absorb_fragments(segments)


def absorb_fragments(segments):
    # 别人插一句“嗯”时，主讲人的一两个字会被切出去。前后是同一个人且挨得很近，就并回去。
    merged = []
    index = 0
    while index < len(segments):
        segment = segments[index]
        after = segments[index + 1] if index + 1 < len(segments) else None
        before = merged[-1] if merged else None
        if (
            before
            and after
            and len(segment["words"]) <= 2
            and segment["end"] - segment["start"] <= 1.0
            and before["handle"] == after["handle"] != segment["handle"]
            and segment["start"] - before["end"] <= MERGE_GAP
            and after["start"] - segment["end"] <= MERGE_GAP
        ):
            merged[-1] = finish_segment(
                {
                    "handle": before["handle"],
                    "start": before["start"],
                    "end": after["end"],
                    "words": before["words"] + segment["words"] + after["words"],
                }
            )
            index += 2
            continue
        merged.append(segment)
        index += 1
    return merged


def finish_segment(segment):
    return {
        "start": round(segment["start"], 3),
        "end": round(segment["end"], 3),
        "handle": segment["handle"],
        "text": "".join(word["text"] for word in segment["words"]).strip(),
        "words": [
            {"start": round(word["start"], 3), "end": round(word["end"], 3), "text": word["text"]}
            for word in segment["words"]
        ],
    }


def profiles_of(document):
    found = {}
    for person in document.get("speakers") or []:
        handle = person.get("handle") or ""
        if handle:
            found[handle.lower()] = person
    host = (document.get("space") or {}).get("host") or {}
    if host.get("handle"):
        found.setdefault(host["handle"].lower(), {**host, "role": "host"})
    return found


def attach_names(segments, profiles):
    for segment in segments:
        handle = segment.pop("handle")
        person = profiles.get((handle or "").lower())
        if person:
            segment["speaker"] = {
                "id": person.get("id") or "",
                "handle": person.get("handle") or handle,
                "name": person.get("name") or "",
                "role": person.get("role") or "speaker",
            }
        elif handle:
            segment["speaker"] = {"id": "", "handle": handle, "name": "", "role": "speaker"}
        else:
            segment["speaker"] = None
    return segments


def speaker_label(speaker):
    if not speaker:
        return "（未能对应到发言人）"
    name = speaker.get("name") or ""
    handle = speaker.get("handle") or ""
    if name and handle:
        return f"{name} (@{handle})"
    if handle:
        return f"@{handle}"
    return name or "（未能对应到发言人）"


def render_markdown(document, segments, details):
    space = document.get("space") or {}
    host = space.get("host") or {}
    lines = [f"# {space.get('title') or 'X Space'}", ""]
    if host.get("name") or host.get("handle"):
        lines.append(f"- 主持人：{speaker_label(host)}")
    if space.get("startedAt"):
        lines.append(f"- 开始：{space['startedAt']}")
    if space.get("url"):
        lines.append(f"- 链接：{space['url']}")
    lines.append(f"- 转写：{details['engine']}（{details['model']}）")
    if details.get("language"):
        lines.append(f"- 语言：{details['language']}")
    if details.get("glossary"):
        lines.append(f"- 术语表：{'、'.join(Path(path).name for path in details['glossary'])}")
    if details.get("duration"):
        lines.append(f"- 范围：只转写了录音开头的 {clock(details['duration'])}")
    lines.extend(["", "## 发言时长", "", "| 发言人 | 时长 | 段数 |", "| --- | --- | --- |"])
    for person in document.get("speakers") or []:
        lines.append(
            f"| {speaker_label(person)} | {clock(person.get('talkSeconds') or 0)} | {person.get('turns') or 0} |"
        )
    lines.extend(["", "## 文字稿", ""])
    for segment in segments:
        lines.append(f"**[{clock(segment['start'])}] {speaker_label(segment.get('speaker'))}**")
        lines.append("")
        lines.append(segment["text"])
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def require_ffmpeg():
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise SystemExit("需要 ffmpeg：brew install ffmpeg")
    return ffmpeg


def prepare_audio(source, duration, as_wav):
    if not duration and not as_wav:
        return None, source
    ffmpeg = require_ffmpeg()
    directory = tempfile.TemporaryDirectory()
    command = [ffmpeg, "-y", "-i", str(source)]
    if duration:
        command += ["-t", str(duration)]
    if as_wav:
        target = Path(directory.name) / f"{source.stem}.wav"
        command += ["-ac", "1", "-ar", "16000", str(target)]
    else:
        target = Path(directory.name) / f"{source.stem}{source.suffix}"
        command += ["-c", "copy", str(target)]
    subprocess.run(command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return directory, target


def transcribe_funasr(audio, hotwords):
    os.environ.setdefault("MODELSCOPE_CACHE", str(MODELSCOPE_CACHE))
    import logging

    from funasr import AutoModel

    logging.getLogger().setLevel(logging.WARNING)
    model = AutoModel(
        model=FUNASR_MODEL,
        vad_model="fsmn-vad",
        punc_model="ct-punc",
        disable_update=True,
        disable_pbar=True,
        disable_log=True,
    )
    logging.getLogger().setLevel(logging.WARNING)
    result = model.generate(
        input=str(audio),
        hotword=" ".join(hotwords),
        batch_size_s=300,
        sentence_timestamp=True,
    )
    return funasr_words(result)


def transcribe_whisper(audio, model, language):
    try:
        import mlx_whisper
    except ImportError:
        raise SystemExit("Whisper 引擎需要 mlx-whisper：uv run --with mlx-whisper tools/transcribe.py ... --engine whisper")

    options = {
        "path_or_hf_repo": model,
        "word_timestamps": True,
        "verbose": False,
        "condition_on_previous_text": False,
        "hallucination_silence_threshold": 2.0,
    }
    if language:
        options["language"] = language
    result = mlx_whisper.transcribe(str(audio), **options)
    return whisper_words(result), result.get("language") or language


def resolve_whisper_model(requested):
    if requested:
        return requested
    if (LOCAL_TURBO / "weights.safetensors").is_file() and (LOCAL_TURBO / "config.json").is_file():
        return str(LOCAL_TURBO)
    return WHISPER_MODEL


def build_transcript(document, words, rules=()):
    threshold = (document.get("params") or {}).get("threshold", 20)
    samples = document.get("raw", {}).get("samples") or []
    segments = attach_names(group_words(words, samples, threshold), profiles_of(document))
    if rules:
        for segment in segments:
            segment["text"] = apply_glossary(segment["text"], rules)
    return segments


def self_test():
    document = {
        "params": {"threshold": 20},
        "space": {"title": "测试", "host": {"handle": "hostuser", "name": "主持人"}},
        "speakers": [
            {"id": "tw-1", "handle": "hostuser", "name": "主持人", "role": "host", "talkSeconds": 2, "turns": 1},
            {"id": "tw-2", "handle": "alice", "name": "Alice", "role": "speaker", "talkSeconds": 2, "turns": 1},
        ],
        "raw": {
            "samples": [
                [0.5, {"alice": 80, "hostuser": 10}],
                [1.0, {"alice": 70}],
                [1.6, {"hostuser": 90, "alice": 30}],
            ]
        },
    }
    words = [
        {"start": 0.4, "end": 0.9, "text": "你好"},
        {"start": 1.0, "end": 1.3, "text": "世界"},
        {"start": 1.55, "end": 2.0, "text": "我来"},
    ]
    segments = build_transcript(document, words)
    assert [segment["speaker"]["handle"] for segment in segments] == ["alice", "hostuser"], segments
    assert segments[0]["text"] == "你好世界"
    assert segments[1]["text"] == "我来"
    quiet = build_transcript(
        {"params": {"threshold": 20}, "raw": {"samples": [[0.5, {"alice": 80}], [3.0, {"alice": 80}]]}},
        [
            {"start": 0.4, "end": 0.8, "text": "你好"},
            {"start": 1.2, "end": 1.4, "text": "啊"},
            {"start": 2.9, "end": 3.2, "text": "世界"},
        ],
    )
    assert len(quiet) == 2
    assert quiet[0]["text"] == "你好啊"
    assert quiet[0]["speaker"]["handle"] == "alice"
    assert quiet[1]["text"] == "世界"
    interrupted = build_transcript(
        {"params": {"threshold": 20}, "raw": {"samples": [[0.5, {"alice": 80}], [1.1, {"bob": 90}], [1.6, {"alice": 80}]]}},
        [
            {"start": 0.4, "end": 0.8, "text": "我先"},
            {"start": 1.0, "end": 1.2, "text": "说"},
            {"start": 1.5, "end": 1.8, "text": "一下"},
        ],
    )
    assert [(segment["speaker"]["handle"], segment["text"]) for segment in interrupted] == [("alice", "我先说一下")]
    clipped = clip_document(
        {
            "speakers": document["speakers"],
            "turns": [
                {"speaker": "alice", "start": 0, "end": 5, "peak": 80},
                {"speaker": "hostuser", "start": 8, "end": 12, "peak": 90},
            ],
            "raw": {"samples": [[1, {"alice": 80}], [9, {"hostuser": 90}]]},
        },
        6,
    )
    assert [turn["speaker"] for turn in clipped["turns"]] == ["alice"]
    assert len(clipped["raw"]["samples"]) == 1

    entries = parse_glossary(
        "# 注释\nWayToBot: way to boat, 微突破, V2BOT\nGrok：胡萝卜，萝卜\nClaude\nPersonal Agent: personal a人\n"
    )
    assert [entry["term"] for entry in entries] == ["WayToBot", "Grok", "Claude", "Personal Agent"]
    rules = glossary_rules(entries)
    fixed = apply_glossary("成立 way to boat 社区，也叫微突破或 waytoboat，用胡萝卜和萝卜，还有 claude 和 personal agent、v2bot", rules)
    assert fixed == "成立 WayToBot 社区，也叫WayToBot或 WayToBot，用Grok和Grok，还有 Claude 和 Personal Agent、WayToBot", fixed
    assert apply_glossary("boats 和 claudette", rules) == "boats 和 claudette"
    assert auto_hotwords(
        {"space": {"title": "WayToBot 社区 AI", "host": {"handle": "hostuser", "name": "主持人"}}, "speakers": document["speakers"]},
        entries,
    ) == ["主持人", "hostuser", "Alice", "WayToBot", "Grok", "Claude", "Personal Agent"]

    sentence = {
        "text": "成立 way to boat 这个社区。",
        "start": 1000,
        "end": 3000,
        "timestamp": [[1000, 1200], [1200, 1400], [1400, 1500], [1500, 1600], [1600, 1700], [1700, 1900], [1900, 2100], [2100, 2300], [2300, 2500]],
    }
    units = sentence_units(sentence)
    assert "".join(unit["text"] for unit in units) == "成立 way to boat 这个社区。", units
    assert units[2] == {"start": 1.4, "end": 1.5, "text": " way"}
    noisy = {
        "text": "啊啊啊，好的。",
        "start": 0,
        "end": 9000,
        "timestamp": [[0, 200], [2000, 2200], [4000, 4200], [8000, 8200], [8200, 8400]],
    }
    words, dropped = funasr_words({"sentence_info": [noisy, {"text": "嗯，", "start": 9000, "end": 9200, "timestamp": [[9000, 9200]]}]})
    assert dropped == 3 and "".join(word["text"] for word in words) == "好的。嗯，", words
    tail = {"text": "开始了哦。", "start": 0, "end": 9000, "timestamp": [[0, 200], [200, 400], [400, 600], [8000, 8200]]}
    words, dropped = funasr_words({"sentence_info": [tail]})
    assert dropped == 1 and "".join(word["text"] for word in words) == "开始了。", words
    sparse = {"text": "爸哔哒爸", "start": 0, "end": 4000, "timestamp": [[0, 200], [1200, 1400], [2400, 2600], [3600, 3800]]}
    words, dropped = funasr_words([{"sentence_info": [sparse, sentence]}])
    assert dropped == 4 and "".join(word["text"] for word in words) == "成立 way to boat 这个社区。"
    print("self-test ok")


def main():
    parser = argparse.ArgumentParser(description="把 Space 录音转写成带发言人的文字稿")
    parser.add_argument("audio", nargs="?", help="下载得到的 m4a")
    parser.add_argument("--speakers", help="默认使用与音频同名的 .speakers.json")
    parser.add_argument("--engine", choices=["funasr", "whisper"], default="funasr", help="默认 funasr")
    parser.add_argument("--model", default="", help=f"仅 whisper 引擎使用，默认 {WHISPER_MODEL}，本地已有则用本地文件")
    parser.add_argument("--language", default="", help="仅 whisper 引擎使用，留空自动检测")
    parser.add_argument("--glossary", action="append", default=[], help="额外的术语表，可重复。默认已读 tools/glossary.txt")
    parser.add_argument("--no-glossary", action="store_true", help="不读任何术语表")
    parser.add_argument("--duration", type=float, default=0, help="只转写开头的若干秒，用来试跑")
    parser.add_argument("--output-dir", default="", help="默认和音频放在同一目录")
    parser.add_argument("--self-test", action="store_true", help="只跑对齐和术语逻辑的自检，不加载模型")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return
    if not args.audio:
        parser.error("请提供 m4a 文件")

    audio = Path(args.audio).expanduser().resolve()
    speakers_path = Path(args.speakers).expanduser().resolve() if args.speakers else audio.with_suffix(".speakers.json")
    if not audio.is_file():
        raise SystemExit(f"找不到录音：{audio}")
    if not speakers_path.is_file():
        raise SystemExit(f"找不到发言人时间线：{speakers_path}\n请用 tools/download.mjs 或扩展重新下载。")

    document = clip_document(load_speakers(speakers_path), args.duration)
    glossary_paths = [] if args.no_glossary else [DEFAULT_GLOSSARY, audio.with_suffix(".glossary.txt")]
    glossary_paths += [Path(path).expanduser().resolve() for path in args.glossary]
    entries, glossary_used = load_glossary(glossary_paths)
    rules = glossary_rules(entries)
    hotwords = auto_hotwords(document, entries)

    held = None
    dropped = 0
    try:
        held, source = prepare_audio(audio, args.duration, args.engine == "funasr")
        if args.engine == "funasr":
            model = FUNASR_MODEL
            language = "zh"
            print(f"转写 {audio.name}，FunASR，热词 {len(hotwords)} 个", file=sys.stderr)
            words, dropped = transcribe_funasr(source, hotwords)
        else:
            model = resolve_whisper_model(args.model)
            print(f"转写 {audio.name}，Whisper {model}", file=sys.stderr)
            words, language = transcribe_whisper(source, model, args.language)
    finally:
        if held:
            held.cleanup()

    segments = build_transcript(document, words, rules)
    payload = {
        "version": 2,
        "engine": args.engine,
        "model": model,
        "language": language,
        "audio": str(audio),
        "speakersFile": str(speakers_path),
        "durationLimit": args.duration or None,
        "glossary": glossary_used,
        "hotwords": hotwords if args.engine == "funasr" else [],
        "droppedNoiseUnits": dropped,
        "space": document.get("space"),
        "speakers": document.get("speakers"),
        "segments": segments,
    }
    output_dir = Path(args.output_dir).expanduser().resolve() if args.output_dir else audio.parent
    output_dir.mkdir(parents=True, exist_ok=True)
    label = f".{int(args.duration)}s" if args.duration else ""
    json_path = output_dir / f"{audio.stem}{label}.transcript.json"
    md_path = output_dir / f"{audio.stem}{label}.transcript.md"
    json_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    details = {
        "engine": "FunASR" if args.engine == "funasr" else "Whisper",
        "model": model,
        "language": language,
        "glossary": glossary_used,
        "duration": args.duration,
    }
    md_path.write_text(render_markdown(document, segments, details), encoding="utf-8")
    print(md_path)
    print(json_path)


if __name__ == "__main__":
    main()
