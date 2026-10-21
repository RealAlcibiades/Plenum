/*
 * music.js: the generative soundtrack and effect cues for Muse Console, taken from the Stomper dashboard's sound engine.
 * Twelve styles, chosen with setStyle(key): 'synth' (the original: upbeat synthwave with a dark neon edge, 104-112 bpm),
 * 'techno' (128-132 bpm, four-on-the-floor kick, offbeat open hats, a rolling eighth-note bass), and ten more read from
 * the STY table (darksynth, trance, dubstep, liquid drum and bass, future bass, vaporwave, ambient drone, glitch IDM,
 * industrial EBM, italo disco). A change of style takes effect at the next bar; nothing that is playing is stopped.
 * Nothing is sampled, fetched or quoted: drums, bass, arpeggio, lead and pads are synthesised here and composed by rule
 * (weighted sections, minor-key progressions, generated hooks, key changes), so it never loops.
 *
 *   voices -> layer buses -> music faders (dry + reverb) --+
 *   effects -------------> fx fader (dry + reverb) --------+-> limiter -> master -> speakers
 *
 * Pads, bass, arp, lead, hats and snare are long-lived oscillators (and one noise loop) whose
 * pitch and gain are automated per note, so sixteenth notes cost no nodes. Only kicks, toms,
 * impacts and effects create nodes, and those are unplugged when they end.
 * Harmony rule: every pitched voice plays a tone of the bar's chord; the lead may add scale
 * notes that are not a semitone from a chord tone. So no two voices ever sit a semitone apart.
 *
 * API: window.MuseMusic (bottom). Nothing plays until setOn(true) runs from a click. No method throws.
 * Volumes are 0..1 slider positions; the gain applied is the square. Without Web Audio every call is a silent no-op.
 * It touches no page elements, storage or network.
 */
