// Synthesised sound effects and a small generative music loop (Web Audio).
// Nothing is created until the first user gesture calls unlock().

// Background music: CC0 tracks by Juhani Junkala ("Chiptune Adventures" and
// "5 Chiptunes (Action)", opengameart.org), as AAC files in assets/music.
// They are fetched after the first tap and loop seamlessly.
export const TRACKS = {
  select: 'assets/music/select.m4a', // menus
  stage1: 'assets/music/stage1.m4a',
  stage2: 'assets/music/stage2.m4a',
  action1: 'assets/music/action1.m4a',
  action2: 'assets/music/action2.m4a',
  action3: 'assets/music/action3.m4a',
  boss: 'assets/music/boss.m4a', // every Black Court
};
// The courts take turns through these, so the music changes every court.
export const COURT_TRACKS = ['action1', 'stage1', 'action2', 'stage2', 'action3'];
// A court's music builds from mellow to full power: the low-pass cutoff (Hz)
// opens, the bass shelf (dB) comes up and the level rises a touch.
// The crowd's notes: a major pentatonic, so any run of them sounds musical.
const PENTA = [523, 587, 659, 784, 880];
const BUILD = { cutFrom: 650, cutTo: 20000, bassFrom: -2, bassTo: 9, gainFrom: 0.78 };
export const RUSH_TEMPO = 1.08; // Power Rush plays the music a touch faster
const TRACK_GAIN = 0.33; // the files are mastered loud; this sits them well under the crowd and effects
const DUCK = 0.45; // the music drops to this while the crowd roars
const XFADE = 0.9; // seconds to cross-fade from one track to the next

export class AudioSys {
  constructor(settings) {
    this.settings = settings; // { music, sfx, muted } - shared with the save data
    this.ac = null;
    this.playing = false;
    this.timer = null;
    this.want = 'select'; // the track the game wants now
    this.current = null; // the track actually playing
    this.buffers = {};
    this.loading = {};
  }

  // Ask for a track; a change cross-fades as soon as it has loaded.
  setTrack(name) {
    if (!TRACKS[name]) return;
    this.want = name;
    if (this.ac && this.playing && name !== this.current) this.play(name);
  }

  // The crowd is arcade-style: square-wave voices and NES-style noise
  // claps, short and light. Nothing plays under the game between reactions.
  setCrowd(on) {
    this.crowdOn = on;
  }

  // The crowd's constant presence under play: a soft, filtered rumble of
  // stepped noise (the stands talking) that swells with the excitement
  // level k (0 quiet .. 1 roaring), with now and then a voice calling out.
  // Silent off the court (k = 0).
  crowdBed(k) {
    if (!this.ac || this.ac.state !== 'running') return;
    if (!this.bed) {
      const src = this.ac.createBufferSource();
      src.buffer = this.chipNoise;
      src.loop = true;
      const bp = this.ac.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 520;
      bp.Q.value = 0.7;
      const g = this.ac.createGain();
      g.gain.value = 0;
      src.connect(bp);
      bp.connect(g);
      g.connect(this.sfxG);
      src.start();
      this.bed = { g, bp, k: 0, call: 0 };
    }
    const b = this.bed;
    const want = k <= 0 ? 0 : 0.018 + 0.05 * Math.min(1, k);
    if (Math.abs(want - b.k) > 0.002) {
      const t = this.ac.currentTime;
      b.g.gain.cancelScheduledValues(t);
      b.g.gain.setTargetAtTime(want, t, 0.25);
      b.bp.frequency.setTargetAtTime(480 + 420 * Math.min(1, k), t, 0.3);
      b.k = want;
    }
    // A voice from the stands now and then, more often as it gets louder.
    const now = this.ac.currentTime;
    if (k > 0 && now > b.call) {
      b.call = now + 1.6 + Math.random() * (4 - 2.4 * Math.min(1, k));
      const f = PENTA[Math.floor(Math.random() * PENTA.length)] * (Math.random() < 0.5 ? 1 : 2);
      this.tone(f, 0.06, 'square', 0.025 + 0.03 * Math.min(1, k));
      if (Math.random() < 0.5) this.tone(f * 1.25, 0.07, 'square', 0.025, { delay: 0.07 });
    }
  }

