// 8-bit sound effects, synthesized live with Web Audio (square, triangle and
// noise voices, like an old console's sound chip). No audio files. Every sound
// is an original little jingle in the arcade/RPG style, not a copy of any game's.
//
// Browsers keep audio locked until the first click or key, so sounds before
// that are dropped. Muting is remembered per browser.
import type { AbyssEvent } from "../contract";

type Wave = "square" | "triangle" | "sawtooth";

const MUTE_KEY = "abyss.sfx.muted";
const MASTER = 0.18;

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noiseBuffer: AudioBuffer | null = null;
let muted = readMuted();
const lastPlayed = new Map<string, number>();
const listeners = new Set<(muted: boolean) => void>();
let chomp = false;

function readMuted(): boolean {
  try {
    return window.localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
}

function audio(): AudioContext | null {
  if (ctx) return ctx;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  ctx = new Ctor();
  master = ctx.createGain();
  master.gain.value = muted ? 0 : MASTER;
  master.connect(ctx.destination);
  return ctx;
}

/** Call once at startup: unlocks audio on the first user gesture. */
export function installAudioUnlock(): void {
  const unlock = () => {
    const ac = audio();
    if (ac?.state === "suspended") void ac.resume();
    window.removeEventListener("pointerdown", unlock);
    window.removeEventListener("keydown", unlock);
  };
  window.addEventListener("pointerdown", unlock);
  window.addEventListener("keydown", unlock);
}

export function isMuted(): boolean {
  return muted;
}

export function setMuted(value: boolean): void {
  muted = value;
  try {
    window.localStorage.setItem(MUTE_KEY, value ? "1" : "0");
  } catch {
    // private window: the choice just lasts this visit
  }
  if (master && ctx) master.gain.setTargetAtTime(value ? 0 : MASTER, ctx.currentTime, 0.02);
  for (const listener of listeners) listener(value);
}

export function onMutedChange(listener: (muted: boolean) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** MIDI note number to Hz (69 = A4). */
const hz = (note: number) => 440 * 2 ** ((note - 69) / 12);

interface Note {
  /** MIDI note, or Hz when `freq` is set. */
  n?: number;
  freq?: number;
  /** Start, seconds after the sound begins. */
  at?: number;
  dur: number;
  wave?: Wave;
  vol?: number;
  /** Slide to this MIDI note by the end. */
  to?: number;
}

/** Plays notes unless muted, locked, or the same sound played within `gapMs`. */
function play(name: string, notes: Note[], gapMs = 50): void {
  if (muted) return;
  const ac = audio();
  if (!ac || !master || ac.state !== "running") return;
  const now = performance.now();
  if (now - (lastPlayed.get(name) ?? -Infinity) < gapMs) return;
  lastPlayed.set(name, now);
  const t0 = ac.currentTime + 0.005;
  for (const note of notes) {
    const start = t0 + (note.at ?? 0);
    const end = start + note.dur;
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = note.wave ?? "square";
    osc.frequency.setValueAtTime(note.freq ?? hz(note.n ?? 69), start);
    if (note.to !== undefined) osc.frequency.exponentialRampToValueAtTime(hz(note.to), end);
    const vol = note.vol ?? 0.6;
    gain.gain.setValueAtTime(vol, start);
    gain.gain.setValueAtTime(vol, Math.max(start, end - 0.02));
    gain.gain.linearRampToValueAtTime(0, end);
    osc.connect(gain).connect(master);
    osc.start(start);
    osc.stop(end + 0.01);
  }
}

/** A burst of noise, for bumps, crashes and the drum hit on fanfares. */
function noise(name: string, dur: number, vol = 0.4, at = 0, gapMs = 50): void {
  if (muted) return;
  const ac = audio();
  if (!ac || !master || ac.state !== "running") return;
  const now = performance.now();
  const key = `noise:${name}`;
  if (now - (lastPlayed.get(key) ?? -Infinity) < gapMs) return;
  lastPlayed.set(key, now);
  if (!noiseBuffer) {
    noiseBuffer = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    // stepped noise sounds crunchier, like an NES noise channel
    let v = 0;
    for (let i = 0; i < data.length; i += 1) {
      if (i % 8 === 0) v = Math.random() * 2 - 1;
      data[i] = v;
    }
  }
  const start = ac.currentTime + 0.005 + at;
  const src = ac.createBufferSource();
  const gain = ac.createGain();
  src.buffer = noiseBuffer;
  gain.gain.setValueAtTime(vol, start);
  gain.gain.exponentialRampToValueAtTime(0.001, start + dur);
  src.connect(gain).connect(master);
  src.start(start);
  src.stop(start + dur + 0.01);
}

const arp = (notes: number[], step: number, dur = step, wave: Wave = "square", vol = 0.5): Note[] =>
  notes.map((n, i) => ({ n, at: i * step, dur, wave, vol }));

export const sfx = {
  /** Clicked open ground: a tiny tick. */
  click: () => play("click", [{ n: 84, dur: 0.03, vol: 0.35 }]),
  /** One footstep while the player walks. */
  step: () => play("step", [{ n: 43, dur: 0.035, wave: "triangle", vol: 0.5 }], 120),
  /** A panel opened (menu-open chirp). */
  open: () => play("open", arp([72, 79], 0.05, 0.06, "square", 0.4)),
  /** A panel closed. */
  close: () => play("close", arp([79, 72], 0.05, 0.06, "square", 0.35)),
  /** Sent a command in the terminal: a laser "pew". */
  submit: () => play("submit", [{ n: 88, to: 64, dur: 0.12, vol: 0.4 }]),
  /** Stopped a job: power-down slide. */
  stop: () => play("stop", [{ n: 72, to: 36, dur: 0.45, vol: 0.45 }]),
  /** A steering note landed: a sparkly "secret found" run. */
  steer: () => play("steer", arp([72, 76, 79, 84, 88, 91], 0.045, 0.06, "square", 0.35)),
  /** Something went wrong: a buzzy bump. */
  error: () => {
    play("error", [{ n: 40, dur: 0.12, vol: 0.5 }, { n: 35, at: 0.13, dur: 0.22, vol: 0.5 }]);
    noise("error", 0.12, 0.25);
  },
  /** Spending hit a limit: a two-tone alarm. */
  alarm: () => play("alarm", [0, 1, 2, 3].map((i) => ({ n: i % 2 ? 76 : 83, at: i * 0.12, dur: 0.11, vol: 0.4 })), 2000),

  /** New job: race-start countdown, three lows and a high. */
  jobStart: () => play("jobStart", [
    { n: 67, at: 0, dur: 0.12 },
    { n: 67, at: 0.35, dur: 0.12 },
    { n: 67, at: 0.7, dur: 0.12 },
    { n: 79, at: 1.05, dur: 0.35 },
  ], 1500),
  /** A task went up on the board: bell ding. */
  posted: () => play("posted", [{ n: 88, dur: 0.18, wave: "triangle", vol: 0.6 }, { n: 95, at: 0.04, dur: 0.14, wave: "triangle", vol: 0.3 }], 150),
  /** A vendor bid: alternating arcade chomp. */
  bid: () => {
    chomp = !chomp;
    play("bid", [{ n: chomp ? 62 : 67, to: chomp ? 55 : 60, dur: 0.07, wave: "triangle", vol: 0.7 }], 70);
  },
  /** A vendor won the task: coin pickup. */
  won: () => play("won", [{ n: 84, dur: 0.07, vol: 0.45 }, { n: 91, at: 0.07, dur: 0.28, vol: 0.45 }], 120),
  /** A vendor started working: quick power-up. */
  working: () => play("working", arp([60, 64, 67, 72, 76, 79], 0.03, 0.04, "square", 0.3), 200),
  /** Work handed in: a few coins, more for pricier work. */
  done: (coins: number) => {
    const n = Math.max(1, Math.min(5, coins));
    play("done", Array.from({ length: n }, (_, i) => ({ n: 91 + (i % 2) * 5, at: i * 0.07, dur: 0.06, vol: 0.35 })), 150);
  },
  /** Reviewer graded: happy chime, a shrug, or a sad bonk. */
  graded: (verdict: "good" | "ok" | "bad") => {
    if (verdict === "good") play("graded", arp([76, 80, 83, 88], 0.06, 0.09, "square", 0.4));
    else if (verdict === "ok") play("graded", arp([72, 72], 0.1, 0.08, "square", 0.35));
    else play("graded", [{ n: 55, to: 43, dur: 0.35, vol: 0.45 }]);
  },
  /** Job finished: item-get fanfare, or a sad descending tune. */
  final: (ok: boolean) => {
    if (ok) {
      play("final", [
        ...arp([67, 71, 74, 79], 0.09, 0.09, "square", 0.45),
        { n: 83, at: 0.36, dur: 0.12, vol: 0.45 },
        { n: 86, at: 0.5, dur: 0.6, vol: 0.45 },
        // bass line underneath
        { n: 43, at: 0, dur: 0.34, wave: "triangle", vol: 0.8 },
        { n: 50, at: 0.36, dur: 0.74, wave: "triangle", vol: 0.8 },
      ], 1500);
      noise("final", 0.08, 0.25, 0.5);
    } else {
      play("final", arp([71, 70, 69], 0.25, 0.22, "square", 0.4).concat([{ n: 68, at: 0.75, to: 63, dur: 0.6, vol: 0.4 }]), 1500);
    }
  },
};

/** Sounds for market events, played alongside the Director's animations. */
export function onMarketEvent(ev: AbyssEvent): void {
  switch (ev.type) {
    case "job_split":
      sfx.jobStart();
      break;
    case "task_posted":
      sfx.posted();
      break;
    case "bid":
      if (ev.data.ok) sfx.bid();
      break;
    case "won":
      sfx.won();
      break;
    case "working":
      sfx.working();
      break;
    case "done":
      sfx.done(Math.round(ev.data.usage.cost_usd * 1000));
      break;
    case "graded": {
      const promised = ev.data.promised_quality;
      const verdict = promised === null || ev.data.grade >= promised ? "good" : ev.data.grade < promised - 1 ? "bad" : "ok";
      sfx.graded(verdict);
      break;
    }
    case "steered":
      sfx.steer();
      break;
    case "error":
      sfx.error();
      break;
    case "final":
      sfx.final(ev.data.status === "ok");
      break;
    default:
      break;
  }
}
