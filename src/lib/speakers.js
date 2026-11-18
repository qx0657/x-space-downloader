// X 把"谁在麦上、音量多大"写进音频分片的 ID3 标签（HydraParticipants / HydraAudioLevel）。
// 这些标签夹在 AAC 帧之间，大约每 0.2 秒一条。合成 m4a 时本来会丢掉它们，这里先读出来。
// 音量数组比在麦人数多 1：第 0 位是主持人，后面按 HydraParticipants 的顺序对应嘉宾。

const SAMPLES_PER_FRAME = 1024;

export const SPEAKER_DEFAULTS = Object.freeze({
  threshold: 20,
  mergeGapSeconds: 1,
  minTurnSeconds: 0.4,
});

function syncsafe(bytes, offset) {
  return (
    ((bytes[offset] & 0x7f) << 21) |
    ((bytes[offset + 1] & 0x7f) << 14) |
    ((bytes[offset + 2] & 0x7f) << 7) |
    (bytes[offset + 3] & 0x7f)
  );
}

function be32(bytes, offset) {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function decodeText(data) {
  if (!data.length) return "";
  const encoding = data[0];
  const body = data.subarray(1);
  if (encoding === 0) return new TextDecoder("latin1").decode(body);
  if (encoding === 3 || encoding > 3) return new TextDecoder().decode(body);
  const little = encoding === 1 && body.length >= 2 && body[0] === 0xff && body[1] === 0xfe;
  const bytes = little ? body.subarray(2) : body;
  return new TextDecoder(little ? "utf-16le" : "utf-16be").decode(bytes);
}

function textParts(data) {
  return decodeText(data).replace(/\0+$/u, "").split("\0");
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function twitterId(restId) {
  const id = String(restId || "");
  if (!id) return "";
  return id.startsWith("tw-") ? id : `tw-${id}`;
}

// 一个 ID3 标签里按出现顺序返回 participants / levels 事件。
export function readHydraTag(tag) {
  if (!tag || tag.length < 10 || tag[0] !== 0x49 || tag[1] !== 0x44 || tag[2] !== 0x33) return null;
  const version = tag[3];
  const size = syncsafe(tag, 6);
  const end = Math.min(tag.length, 10 + size);
  let offset = 10;
  if (tag[5] & 0x40 && offset + 4 <= end) offset += syncsafe(tag, offset);
  const events = [];
  while (offset + 10 <= end) {
    const id = String.fromCharCode(tag[offset], tag[offset + 1], tag[offset + 2], tag[offset + 3]);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const frameSize = version === 4 ? syncsafe(tag, offset + 4) : be32(tag, offset + 4);
    const format = tag[offset + 9];
    const bodyStart = offset + 10;
    const bodyEnd = bodyStart + frameSize;
    if (frameSize < 0 || bodyEnd > end) break;
    if (id === "TXXX" && format === 0) {
      const [key, ...rest] = textParts(tag.subarray(bodyStart, bodyEnd));
      const value = rest.join("\0");
      if (key === "HydraParticipants") {
        const people = parseJson(value);
        if (Array.isArray(people)) events.push({ type: "participants", people });
      } else if (key === "HydraAudioLevel") {
        const levels = parseJson(value);
        if (Array.isArray(levels)) events.push({ type: "levels", values: levels.map((level) => Number(level) || 0) });
      }
    }
    offset = bodyEnd;
  }
  return events.length ? { events } : null;
}

export function rosterFromSpace(space = {}) {
  const metadata = space.metadata || {};
  const creator = metadata.creator_results?.result || {};
  const core = creator.core || {};
  const legacy = creator.legacy || {};
  const host = {
    id: twitterId(creator.rest_id),
    handle: core.screen_name || legacy.screen_name || "",
    name: core.name || legacy.name || "",
  };
  const people = [];
  const seen = new Set();
  const groups = space.participants || {};
  for (const role of ["admins", "speakers"]) {
    for (const person of groups[role] || []) {
      const handle = person.twitter_screen_name || "";
      const key = handle.toLowerCase();
      if (!handle || seen.has(key)) continue;
      seen.add(key);
      people.push({
        id: twitterId(person.user_results?.rest_id),
        handle,
        name: person.display_name || "",
        role: role === "admins" ? "admin" : "speaker",
      });
    }
  }
  const hostPerson = people.find((person) => person.handle.toLowerCase() === host.handle.toLowerCase());
  if (hostPerson) {
    if (!host.id) host.id = hostPerson.id;
    if (!host.name) host.name = hostPerson.name;
  }
  return { host, people };
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

function iso(value) {
  if (value == null || value === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function indexRoster(roster) {
  const byHandle = new Map();
  const add = (person, role) => {
    const handle = person?.handle || "";
    if (!handle || byHandle.has(handle.toLowerCase())) return;
    byHandle.set(handle.toLowerCase(), { ...person, handle, role });
  };
  add(roster.host, "host");
  for (const person of roster.people || []) {
    const role =
      person.handle?.toLowerCase() === roster.host?.handle?.toLowerCase() ? "host" : person.role || "speaker";
    add(person, role);
  }
  return byHandle;
}

function mapLevels(levels, people, hostHandle) {
  const mapped = [];
  if (people.length > 0 && levels.length === people.length + 1) {
    mapped.push({ handle: hostHandle, userId: "", host: true, level: levels[0] });
    people.forEach((person, index) => {
      mapped.push({
        handle: person?.UserName || "",
        userId: person?.UserId || "",
        host: false,
        level: levels[index + 1],
      });
    });
    return { mapped, unmapped: false };
  }
  if (people.length > 0 && levels.length === people.length) {
    people.forEach((person, index) => {
      mapped.push({
        handle: person?.UserName || "",
        userId: person?.UserId || "",
        host: false,
        level: levels[index],
      });
    });
    return { mapped, unmapped: false };
  }
  if (people.length === 0 && levels.length === 1) {
    mapped.push({ handle: hostHandle, userId: "", host: true, level: levels[0] });
    return { mapped, unmapped: false };
  }
  return { mapped, unmapped: true };
}

function identityFor(entry, roster, byHandle) {
  if (entry.host) {
    const host = roster.host || {};
    const handle = host.handle || "host";
    return { key: handle.toLowerCase(), handle, id: host.id || "", name: host.name || "", role: "host" };
  }
  const known = byHandle.get((entry.handle || "").toLowerCase());
  const handle = known?.handle || entry.handle || entry.userId || "unknown";
  return {
    key: handle.toLowerCase(),
    handle,
    id: known?.id || entry.userId || "",
    name: known?.name || "",
    role: known?.role || "speaker",
  };
}

function expandGroups(groups, sampleRate, durationSeconds) {
  const toSeconds = (frame) => (frame * SAMPLES_PER_FRAME) / sampleRate;
  const samples = [];
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];
    const count = group.levels.length;
    if (!count) continue;
    const start = toSeconds(group.frame);
    const next = groups[index + 1];
    const span =
      next && next.frame > group.frame
        ? toSeconds(next.frame) - start
        : Math.min(0.2 * count, Math.max(0, durationSeconds - start));
    const step = span / count;
    group.levels.forEach((levels, offset) => {
      samples.push({
        t: Math.min(durationSeconds, start + offset * step),
        levels,
        people: group.people,
      });
    });
  }
  return samples;
}

function sampleHold(times) {
  const gaps = [];
  for (let index = 1; index < times.length; index += 1) {
    const gap = times[index] - times[index - 1];
    if (gap > 0.02 && gap < 1) gaps.push(gap);
  }
  if (!gaps.length) return 0.2;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

function buildTurns(loud, mergeGap, minTurn, hold) {
  const byKey = new Map();
  for (const sample of loud) {
    const list = byKey.get(sample.key) || [];
    list.push(sample);
    byKey.set(sample.key, list);
  }
  const turns = [];
  for (const list of byKey.values()) {
    let current = null;
    for (const sample of list) {
      if (!current || sample.t - current.last > mergeGap) {
        if (current) turns.push(current);
        current = { ...sample, start: sample.t, last: sample.t, peak: sample.level };
      } else {
        current.last = sample.t;
        current.peak = Math.max(current.peak, sample.level);
      }
    }
    if (current) turns.push(current);
  }
  return turns
    .map((turn) => ({
      speaker: turn.handle,
      start: round3(turn.start),
      end: round3(turn.last + hold),
      peak: turn.peak,
    }))
    .filter((turn) => turn.end - turn.start >= minTurn)
    .sort((a, b) => a.start - b.start || a.speaker.localeCompare(b.speaker));
}

function buildDocument(groups, options) {
  const sampleRate = options.sampleRate || 48000;
  const durationSeconds = options.durationSeconds || 0;
  const roster = options.roster || {};
  const space = options.space || {};
  const threshold = options.threshold ?? SPEAKER_DEFAULTS.threshold;
  const mergeGap = options.mergeGapSeconds ?? SPEAKER_DEFAULTS.mergeGapSeconds;
  const minTurn = options.minTurnSeconds ?? SPEAKER_DEFAULTS.minTurnSeconds;
  const byHandle = indexRoster(roster);
  const hostHandle = roster.host?.handle || "";

  let unmappedSamples = 0;
  const expanded = expandGroups(groups, sampleRate, durationSeconds);
  const raw = [];
  const loud = [];
  const profiles = new Map();
  for (const sample of expanded) {
    const { mapped, unmapped } = mapLevels(sample.levels, sample.people, hostHandle);
    if (unmapped) {
      unmappedSamples += 1;
      continue;
    }
    const levels = {};
    for (const entry of mapped) {
      const person = identityFor(entry, roster, byHandle);
      if (!profiles.has(person.key)) profiles.set(person.key, person);
      if (entry.level > 0) levels[person.handle] = Math.max(levels[person.handle] || 0, entry.level);
      if (entry.level > threshold) loud.push({ ...person, t: sample.t, level: entry.level });
    }
    if (Object.keys(levels).length) raw.push([round3(sample.t), levels]);
  }

  // 同一时刻四舍五入后可能重叠，合并时保留更大的音量。
  const merged = new Map();
  for (const [time, levels] of raw) {
    const bucket = merged.get(time) || {};
    for (const [handle, level] of Object.entries(levels)) bucket[handle] = Math.max(bucket[handle] || 0, level);
    merged.set(time, bucket);
  }

  const hold = sampleHold([...merged.keys()]);
  const turns = buildTurns(loud, mergeGap, minTurn, hold);
  const stats = new Map();
  for (const turn of turns) {
    const key = turn.speaker.toLowerCase();
    const person = profiles.get(key) || { handle: turn.speaker, id: "", name: "", role: "speaker" };
    const current = stats.get(key) || {
      ...person,
      talkSeconds: 0,
      turns: 0,
      firstSeen: turn.start,
      lastSeen: turn.end,
    };
    current.talkSeconds += turn.end - turn.start;
    current.turns += 1;
    current.firstSeen = Math.min(current.firstSeen, turn.start);
    current.lastSeen = Math.max(current.lastSeen, turn.end);
    stats.set(key, current);
  }

  const speakers = [...stats.values()]
    .map((person) => ({
      id: person.id || "",
      handle: person.handle,
      name: person.name || "",
      role: person.role || "speaker",
      talkSeconds: round3(person.talkSeconds),
      turns: person.turns,
      firstSeen: round3(person.firstSeen),
      lastSeen: round3(person.lastSeen),
    }))
    .sort((a, b) => b.talkSeconds - a.talkSeconds || a.handle.localeCompare(b.handle));

  const host = roster.host || {};
  return {
    version: 1,
    space: {
      id: space.id || "",
      url: space.url || "",
      title: space.title || "",
      startedAt: iso(space.startedAt),
      endedAt: iso(space.endedAt),
      durationSeconds: round3(durationSeconds),
      host: { id: host.id || "", handle: host.handle || "", name: host.name || "" },
    },
    params: { threshold, mergeGapSeconds: mergeGap, minTurnSeconds: minTurn },
    speakers,
    turns,
    audio: { sampleRate, unmappedSamples },
    raw: { samples: [...merged.entries()] },
  };
}

export function createSpeakerLog() {
  let people = [];
  const groups = [];
  return {
    observe(tag, frameCount) {
      try {
        const parsed = readHydraTag(tag);
        if (!parsed) return;
        for (const event of parsed.events) {
          if (event.type === "participants") {
            people = event.people;
            continue;
          }
          // 同一个位置上的多条音量是一段时间里的连续采样，先收成一组再按间隔摊开。
          const last = groups[groups.length - 1];
          if (last && last.frame === frameCount && last.people === people) last.levels.push(event.values);
          else groups.push({ frame: frameCount, levels: [event.values], people });
        }
      } catch {
        // 一条标签读坏不影响录音本身。
      }
    },
    finish(options = {}) {
      return buildDocument(groups, options);
    },
  };
}