  // A clap, 8-bit style: a tick of stepped noise.
  chipClap(vol, delay) {
    const t = this.ac.currentTime + delay;
    const src = this.ac.createBufferSource();
    src.buffer = this.chipNoise;
    const g = this.ac.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
    src.connect(g);
    g.connect(this.out || this.sfxG);
    src.start(t, Math.random() * 0.4, 0.05);
  }

  // Drop the music under a crowd roar for a moment, then bring it back.
  duck(dur) {
    if (!this.musicDuck) return;
    const g = this.musicDuck.gain;
    const t = this.ac.currentTime;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(DUCK, t + 0.12);
    g.setValueAtTime(DUCK, t + dur);
    g.linearRampToValueAtTime(1, t + dur + 0.8);
  }

  // How far the court's music has built, 0 (mellow) to 1 (full power).
  setBuild(k, now = false) {
    k = Math.max(0, Math.min(1, k));
    if (!now && this.build != null && (k === this.build || (Math.abs(k - this.build) < 0.01 && k > 0 && k < 1))) return;
    this.build = k;
    if (!this.ac) return;
    const t = this.ac.currentTime;
    const ease = now ? 0.01 : 0.6;
    const cut = BUILD.cutFrom * Math.pow(BUILD.cutTo / BUILD.cutFrom, k);
    this.musicLP.frequency.setTargetAtTime(cut, t, ease);
    this.musicBass.gain.setTargetAtTime(BUILD.bassFrom + (BUILD.bassTo - BUILD.bassFrom) * k * k, t, ease);
    this.musicLift.gain.setTargetAtTime(BUILD.gainFrom + (1 - BUILD.gainFrom) * k, t, ease);
  }

  // Speed the music up a little (Power Rush) or back to normal.
  setRate(rate) {
    if (this.rate === rate) return;
    this.rate = rate;
    if (this.voice && this.ac) this.voice.src.playbackRate.setTargetAtTime(rate, this.ac.currentTime, 0.3);
  }

  unlock() {
    if (!this.ac) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ac = new AC();
      this.master = this.ac.createGain();
      this.musicG = this.ac.createGain();
      this.sfxG = this.ac.createGain();
      // The court's build-up: music starts mellow (high notes muffled, bass
      // light) and opens out with heavy bass as the court is cleared.
      this.musicLP = this.ac.createBiquadFilter();
      this.musicLP.type = 'lowpass';
      this.musicLP.Q.value = 0.9;
      this.musicBass = this.ac.createBiquadFilter();
      this.musicBass.type = 'lowshelf';
      this.musicBass.frequency.value = 140;
      this.musicLift = this.ac.createGain();
      this.musicG.connect(this.musicBass);
      this.musicBass.connect(this.musicLP);
      this.musicLP.connect(this.musicLift);
      this.musicDuck = this.ac.createGain();
      this.musicLift.connect(this.musicDuck);
      this.musicDuck.connect(this.master);
      this.sfxG.connect(this.master);

      this.master.connect(this.ac.destination);
      const len = this.ac.sampleRate * 0.5;
      this.noiseBuf = this.ac.createBuffer(1, len, this.ac.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.apply();
      this.setBuild(this.build ?? 1, true);
      // Stepped noise (each value held for 16 samples): the NES noise channel.
      const cl = this.ac.sampleRate * 0.5;
      this.chipNoise = this.ac.createBuffer(1, cl, this.ac.sampleRate);
      const cd = this.chipNoise.getChannelData(0);
      for (let i = 0, v = 0; i < cl; i++) {
        if (i % 16 === 0) v = Math.random() > 0.5 ? 0.8 : -0.8;
        cd[i] = v;
      }
    }
    // 'suspended' is the normal locked state; iOS also uses 'interrupted' after a call or alarm.
    if (this.ac.state !== 'running' && !this.held) this.ac.resume().catch(() => {});
    this.keepAwake();
    this.startMusic();
  }