(function () {
  'use strict';
  var AC = window.AudioContext || window.webkitAudioContext;

  var AHEAD = 5;    // seconds kept scheduled (background tabs tick about once a second)
  var TICK = 250;   // ms between scheduler runs
  var MASTER = 0.6; // ceiling after the limiter

  var SCALES = [[0, 2, 3, 5, 7, 8, 10], [0, 2, 3, 5, 7, 8, 11], [0, 1, 3, 5, 7, 8, 10]]; // natural, harmonic, phrygian minor
  // Chords: [root above the tonic, then third, fifth and colour note above that root, scale].
  var CH = [[0, 3, 7, 10, 0], [3, 4, 7, 14, 0], [5, 3, 7, 10, 0], [7, 3, 7, 10, 0], [8, 4, 7, 14, 0], [10, 4, 7, 14, 0], // i III iv v VI VII
    [7, 4, 7, 10, 1], [1, 4, 7, 14, 2], [2, 3, 6, 10, 0]]; // V7, bII, ii dim
  var PROGS = [[0, 4, 1, 5], [0, 2, 4, 6], [0, 5, 4, 5], [0, 1, 5, 2], [4, 5, 0, 0], [0, 3, 4, 5], [0, 4, 2, 3], [2, 4, 0, 5], [0, 0, 4, 5], [4, 1, 5, 0],
    [0, 7, 0, 5], [0, 2, 8, 6], [0, 3, 2, 6], [0, 4, 7, 6]];
  var DARK = 10; // progressions from here on are the dark ones (danger)
  // Sections: [energy, bars per chord, chance of a lead, then: next section, weight, ...]. 'ease' is the breakdown.
  var KINDS = {
    intro: [0.45, 2, 0, 'groove', 3, 'lift', 1],
    groove: [0.72, 1, 0.5, 'groove', 1, 'lift', 3, 'drop', 2, 'ease', 1.5],
    lift: [0.86, 1, 0.5, 'drop', 5, 'groove', 1],
    drop: [1, 1, 0.85, 'drop', 1.2, 'ease', 3, 'groove', 2.5],
    ease: [0.3, 2, 0.6, 'lift', 3, 'drop', 2, 'groove', 2]
  };
  var PLANS = [[1, 2, 1, 2], [1, 0, 2, 0], [1, 1, 2, 0], [0, 1, 0, 2], [1, 2, 0, 0]]; // lead per bar: 1 phrase, 2 answer, 0 rest
  var STABS = [[0, 3, 6, 8, 11, 14], [0, 6, 8, 14], [2, 6, 10, 14], [0, 3, 8, 11]];   // pad rhythms, in sixteenths
  var LONG = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 2, 0];                        // the quiet bass line

  // The styles, in the order the menu lists them. lo..hi: tempo in beats a minute, step 2. Styles 0 and 1 keep their own
  // code in bar(). The rest are patterns of 16 sixteenths a bar: kick 'k', snare 's', hat g ghost, m mid, c closed, o open,
  // '.' none; bass 1 root, 2 octave, 3 fifth, '.' rest. pad: pad level; pump: how hard kicks duck the pads; kt: kick length.
  // arp, lead, stab, wob, bell, clap: on/off. drone: no drums, long pads and chimes. glitch: a new random drum grid every bar.
  var STY = [
    { key: 'synth', name: 'Synthwave', lo: 104, hi: 112 },
    { key: 'techno', name: 'Techno', lo: 128, hi: 132 },
    { key: 'dark', name: 'Darksynth', lo: 108, hi: 116, kick: 'k..k..k...k..k..', snare: '....s.......s...', hat: 'c.c.c.c.c.c.c.c.',
      bass: '1.1.1..1.1.2.1.1', arp: true, lead: true, pad: 0.6, pump: 0.6, kt: 0.09 },
    { key: 'trance', name: 'Trance', lo: 136, hi: 140, kick: 'k...k...k...k...', snare: '....s.......s...', hat: '..o...o...o...o.',
      bass: '.1.1.1.1.1.1.1.1', arp: true, lead: true, pad: 1, pump: 1.2, kt: 0.08 },
    { key: 'dub', name: 'Dubstep', lo: 140, hi: 140, kick: 'k.........k.....', snare: '........s.......', hat: '....m.......m...',
      bass: '1.1.1.1.1.1.1.1.', wob: true, pad: 0.4, pump: 0.3, kt: 0.2 },
    { key: 'dnb', name: 'Liquid drum & bass', lo: 170, hi: 174, kick: 'k.........k.....', snare: '....s.......s.s.', hat: 'cgcgcgcgcgcgcgcg',
      bass: '1..1..1...1..1..', lead: true, pad: 0.8, pump: 0.4, kt: 0.07 },
    { key: 'future', name: 'Future bass', lo: 148, hi: 152, kick: 'k.......k.......', snare: '....s.......s...', hat: '..c...c...c...c.',
      bass: '1...1...1...1...', stab: true, lead: true, pad: 0.9, pump: 1.3, kt: 0.1 },
    { key: 'vapor', name: 'Vaporwave', lo: 80, hi: 86, kick: 'k.......k.......', snare: '........s.......', hat: '..g...g...g...g.',
      bass: '1.......3.......', lead: true, pad: 1, pump: 0.5, kt: 0.14 },
    { key: 'drone', name: 'Ambient drone', lo: 52, hi: 58, kick: '................', snare: '................', hat: '................',
      bass: '................', pad: 1, pump: 0, bell: true, drone: true },
    { key: 'idm', name: 'Glitch IDM', lo: 118, hi: 126, bass: '1..1.....1..2...', glitch: true, bell: true, pad: 0.6, pump: 0.5, kt: 0.06 },
    { key: 'ebm', name: 'Industrial EBM', lo: 124, hi: 130, kick: 'k...k...k...k...', snare: '....s.......s...', hat: 'c.c.c.c.c.c.c.c.',
      bass: '1112111211121112', pad: 0.3, pump: 0.8, kt: 0.06 },
    { key: 'italo', name: 'Italo disco', lo: 118, hi: 124, kick: 'k...k...k...k...', snare: '....s.......s...', hat: '..o...o...o...o.',
      bass: '1.2.1.2.1.2.1.2.', arp: true, lead: true, clap: true, pad: 0.6, pump: 1, kt: 0.09 }
  ];
  var KEYS = STY.map(function (p) { return p.key; });
  var HV = { c: 0.8, m: 0.55, g: 0.3, o: 0.9 };         // hat grades: closed, mid, ghost, open
  var GK = [[0, 6, 12], [0, 3, 9], [0, 6, 10], [0, 10, 13]]; // glitch kick grids (steps)
  var GS = [[4, 12, 14], [3, 9, 12], [2, 6, 12]];            // glitch snare grids (steps)
  function steps(str, ch) { var a = [], i; for (i = 0; i < str.length; i++) if (str.charAt(i) === ch) a.push(i); return a; }
  STY.forEach(function (p) { // read each pattern once: lists of steps, the bass notes, and the defaults
    p.kickA = steps(p.kick || '', 'k'); p.snareA = steps(p.snare || '', 's');
    p.bassA = (p.bass || '').split('').map(function (c) { return +c || 0; });
    p.hat = p.hat || ''; p.pad = p.pad == null ? 1 : p.pad; p.pump = p.pump == null ? 1 : p.pump; p.kt = p.kt || 0.08;
  });

  var ctx, comp, out, ana, mDry, mWet, fxBus, echoIn, dA, dB, duck; // dA, dB: the echo's two delay lines (their time follows the style)
  var kickBus, snrBus, hatBus, drumBus, bassM, grit, dng, tone; // set by mood (drumBus is fixed)
  var pads, padV, bassO, bassF, bassV, arpO, arpF, arpV, leadO, leadV, vib, swl, hatV, snV, snO, stV, rzF, rzV; // the band
  var on = false, want = false, timer, offTimer, vol = 0.75, fxVol = 0.75, fxOn = true;
  var style = 0, wantStyle = 0; // an index into STY: the one playing, and the one asked for (applied at a bar)
  function pickS() { var p = STY[style], n = (p.hi - p.lo) / 2 + 1; return 15 / (p.lo + 2 * Math.floor(rnd() * n)); } // a sixteenth
  var ti = 0, td = 0, mi = 0, md = 0, sentI, sentD, lastT; // mood: asked for (t), heard (m), applied (sent)
  var S, BAR, key, sec, pi, nextBar;
  var tl;     // chords by start time, so effects can play in key
  var live;   // scheduled one-shot voices: { t: end time, n: nodes to unplug then }
  var fd;     // the master fade in progress
  var fxLast; // when each effect last played

  // ---- helpers
  function nop() {}
  function rnd() { return Math.random(); }
  function pick(a) { return a[Math.floor(rnd() * a.length)]; }
  function wpick(a, i) { // from a[i] on: item, weight, item, weight, ...
    var sum = 0, k, x;
    for (k = i + 1; k < a.length; k += 2) sum += a[k];
    x = rnd() * sum;
    for (k = i; k < a.length - 2 && (x -= a[k + 1]) > 0; k += 2) {}
    return a[k];
  }
  function hz(m) { return 440 * Math.pow(2, (m - 69) / 12); } // MIDI note -> Hz
  function fold(m, lo) { return lo + (((m - lo) % 12) + 12) % 12; } // the same note inside the octave that starts at lo
  function unit(v, old) { // any input -> 0..1, or the old value when it is not a number
    if (typeof v === 'string' && v.trim() !== '') v = Number(v);
    return typeof v === 'number' && v === v ? Math.min(1, Math.max(0, v)) : old;
  }
  function ease(v, to, k) { v += (to - v) * k; return Math.abs(to - v) < 0.004 ? to : v; }
  function gain(v) { var g = ctx.createGain(); g.gain.value = v; return g; }
  function link() { for (var i = 1; i < arguments.length; i++) arguments[i - 1].connect(arguments[i]); }
  function filter(type, f, q) {
    var b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b;
  }
  function osc(type, f, t0, t1) { // without t1 it runs for the life of the page
    var o = ctx.createOscillator(); o.type = type; o.frequency.value = f; o.start(t0);
    if (t1) o.stop(t1);
    return o;
  }
  function pan(v) {
    if (!ctx.createStereoPanner) return gain(1);
    var p = ctx.createStereoPanner(); p.pan.value = v; return p;
  }
  function env(p, t, att, peak, hold, tc) { // silence -> peak over att, hold, then die away
    p.setValueAtTime(0, t); p.linearRampToValueAtTime(peak, t + att); p.setTargetAtTime(0, t + att + hold, tc);
  }
  function hit(p, t, v, hold, tc) { // one note on a long-lived gain: snap to v, hold, die away
    p.setTargetAtTime(v, t, 0.002); p.setTargetAtTime(0, t + 0.008 + hold, tc);
  }
  function tune(oscs, m, t, glide) { // retune long-lived oscillators to MIDI note m (phase stays continuous: no click)
    oscs.forEach(function (o) { if (glide) o.frequency.setTargetAtTime(hz(m), t, glide); else o.frequency.setValueAtTime(hz(m), t); });
  }
  function keep(end, nodes) { live.push({ t: end, n: nodes }); }
  function sweep(now) { // sources stop on schedule; here their nodes are unplugged
    live = live.filter(function (v) {
      if (v.t > now) return true;
      v.n.forEach(function (n) { try { n.disconnect(); } catch (e) {} });
      return false;
    });
  }
  function bus(level, dry, wet, echo) { // one layer: an input split into dry / reverb / echo
    var g = gain(level);
    link(g, gain(dry), mDry);
    if (wet) link(g, gain(wet), mWet);
    if (echo) link(g, gain(echo), echoIn);
    return g;
  }
  function noise(secs, fn) { // stereo buffer; each sample is fn(position 0..1, previous sample)
    var n = Math.floor(ctx.sampleRate * secs), b = ctx.createBuffer(2, n, ctx.sampleRate), c, d, i, y;
    for (c = 0; c < 2; c++) for (d = b.getChannelData(c), y = i = 0; i < n; i++) d[i] = y = fn(i / n, y);
    return b;
  }
  function saws(n, cents, dest) { // n sawtooth oscillators spread by cents, all into dest
    var a = [], i, o;
    for (i = 0; i < n; i++) { o = osc('sawtooth', 220, 0); o.detune.value = cents * (i * 2 - n + 1); o.connect(dest); a.push(o); }
    return a;
  }

  // ---- the fixed graph
  function build() {
    ctx = new AC();
    live = []; tl = []; fxLast = {}; fd = { a: 0, b: 0, t0: 0, t1: 0 };
    nextBar = lastT = 0; sentI = sentD = pi = -1; sec = null;
    style = wantStyle; S = pickS(); BAR = S * 16; // a sixteenth and a bar: 104..112 bpm (synth) or 128..132 (techno)
    key = 33 + Math.floor(rnd() * 12); // the tonic as the bass plays it: MIDI A1..G#2

    comp = ctx.createDynamicsCompressor(); // a limiter (default ratio 12:1, 3 ms attack)
    comp.threshold.value = -16; comp.knee.value = 10;
    out = gain(0);
    ana = ctx.createAnalyser();
    link(comp, out, ctx.destination); out.connect(ana);

    // reverb: a wide dark hall from decaying noise whose tail loses its highs
    var verb = ctx.createConvolver(), verbIn = filter('highpass', 240, 0);
    verb.buffer = noise(3.4, function (x, y) {
      return y + ((rnd() * 2 - 1) * Math.pow(1 - x, 3) - y) * (0.6 - 0.45 * x);
    });
    link(verbIn, verb, gain(1.25), comp);

    mDry = gain(vol * vol); mWet = gain(vol * vol); fxBus = gain(fxOn ? fxVol * fxVol : 0);
    mDry.connect(comp); mWet.connect(verbIn);
    fxBus.connect(comp); link(fxBus, gain(0.2), verbIn);

    // echo: dotted-eighth ping-pong, every bounce duller and quieter
    echoIn = gain(1);
    dA = ctx.createDelay(1); dB = ctx.createDelay(1);
    var lp = filter('lowpass', 2600, 0);
    dA.delayTime.value = dB.delayTime.value = S * 3;
    link(echoIn, dA, lp, gain(0.55), dB, gain(0.55), dA);
    link(lp, pan(-0.7), gain(0.6), mDry); link(dB, pan(0.7), gain(0.9), mDry); link(lp, gain(0.3), mWet);

    // the pump: pads, bass and swell pass through one gain that every kick pushes down
    duck = gain(1); duck.connect(mDry);

    // pads: four notes, each a saw left and a saw right; intensity opens the low-pass
    tone = filter('lowpass', 1000, 0); padV = gain(0);
    link(tone, padV, gain(0.9), duck); link(padV, gain(0.5), mWet);
    var sides = [-1, 1].map(function (x) { var g = gain(0.027); link(g, pan(x * 0.6), tone); return g; });
    pads = [5, 7, 9, 11].map(function (c) {
      return sides.map(function (g, j) { var o = osc('sawtooth', 220, 0); o.detune.value = j ? c : -c; o.connect(g); return o; });
    });

    // bass: saw (plus a square that danger mixes in) through a low-pass that snaps open on every note
    bassF = filter('lowpass', 400, 3); bassV = gain(0); bassM = gain(0.075); grit = gain(0);
    bassO = [osc('sawtooth', 55, 0), osc('square', 55, 0)];
    bassO[1].detune.value = 9;
    bassO[0].connect(bassF); link(bassO[1], grit, bassF); link(bassF, bassV, bassM, duck);

    // danger swell: two low saws beating slowly on the chord's root, silent until there is real drawdown
    dng = gain(0);
    var dark = filter('lowpass', 240, 0), sw = gain(0.6);
    link(osc('sine', 0.07, 0), gain(0.4), sw.gain);
    swl = saws(2, 14, dark);
    link(dark, sw, dng, duck);

    // arp: a pluck through the echo
    arpF = filter('lowpass', 900, 5); arpV = gain(0);
    arpO = [osc('sawtooth', 440, 0), osc('square', 440, 0)];
    arpO[1].detune.value = -8;
    arpO[0].connect(arpF); link(arpO[1], gain(0.4), arpF); link(arpF, arpV, bus(0.07, 0.8, 0.3, 0.3));

    // lead: two saws with late vibrato
    var leadF = filter('lowpass', 2300, 2);
    leadV = gain(0); vib = gain(0);
    link(osc('sine', 5.6, 0), vib);
    leadO = saws(2, 6, leadF);
    leadO.forEach(function (o) { vib.connect(o.detune); });
    link(leadF, leadV, bus(0.07, 0.6, 0.45, 0.35));

    // drums: one white-noise loop gated into hats, snare and risers; the snare has a tuned body
    kickBus = bus(0, 1, 0, 0); snrBus = bus(0.06, 0.8, 0.45, 0); hatBus = bus(0.026, 1, 0.1, 0); drumBus = bus(1, 0.7, 0.5, 0);
    var nz = ctx.createBufferSource();
    nz.buffer = noise(2.5, function () { return rnd() * 2 - 1; });
    nz.loop = true; nz.start(0);
    hatV = gain(0); snV = gain(0); stV = gain(0); rzV = gain(0);
    link(nz, filter('highpass', 7000, 0), hatV, hatBus);
    link(nz, filter('bandpass', 2600, 0.5), snV, snrBus);
    snO = [osc('triangle', 180, 0)];
    link(snO[0], stV, gain(0.7), snrBus);
    rzF = filter('bandpass', 500, 1.2);
    link(nz, rzF, rzV, gain(0.06), drumBus);

    ctx.onstatechange = wake;
  }

  // ---- one-shot voices
  // Kick, toms and impacts: a triangle falling in pitch.
  function thump(t, f0, f1, peak, tc, dest) {
    var end = t + tc * 5 + 0.05, o = osc('triangle', f0, t, end), g = gain(0);
    o.frequency.setValueAtTime(f0, t); o.frequency.setTargetAtTime(f1, t, 0.03);
    env(g.gain, t, 0.002, peak, 0.02, tc);
    link(o, g, dest); keep(end, [o, g]);
  }
  // Every kick ducks the pads and bass a moment early and lets them swell back before the offbeat.
  function pump(t, depth) {
    duck.gain.setTargetAtTime(1 - depth, t - 0.012, 0.004); duck.gain.setTargetAtTime(1, t + 0.03, 0.085);
  }
  function snare(t, v, root, clap) {
    if (clap) { hit(snV.gain, t - 0.022, v * 0.6, 0, 0.006); hit(snV.gain, t - 0.011, v * 0.7, 0, 0.006); }
    hit(snV.gain, t, v, clap ? 0.03 : 0.015, clap ? 0.09 : 0.06);
    snO[0].frequency.setValueAtTime(hz(root + 18), t); tune(snO, root + 12, t, 0.025); // body drops onto the chord's root
    hit(stV.gain, t, clap ? v * 0.4 : v, 0.01, 0.045);
  }

  // ---- composer
  function punch(m) { m = Math.min(1, Math.max(0, (m - 0.08) / 0.4)); return m * m * (3 - 2 * m); } // how much kick a mood gets

  function arpLine() { // 16 steps on a ladder of chord tones (0..7), -1 = rest; cycles of 3..8 steps roll across the bar
    var n = pick([3, 4, 4, 6, 8, 8]), shape = pick([0, 1, 2, 3]), gap = pick([0, 0, 3, 7]), dice = [], a = [], s, j;
    for (j = 0; j < n; j++) dice.push(Math.floor(rnd() * 6));
    for (s = 0; s < 16; s++) {
      j = s % n;
      a.push(gap && s % 8 === gap ? -1 : shape === 0 ? j : shape === 1 ? n - 1 - j : shape === 2 ? (j < n / 2 ? j * 2 : (n - j) * 2 - 1) : dice[j]);
    }
    return a;
  }

  function bassLine(dense) { // 16 steps: 0 rest, 1 root, 2 the octave above, 3 the fifth
    var off = rnd() < 0.3, a = [], s; // 'off' leaves the beats to the kick
    for (s = 0; s < 16; s++) a.push(s % 4 === 0 ? (off ? 0 : 1) : (dense || s % 2 === 0) && rnd() < 0.85 ? (s % 4 > 1 && rnd() < 0.35 ? 2 : 1) : 0);
    if (dense) a[rnd() < 0.5 ? 14 : 15] = pick([2, 3]);
    return a;
  }

  function motif() { // a one-bar phrase: [step, length in steps, offset on the chord's note ladder]
    var m = [], s = pick([0, 0, 2]), d = 0, n;
    while (s < 13) {
      n = Math.min(pick([2, 2, 3, 3, 4, 6]), 16 - s);
      m.push([s, n, d]);
      s += n + (rnd() < 0.2 ? 2 : 0);
      d = Math.max(-3, Math.min(4, d + pick([-2, -1, -1, 1, 1, 2])));
    }
    return m;
  }
  function vary(m) { // the answer: same rhythm, new ending
    return m.map(function (n, k) { return k < m.length - 2 ? n : [n[0], n[1], n[2] + pick([-2, -1, 1, 2])]; });
  }

  function section() {
    var k = sec ? sec.next : 'intro', K = KINDS[k], nx = wpick(K, 3), m = motif();
    if (sec && rnd() < 0.2) key = 33 + (key - 33 + pick([5, 7, 3, 10, 2, 8])) % 12; // now and then a new key
    sec = {
      k: k, i: 0, next: nx, n: k === 'drop' ? pick([8, 8, 16]) : k === 'groove' || k === 'ease' ? 8 : pick([4, 8]),
      hit: !!sec && (sec.rise || k === 'drop'),                    // impact on the first downbeat
      rise: nx === 'drop' || KINDS[nx][0] > K[0] || rnd() < 0.4,   // riser and swell through the last bar
      arp: rnd() < 0.9 ? arpLine() : null, b8: bassLine(0), b16: bassLine(1),
      stab: (K[0] > 0.6 && rnd() < 0.45) || (style > 1 && STY[style].stab) ? pick(STABS) : null,
      plan: rnd() < K[2] ? pick(PLANS) : [0, 0, 0, 0], call: m, ans: m, mid: 69 + Math.floor(rnd() * 6),
      half: [0, pick([6, 10, 11])], four: [0, 4, 8, 12].concat(rnd() < 0.5 ? pick([7, 10, 14, 15]) : []),
      gs: pick([7, 15, 10, -1]), clap: rnd() < 0.4, open: rnd() < 0.5
    };
  }

  function progression(i, d) { // every four chords: stay or move on; danger pulls towards the dark ones
    var w = [], k;
    if (pi >= 0 && rnd() > (i ? 0.3 : 0.6) && !(rnd() < 0.8 && pi >= DARK !== d > 0.5)) return;
    for (k = 0; k < PROGS.length; k++) w.push(k, k === pi ? 0 : k < DARK ? 1 - 0.8 * d : 0.05 + 2.5 * d);
    pi = wpick(w, 0);
  }

  // Lead: the phrase is laid on a ladder of notes that fit the chord; long and final notes rest on chord tones.
  function lead(t, notes, tones, ok) {
    var lad = [], a = 0, n;
    for (n = 62; n < 86; n++) if (ok.indexOf(n % 12) >= 0) lad.push(n); // D4..C#6: bright, never shrill
    function chordal(k) { // nearest step of the ladder that is a chord tone
      for (var j = 0; j < lad.length; j++) {
        if (tones.indexOf(lad[k + j] % 12) >= 0) return k + j;
        if (tones.indexOf(lad[k - j] % 12) >= 0) return k - j;
      }
      return k;
    }
    while (lad[a] < sec.mid) a++;
    a = chordal(a);
    notes.forEach(function (q, j) {
      var k = Math.max(0, Math.min(lad.length - 1, a + q[2])), at = t + q[0] * S, g = leadV.gain;
      if (q[1] > 3 || j === notes.length - 1) k = chordal(k);
      tune(leadO, lad[k], at, j && 0.02); // glide into every note but the first
      // release early and fast: a note that ends on the bar line must be silent before the next chord starts
      g.setTargetAtTime(1, at, 0.008); g.setTargetAtTime(0.6, at + 0.05, 0.12); g.setTargetAtTime(0, at + q[1] * S - 0.07, 0.015);
      vib.gain.setTargetAtTime(0, at, 0.01);
      if (q[1] > 3) vib.gain.setTargetAtTime(8, at + 0.2, 0.1); // cents, on long notes only
    });
  }

  function bar(t) {
    var look = Math.exp((ctx.currentTime - t) / 2), m = ti + (mi - ti) * look, d = td + (md - td) * look; // the mood this bar will be heard in
    if (wantStyle !== style) { // a new style starts at this bar: the bars already scheduled keep their timing
      style = wantStyle; S = pickS(); BAR = S * 16;
      if (dA) { dA.delayTime.setTargetAtTime(S * 3, t, 0.05); dB.delayTime.setTargetAtTime(S * 3, t, 0.05); } // the echo keeps the new beat (a dotted eighth)
    }
    if (!sec || sec.i >= sec.n) section();
    var i = sec.i++, K = KINDS[sec.k], last = i === sec.n - 1, e = K[0] * (0.3 + 0.7 * m); // e: how hard this bar plays
    var P = STY[style], N = style > 1, drone = N && P.drone; // styles 2 and up are read from the STY table
    if (i % (4 * K[1]) === 0) progression(i, d);
    if (i % 4 === 0) sec.ans = vary(sec.call);
    var ch = CH[PROGS[pi][Math.floor(i / K[1]) % 4]], br = key + ch[0] - (key + ch[0] > 44 ? 12 : 0); // chord, bass root
    var tones = [0, 1, 2, 3].map(function (k) { return (br + (k && ch[k])) % 12; });
    var ok = SCALES[ch[4]].map(function (p) { return (key + p) % 12; }).filter(function (p) { // what a melody may play here
      return tones.every(function (c) { return (p - c + 12) % 12 !== 1 && (c - p + 12) % 12 !== 1; });
    });
    var cut = last && sec.next === 'drop' && e > 0.4 ? 14 : 16; // a breath before a drop
    var fill = !drone && e > 0.34 && i % 4 === 3 && (last || rnd() < 0.6) ? pick([1, 1, 2, 3]) : 0, fs = last ? 8 : 12; // 1 roll, 2 toms, 3 kick out
    var pg = padV.gain, pl = N ? P.pad : 1, s, at, x, n, c; // pl: the pad level of this style
    tl.push([t, br, ch, ok]);

    // pads and swell move to the new chord
    for (s = 0; s < 4; s++) tune(pads[s], s < 3 ? fold(br + (s && ch[s]), 55) : fold(br + ch[3], 62), t);
    tune(swl, br, t);
    if (last && sec.rise && !drone) { // reverse-style swell with a noise riser
      pg.setTargetAtTime(0.5 * pl, t, 0.05); pg.setValueAtTime(0.5 * pl, t + 0.3); pg.linearRampToValueAtTime(1.3 * pl, t + cut * S - 0.01);
      rzF.frequency.setValueAtTime(350, t); rzF.frequency.exponentialRampToValueAtTime(7000, t + BAR);
      rzV.gain.setValueAtTime(0.02, t); rzV.gain.linearRampToValueAtTime(0.25 + 0.55 * e, t + BAR - 0.03); rzV.gain.setTargetAtTime(0, t + BAR - 0.03, 0.01);
    } else if (sec.stab && e > 0.4 && (style < 2 || P.stab)) sec.stab.forEach(function (q) { hit(pg, t + q * S, 1.15 * pl, S * 1.4, 0.07); }); // a style without stabs drops them at once, even mid-section
    else pg.setTargetAtTime(pl, t, 0.12);
    if (cut < 16) pg.setTargetAtTime(0.1, t + cut * S, 0.02);
    if (!i && sec.hit && !drone) { rzF.frequency.setValueAtTime(6000, t); hit(rzV.gain, t, 0.3 + 0.6 * e, 0.05, 0.4); } // crash

    // bass
    var bp = style === 1 ? (e < 0.2 ? LONG : sec.b8) : style === 0 ? (e < 0.2 ? LONG : e < 0.55 ? sec.b8 : sec.b16) : drone ? [] : e < 0.2 ? LONG : P.bassA; // techno: a rolling eighth-note bass
    var wob = N && P.wob; // dubstep: the filter wubs on every eighth, so the per-note filter envelope is left out
    c = 260 + 700 * e + 250 * d;
    if (wob) for (s = 0; s < cut; s++) bassF.frequency.setTargetAtTime(s % 4 < 2 ? c * 5 : c * 0.9, t + s * S, 0.02);
    for (s = 0; s < cut; s++) if ((x = bp[s])) {
      for (n = 1; s + n < cut && !bp[s + n] && n < 8; n++) {} // steps to the next note
      at = t + s * S;
      tune(bassO, br + (x === 2 ? 12 : x === 3 ? ch[2] : 0), at);
      if (!wob) { bassF.frequency.setTargetAtTime(c * 4, at, 0.003); bassF.frequency.setTargetAtTime(c, at + 0.012, 0.07); }
      hit(bassV.gain, at, s % 4 ? 0.82 : 1, n * S * 0.55, 0.03);
    }

    // arp
    if (sec.arp && (!N || P.arp)) {
      var lad = tones.map(function (p) { return fold(p, 60); }).sort(function (a, b) { return a - b; });
      c = 600 + 1100 * e;
      for (s = 0; s < cut; s++) if ((x = sec.arp[s]) >= 0 && (e > 0.2 || s % 2 === 0)) {
        at = t + s * S;
        tune(arpO, lad[x % 4] + 12 * (x >> 2), at);
        arpF.frequency.setTargetAtTime(c * 3, at, 0.002); arpF.frequency.setTargetAtTime(c, at + 0.01, 0.045);
        hit(arpV.gain, at, s % 4 ? 0.7 : 1, S * 0.3, 0.07);
      }
    }

    // lead
    x = sec.plan[i % 4];
    if (x && cut === 16 && (!N || P.lead) && rnd() > 0.3 * d) lead(t, x === 1 ? sec.call : sec.ans, tones, ok);

    // bells: ambient and IDM drop a glassy chime on a chord tone now and then
    if (N && P.bell && rnd() < (drone ? 0.35 : 0.25)) bell(t + rnd() * BAR * 0.8, hz(fold(tones[Math.floor(rnd() * 4)], 72)), 0.07, drone ? 1.8 : 0.4);

    // hats and snare. Styles 2 and up: the grid from the table (a glitch bar draws a new one); the synthwave and techno loop is unchanged
    var glitch = N && P.glitch, kA = N ? (glitch ? pick(GK) : P.kickA) : [], sA = N ? (glitch ? pick(GS) : P.snareA) : [], hc;
    if (N) for (s = 0; s < cut; s++) {
      at = t + s * S; x = fill && s >= fs;
      hc = glitch ? (rnd() < 0.42 ? (rnd() < 0.6 ? 'g' : 'm') : '') : P.hat.charAt(s);
      if (e >= 0.1 && HV[hc]) hit(hatV.gain, at, HV[hc] * (0.85 + 0.3 * rnd()), hc === 'o' ? 0.06 : 0, hc === 'o' ? 0.05 : 0.02);
      if (x && fill === 1) snare(at, 0.35 + 0.65 * (s - fs) / (15 - fs), br, P.clap);
      else if (e >= 0.15 && sA.indexOf(s) >= 0) snare(at, e >= 0.55 ? 1 : 0.7, br, P.clap);
    } else for (s = 0; s < cut; s++) {
      at = t + s * S; x = fill && s >= fs;
      if (e >= 0.1 && (e >= 0.5 || s % 2 === 0 || style === 1)) {
        n = s % 4 === 2 && (sec.open || e > 0.75 || style === 1); // open hat on the offbeat (always, in techno)
        hit(hatV.gain, at, [0.7, 0.3, 1, 0.4][s % 4] * (0.85 + 0.3 * rnd()), n ? 0.06 : 0, n ? 0.05 : 0.02);
      }
      if (x && fill === 1) snare(at, 0.35 + 0.65 * (s - fs) / (15 - fs), br);
      else if (e >= 0.55 ? s % 8 === 4 : e >= 0.15 && s === 8) snare(at, e >= 0.55 ? 1 : 0.7, br, sec.clap);
      else if (s === sec.gs && e > 0.75) snare(at, 0.3, br);
    }
    [bassV, arpV, leadV, stV].forEach(function (v) { v.gain.setTargetAtTime(0, t + BAR - 0.05, 0.01); }); // nothing rings into the next chord

    // kick, toms, impact: the only nodes made per bar, so they come last (a failure here costs drum hits, never harmony)
    x = 0.3 + 0.4 * punch(m);
    // techno: four on the floor from a little energy up, the pump on every kick
    var kicks = N ? kA : style === 1 ? (e < 0.2 ? [] : [0, 4, 8, 12]) : e < 0.34 ? (K[0] > 0.5 ? [0, 4, 8, 12] : []) : e < 0.55 ? sec.half : sec.four;
    var pm = N ? P.pump : 1, kmin = N || style === 1 ? 0.2 : 0.34, kt = N ? P.kt : 0.08; // per style: how hard the pump ducks, the least energy for a kick, how long it rings
    kicks.forEach(function (q) {
      if (q >= cut || (fill === 3 && q >= fs)) return;
      pump(t + q * S, Math.min(0.9, x * pm));
      if (e >= kmin) thump(t + q * S, 215, 46, q % 4 ? 0.6 : 1, kt, kickBus);
    });
    if (fill === 2) for (s = fs; s < cut; s++) if (s > 11 || s % 2 === 0) {
      n = hz(br + [12 + ch[2], 12 + ch[1], 12, ch[2]][s % 4]);
      thump(t + s * S, n * 1.6, n, 0.14, 0.06, drumBus); // short tails, so the last tom does not sound into the next chord
    }
    if (!i && sec.hit && e >= 0.34 && !drone) thump(t, 120, 40, 0.1, 0.35, drumBus);
  }

  // Lookahead clock: runs every TICK ms and keeps AHEAD seconds of music scheduled.
  function tick() {
    try {
      if (!on) return;
      var now = ctx.currentTime, k = 1 - Math.exp(-Math.min(2, now - lastT) / 2);
      lastT = now;
      mi = ease(mi, ti, k); md = ease(md, td, k); // mood drifts over seconds, never switches
      if (Math.abs(mi - sentI) + Math.abs(md - sentD) > (mi === ti && md === td ? 0 : 0.01)) {
        sentI = mi; sentD = md;
        [[kickBus.gain, 0.19 * punch(mi)], [snrBus.gain, 0.06 + 0.07 * mi], [hatBus.gain, 0.026 + 0.022 * mi], [bassM.gain, 0.075 + 0.045 * mi],
          [grit.gain, 0.45 * md], [dng.gain, 0.055 * md], [tone.frequency, 1000 + 2600 * mi - 350 * md]
        ].forEach(function (p) { p[0].setTargetAtTime(p[1], now, 0.6); });
      }
      while (tl.length > 1 && tl[1][0] <= now) tl.shift();
      if (nextBar < now + 0.05) nextBar = now + 0.1; // clock stalled: carry on from here, no burst
      for (var n = 0; nextBar < now + AHEAD && n < 4; n++) { nextBar += BAR; bar(nextBar - BAR); }
      sweep(now);
    } catch (e) {}
  }

  // ---- transport
  function fade(to, secs) { // ramp the master from wherever it is (tracked here, never read back)
    var now = ctx.currentTime, g = out.gain;
    var v = now >= fd.t1 ? fd.b : fd.a + (fd.b - fd.a) * (now - fd.t0) / (fd.t1 - fd.t0);
    g.cancelScheduledValues(now); g.setValueAtTime(v, now); g.linearRampToValueAtTime(to, now + secs);
    fd = { a: v, b: to, t0: now, t1: now + secs };
  }

  function quiet(p) { if (p && p.catch) p.catch(nop); return p; }

  // Nudge a suspended or interrupted device (autoplay policy, phone call) while we should be playing.
  function wake() {
    try { if (ctx && want && ctx.state !== 'running') return quiet(ctx.resume()); } catch (e) {}
  }

  function start() {
    try {
      if (AC) {
        if (!ctx) build();
        want = true;
        clearTimeout(offTimer);
        var p = wake();
        if (!on) {
          fade(MASTER, 3);
          timer = setInterval(tick, TICK);
          on = true; lastT = ctx.currentTime;
          tick();
        }
        return new Promise(function (done) { // resolves when the device runs, or after 1.5 s anyway
          Promise.resolve(p).then(nop, nop).then(done); setTimeout(done, 1500);
        });
      }
    } catch (e) { // no usable audio: leave nothing half-built behind
      if (!on) { try { ctx.close(); } catch (e) {} ctx = ana = null; want = false; }
    }
    return Promise.resolve();
  }

  function stop() {
    try {
      want = false;
      if (!on) return;
      on = false; clearInterval(timer);
      fade(0, 1.5);
      offTimer = setTimeout(function () { // the clock freezes while suspended; start() picks up mid-phrase
        try { if (!want) quiet(ctx.suspend()); } catch (e) {}
      }, 1700);
    } catch (e) {}
  }

  function setVol(v) { // the music fader: 0..1, the gain is the square
    try {
      vol = unit(v, vol);
      if (!ctx) return;
      [mDry, mWet].forEach(function (n) { n.gain.setTargetAtTime(vol * vol, ctx.currentTime, 0.04); });
      wake();
    } catch (e) {}
  }
  function setFx(v) { // the effects switch: cues and chimes both run through the FX bus
    try {
      fxOn = !!v;
      if (ctx) fxBus.gain.setTargetAtTime(fxOn ? fxVol * fxVol : 0, ctx.currentTime, 0.04);
    } catch (e) {}
  }

  // ---- effects
  // One enveloped oscillator into the FX bus; glides to f1 when given.
  function blip(t, type, f0, f1, dur, peak, att) {
    var o = osc(type, f0, t, t + dur), g = gain(0);
    if (f1) { o.frequency.setValueAtTime(f0, t + dur * 0.15); o.frequency.exponentialRampToValueAtTime(f1, t + dur * 0.55); }
    env(g.gain, t, att, peak, 0, (dur - att) / 5);
    link(o, g, fxBus); keep(t + dur, [o, g]);
  }
  // Glassy FM chime.
  function bell(t, f, peak, dec) {
    var end = t + dec * 6, c = osc('sine', f, t, end), m = osc('sine', f * 3.5, t, end), index = gain(f * 1.4), g = gain(0);
    index.gain.setTargetAtTime(f * 0.1, t, dec * 0.3); // bright strike that mellows at once
    env(g.gain, t, 0.004, peak, 0, dec);
    link(m, index, c.frequency); link(c, g, fxBus);
    keep(end, [c, m, index, g]);
  }
  function triad(ok, third) { // a note of the allowed set that has this third (and, for major, a fifth) inside the set
    for (var i = 0; i < ok.length; i++) {
      if (ok.indexOf((ok[i] + third) % 12) >= 0 && (third === 3 || ok.indexOf((ok[i] + 7) % 12) >= 0)) return ok[i];
    }
    return ok[0];
  }

  // name: [minimum seconds between two of the same, how to play it]. r: the sounding chord's root around A4,
  // ch: that chord, ok: the notes that fit it. Every effect is in key with the music under it.
  var FX = {
    ui: [0.05, function (t, r, ch) { blip(t, 'sine', hz(r + 12 + ch[2]), 0, 0.035, 0.1, 0.002); }], // tiny click, on the chord's fifth
    pick: [0.1, function (t, r) { blip(t, 'triangle', hz(r + 12), 0, 0.09, 0.22, 0.003); }], // confirm tick, on the root
    ask: [0.3, function (t, r, ch) { blip(t, 'sine', hz(r + ch[2] - 12), hz(r + ch[1]), 0.2, 0.2, 0.01); }], // chirp up, left open on the third
    kill: [0.45, function (t, r) { blip(t, 'sawtooth', hz(r), hz(r - 36), 0.3, 0.2, 0.004); }], // zap falling three octaves to the root: not a kick
    buy: [0.3, function (t, r) { var m = fold(r, 64); bell(t, hz(m), 0.2, 0.2); bell(t + 0.11, hz(m + 12), 0.24, 0.3); }], // bright chime, root up an octave
    win: [0.8, function (t, r, ch, ok) { // a major arpeggio running up, with a chime on top
      var m = fold(triad(ok, 4), 62);
      [0, 4, 7, 12].forEach(function (s, i) { blip(t + i * 0.075, 'triangle', hz(m + s), 0, 0.5, 0.12, 0.005); });
      bell(t + 0.3, hz(m + 12), 0.14, 0.35);
    }],
    loss: [0.8, function (t, r, ch, ok) { // a soft minor third falling
      var m = fold(triad(ok, 3), 60);
      blip(t, 'triangle', hz(m + 3), 0, 0.4, 0.15, 0.03); blip(t + 0.22, 'triangle', hz(m), 0, 0.8, 0.16, 0.03);
      blip(t + 0.22, 'sine', hz(m - 12), 0, 0.8, 0.09, 0.05);
    }]
  };

  function sfx(name) {
    try {
      if (!on || !fxOn) return; // silent while music is off, and while the effects switch is off
      if (ctx.state !== 'running') { wake(); return; } // never queue sounds on a frozen clock
      if (!FX.hasOwnProperty(name)) return;
      var now = ctx.currentTime, c = tl[0] || [0, key, CH[0], [key % 12]], i;
      if (now - fxLast[name] < FX[name][0]) return; // a burst of the same event plays once
      fxLast[name] = now;
      for (i = 1; i < tl.length && tl[i][0] <= now; i++) c = tl[i]; // the chord sounding right now
      FX[name][1](now + 0.01, c[1] + 36, c[2], c[3]);
    } catch (e) {}
  }

  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', wake);

  // ---- the public API: window.MuseMusic. Every call is a silent no-op when Web Audio is missing.
  var CUES = { start: 'pick', done: 'win', approval: 'ask', error: 'loss' }; // each cue is one of the effects above, the same family
  function stateKey() { return [on, STY[wantStyle].key, vol, fxOn].join('|'); }
  var lastState = stateKey(); // only a real change sends musicchange
  function announce() { // one musicchange event per real change of state
    var k = stateKey();
    if (!AC || k === lastState) return;
    lastState = k;
    try { window.dispatchEvent(new CustomEvent('musicchange', { detail: { on: on, style: STY[wantStyle].key, volume: vol, effects: fxOn } })); } catch (e) {}
  }
  function playing() { try { return on && ctx.state === 'running'; } catch (e) { return false; } }

  window.MuseMusic = {
    supported: !!AC, // false: every call below does nothing
    styles: Object.freeze(STY.map(function (p) { return Object.freeze({ key: p.key, name: p.name }); })), // menu order, Synthwave first
    init: function () {}, // builds nothing: the audio graph is made at the first play
    isOn: function () { return on; },
    setOn: function (v) { // true starts the music; call it from a click or tap. Resolves to true when the device is playing (a browser may block it)
      if (!AC) return Promise.resolve(false);
      var p = Promise.resolve(false);
      if (v) p = start().then(playing); else stop();
      announce();
      return p;
    },
    setStyle: function (key) { // a key from styles, or its number; the change comes at the next bar, so nothing playing is cut
      if (!AC) return;
      try { var k = typeof key === 'number' ? Math.floor(key) : KEYS.indexOf(key); wantStyle = k >= 0 && k < STY.length ? k : 0; } catch (e) {}
      announce();
    },
    setVolume: function (v) { if (AC) { setVol(v); announce(); } }, // the music, 0..1
    setEffects: function (v) { if (AC) { setFx(v); announce(); } }, // the effects and cues, on or off
    setMood: function (m) { // { intensity, danger }, each 0..1, felt over seconds: the engine's own mood input
      try { if (AC && m) { ti = unit(m.intensity, ti); td = unit(m.danger, td); } } catch (e) {}
    },
    cue: function (name) { // 'start' | 'done' | 'approval' | 'error': a short effect, silent while music is off
      try { if (AC && on && CUES.hasOwnProperty(name)) sfx(CUES[name]); } catch (e) {}
    },
    getAnalyser: function () { return ana || null; } // a level meter can read this; null without Web Audio
  };
})();