  // iPhones and iPads silence Web Audio while the ring/silent switch is on
  // silent. Playing an (inaudible) media element alongside it moves the page
  // into the "playback" audio category, which the switch does not mute.
  keepAwake() {
    if (this.settings.muted || this.held) return;
    if (!this.silent) {
      const n = 4000; // half a second of 8-bit silence at 8 kHz
      const wav = new Uint8Array(44 + n).fill(128);
      const head = new DataView(wav.buffer);
      const put = (at, str) => [...str].forEach((ch, i) => (wav[at + i] = ch.charCodeAt(0)));
      put(0, 'RIFF');
      head.setUint32(4, 36 + n, true);
      put(8, 'WAVEfmt ');
      head.setUint32(16, 16, true);
      head.setUint16(20, 1, true);
      head.setUint16(22, 1, true);
      head.setUint32(24, 8000, true);
      head.setUint32(28, 8000, true);
      head.setUint16(32, 1, true);
      head.setUint16(34, 8, true);
      put(36, 'data');
      head.setUint32(40, n, true);
      this.silent = new Audio(URL.createObjectURL(new Blob([wav], { type: 'audio/wav' })));
      this.silent.loop = true;
      this.silent.setAttribute('playsinline', '');
    }
    if (this.silent.paused) this.silent.play().catch(() => {});
  }

  apply() {
    if (!this.ac) return;
    const s = this.settings;
    const t = this.ac.currentTime;
    this.master.gain.setTargetAtTime(s.muted ? 0 : 1, t, 0.02);
    this.musicG.gain.setTargetAtTime(s.music * 0.5, t, 0.02);
    this.sfxG.gain.setTargetAtTime(s.sfx * 0.6, t, 0.02);
    if (this.silent && s.muted) this.silent.pause();
  }

  // Suspend while the tab is hidden.
  hold(on) {
    this.held = on;
    if (!this.ac) return;
    if (on) {
      this.ac.suspend();
      if (this.silent) this.silent.pause();
    } else {
      this.ac.resume().catch(() => {});
    }
  }

  tone(freq, dur, type, vol, o = {}) {
    const t = (o.at ?? this.ac.currentTime) + (o.delay || 0);
    const osc = this.ac.createOscillator();
    const g = this.ac.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + (o.attack || 0.005));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g);
    g.connect(o.out || this.out || this.sfxG);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  noise(dur, vol, cutoff, o = {}) {
    const t = (o.at ?? this.ac.currentTime) + (o.delay || 0);
    const src = this.ac.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = this.ac.createBiquadFilter();
    f.type = o.type || 'lowpass';
    f.frequency.value = cutoff;
    const g = this.ac.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f);
    f.connect(g);
    g.connect(o.out || this.out || this.sfxG);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  sfx(name, arg) {
    if (!this.ac || this.settings.muted || this.settings.sfx <= 0 || this.ac.state !== 'running') return;
    const T = (f, d, w, v, o) => this.tone(f, d, w, v, o);
    switch (name) {
      // Buttons, keys, tabs and toggles all click.
      case 'click':
      case 'confirm':
      case 'back':
      case 'key':
      case 'tab':
      case 'toggle':
        this.tone(660, 0.05, 'square', 0.12);
        break;
      case 'paddle':
        this.tone(196, 0.1, 'triangle', 0.5, { to: 330 });
        this.noise(0.04, 0.12, 1800);
        break;
      case 'wall':
        this.tone(150, 0.05, 'triangle', 0.3);
        break;
      case 'hit':
        this.tone(300, 0.07, 'square', 0.14, { to: 220 });
        break;
      case 'break': {
        const f = 420 * Math.pow(1.06, Math.min(arg || 1, 12));
        this.tone(f, 0.11, 'square', 0.14, { to: f * 0.6 });
        this.noise(0.14, 0.3, 2600);
        break;
      }
      case 'land':
        this.noise(0.06, 0.1, 500);
        break;
      case 'drop':
        this.tone(880, 0.08, 'sine', 0.14, { to: 1320 });
        break;
      case 'power':
      case 'rush':
      case 'beat':
        [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.12, 'square', 0.12, { delay: i * 0.06 }));
        break;
      case 'shield':
        this.tone(988, 0.2, 'sine', 0.3, { to: 494 });
        break;
      case 'serve':
        this.tone(262, 0.1, 'triangle', 0.4, { to: 523 });
        break;
      case 'lost':
        this.tone(330, 0.45, 'sawtooth', 0.16, { to: 70 });
        break;
      case 'count':
        this.tone(440, 0.12, 'square', 0.14);
        break;
      case 'go':
        this.tone(880, 0.25, 'square', 0.14);
        break;
      case 'win':
        [523, 659, 784, 1047, 1319].forEach((f, i) => this.tone(f, 0.22, 'square', 0.13, { delay: i * 0.11 }));
        break;

      // ---- the crowd, arcade-style
      case 'ooh':
        // A brick hit: one tiny voice from that side. A break chirps up
        // ("yay"), a crack dips ("ooh"); the note is picked from a pentatonic
        // scale so a string of them sounds like a tune.
        if (arg >= 1) {
          const f = PENTA[Math.floor(Math.random() * PENTA.length)] * 2;
          T(f, 0.05, 'square', 0.05);
          T(f * 1.5, 0.07, 'square', 0.05, { delay: 0.05 });
        } else {
          const f = PENTA[Math.floor(Math.random() * 3)];
          T(f, 0.12, 'triangle', 0.12, { to: f * 0.85 });
        }
        break;
      case 'clap':
        // A round of 8-bit applause on a beat, and a little "yay".
        for (let i = 0; i < 8; i++) this.chipClap(0.14 * (i % 2 ? 0.7 : 1), i * 0.075 + Math.random() * 0.012);
        T(784, 0.06, 'square', 0.06, { delay: 0.02 });
        T(1047, 0.09, 'square', 0.06, { delay: 0.09 });
        break;
      case 'cheer': {
        // The roar: a quick rising arpeggio, a trill at the top, a "HEY!"
        // chord stab and a burst of claps. Bigger moments climb higher.
        const big = Math.min(arg || 1, 3);
        const notes = [523, 659, 784, 1047, 1319, 1568].slice(0, 3 + big);
        notes.forEach((f, i) => T(f, 0.07, 'square', 0.1, { delay: i * 0.055 }));
        const top = notes[notes.length - 1];
        const at = notes.length * 0.055;
        for (let i = 0; i < 4 + big * 2; i++) T(i % 2 ? top : top * 0.84, 0.045, 'square', 0.07, { delay: at + i * 0.045 });
        const hey = at + (4 + big * 2) * 0.045;
        [top / 2, (top / 2) * 1.26, (top / 2) * 1.5].forEach((f) => T(f, 0.16, 'square', 0.045, { delay: hey }));
        for (let i = 0; i < 6 + big * 4; i++) this.chipClap(0.08, hey + i * 0.06 + Math.random() * 0.02);
        this.duck(hey + 0.4);
        break;
      }
      case 'gasp':
        // A save off the edge of the racket: a quick rising "ooooh!" and a few claps.
        T(330, 0.22, 'triangle', 0.1, { to: 660 });
        T(494, 0.18, 'square', 0.04, { delay: 0.05, to: 988 });
        for (let i = 0; i < 4; i++) this.chipClap(0.07, 0.25 + i * 0.07);
        break;
      case 'roar':
        // Multiball: the stands erupt, a long rising sweep under a burst of claps.
        T(220, 0.5, 'square', 0.06, { to: 880 });
        T(330, 0.5, 'square', 0.045, { delay: 0.05, to: 1320 });
        for (let i = 0; i < 14; i++) this.chipClap(0.09, 0.1 + i * 0.045 + Math.random() * 0.02);
        this.duck(0.9);
        break;
      case 'chant': {
        // Power Rush: "HEY! (clap clap) HEY! (clap clap)", on the beat.
        const beats = Math.max(2, Math.round(arg || 4));
        for (let i = 0; i < beats; i++) {
          const at = i * 0.6;
          [392, 494, 587].forEach((f) => T(f, 0.12, 'square', 0.05, { delay: at }));
          this.chipClap(0.12, at + 0.3);
          this.chipClap(0.1, at + 0.45);
        }
        break;
      }
      case 'groan':
        // The arcade "wah wah wahhh".
        T(392, 0.16, 'square', 0.06);
        T(370, 0.16, 'square', 0.06, { delay: 0.18 });
        T(349, 0.45, 'square', 0.06, { delay: 0.36, to: 262 });
        this.duck(0.8);
        break;
      case 'wave': {
        // The Mexican wave: a run of notes rising and falling with the crest
        // as it travels left to right round the stands.
        const len = arg || 3.6;
        const steps = Math.round(len / 0.12);
        const pan = this.ac.createStereoPanner ? this.ac.createStereoPanner() : null;
        if (pan) {
          const t = this.ac.currentTime;
          pan.pan.setValueAtTime(-0.8, t);
          pan.pan.linearRampToValueAtTime(0.8, t + len);
          pan.connect(this.sfxG);
          this.out = pan;
        }
        for (let i = 0; i < steps; i++) {
          const f = PENTA[i % PENTA.length] * (Math.floor(i / PENTA.length) % 2 ? 2 : 1);
          T(f * 2, 0.08, 'square', 0.06, { delay: i * 0.12 });
          if (i % 2 === 0) this.chipClap(0.08, i * 0.12 + 0.06);
        }
        this.out = null;
        break;
      }
      case 'over':
        [392, 330, 262, 196].forEach((f, i) => this.tone(f, 0.3, 'triangle', 0.3, { delay: i * 0.17 }));
        break;
    }
  }

  startMusic() {
    if (this.playing || !this.ac) return;
    this.playing = true;
    this.play(this.want);
    // Fetch the rest in the background so later changes are instant.
    for (const name in TRACKS) this.load(name);
  }

  load(name) {
    if (!this.loading[name]) {
      this.loading[name] = fetch(TRACKS[name])
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error('http ' + r.status))))
        .then((data) => new Promise((ok, bad) => this.ac.decodeAudioData(data, ok, bad)))
        .then((buf) => (this.buffers[name] = { buf, ...loopPoints(buf) }))
        .catch(() => {
          delete this.loading[name]; // try again next time it is asked for
          return null;
        });
    }
    return this.loading[name];
  }

  async play(name) {
    const track = this.buffers[name] || (await this.load(name));
    if (!track || name !== this.want || name === this.current || !this.ac) return;
    const t = this.ac.currentTime;
    if (this.voice) {
      const old = this.voice;
      old.g.gain.cancelScheduledValues(t);
      old.g.gain.setValueAtTime(old.g.gain.value, t);
      old.g.gain.linearRampToValueAtTime(0, t + XFADE);
      old.src.stop(t + XFADE + 0.05);
    }
    const src = this.ac.createBufferSource();
    src.buffer = track.buf;
    src.loop = true;
    src.loopStart = track.start;
    src.loopEnd = track.end;
    src.playbackRate.value = this.rate || 1;
    const g = this.ac.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(TRACK_GAIN, t + (this.voice ? XFADE : 0.4));
    src.connect(g);
    g.connect(this.musicG);
    src.start(t, track.start);
    this.voice = { src, g, name };
    this.current = name;
  }
}

// AAC files carry a little encoder silence at each end; loop between the
// first and last audible samples so the loop has no gap.
function loopPoints(buf) {
  const d = buf.getChannelData(0);
  const quiet = 0.0008;
  const most = Math.round(buf.sampleRate * 0.08); // encoder padding only, never a musical rest
  let a = 0;
  while (a < most && Math.abs(d[a]) < quiet) a++;
  let b = d.length - 1;
  while (b > d.length - 1 - most && Math.abs(d[b]) < quiet) b--;
  if (b - a < buf.sampleRate) return { start: 0, end: buf.duration };
  return { start: a / buf.sampleRate, end: (b + 1) / buf.sampleRate };
}
