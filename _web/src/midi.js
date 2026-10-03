// Reproductor de MIDI sobre WebAudio.
//
// La musica del juego son 28 ficheros MIDI y los navegadores no los reproducen
// de forma nativa. Aqui se interpreta el fichero (formato SMF) y se sintetiza.
//
// Aviso honesto sobre fidelidad: en el juego original el MIDI lo tocaba el
// sintetizador de Windows (Microsoft GS Wavetable), que usa MUESTRAS de
// instrumentos reales. Las NOTAS de aqui son exactamente las mismas; el TIMBRE
// no puede serlo sin incrustar un soundfont de varios megas. Lo que se hace es
// acercarse todo lo posible con sintesis (ver mas abajo).

// ---------------------------------------------------------------------------
// Sintesis
//
// La primera version usaba un oscilador pelado por nota (cuadrada, sierra,
// triangulo). Eso suena a consola de 8 bits, no al MIDI del juego: el
// sintetizador de Windows usa MUESTRAS de instrumentos reales. Sin meter un
// soundfont de varios megas no se puede igualar, pero se puede acercar mucho
// mas que con una onda simple:
//
//   - cada familia de instrumento se construye con su propio perfil de
//     armonicos (PeriodicWave), no con una onda basica
//   - envolvente ADSR propia: un piano ataca y decae, una cuerda entra suave
//     y se sostiene, un metal tiene un golpe inicial
//   - dos osciladores ligeramente desafinados por nota, que es lo que da
//     cuerpo y quita el sonido "plano"
//   - filtro paso bajo por nota, mas abierto cuanto mas fuerte se toca
//   - reverberacion corta comun, que es lo que mas acerca al sonido de un
//     modulo de sonido real
//   - la percusion (canal 10) suena con ruido filtrado en vez de omitirse

// Perfiles por familia de la norma General MIDI.
// `arm` son las amplitudes de los armonicos 1, 2, 3... (1 = el fundamental).
const FAMILIAS = [
  // 0 pianos
  { arm: [1, .38, .22, .12, .07, .04, .02], a: .004, d: 1.1, s: .22, r: .28, filtro: 4200, det: 4 },
  // 1 percusion cromatica (campanas, xilofono)
  { arm: [1, .12, .5, .08, .28, .05, .1],   a: .002, d: .9,  s: .06, r: .5,  filtro: 6500, det: 3 },
  // 2 organos
  { arm: [1, .7, .5, .38, .3, .22, .18, .12], a: .02, d: .1, s: .95, r: .1,  filtro: 3800, det: 6 },
  // 3 guitarras
  { arm: [1, .5, .32, .2, .13, .08, .05],   a: .006, d: .8,  s: .18, r: .3,  filtro: 3600, det: 5 },
  // 4 bajos
  { arm: [1, .55, .25, .1, .05],            a: .008, d: .7,  s: .3,  r: .25, filtro: 1400, det: 3 },
  // 5 cuerdas
  { arm: [1, .62, .45, .3, .2, .14, .1, .07], a: .09, d: .3, s: .85, r: .4,  filtro: 3200, det: 8 },
  // 6 metales
  { arm: [1, .8, .62, .48, .36, .26, .18, .12], a: .05, d: .25, s: .78, r: .22, filtro: 4600, det: 7 },
  // 7 vientos de lengueta / madera
  { arm: [1, .3, .45, .15, .2, .08, .06],   a: .04, d: .2,  s: .8,  r: .2,  filtro: 3400, det: 5 },
  // 8 flautas
  { arm: [1, .18, .08, .04, .02],           a: .06, d: .15, s: .9,  r: .18, filtro: 3000, det: 4 },
  // 9 sintetizadores
  { arm: [1, .5, .35, .28, .2, .16, .12, .09], a: .03, d: .4, s: .6, r: .35, filtro: 3000, det: 10 },
];

// programa General MIDI -> indice de familia
function familiaDe(p) {
  if (p < 8)  return 0;
  if (p < 16) return 1;
  if (p < 24) return 2;
  if (p < 32) return 3;
  if (p < 40) return 4;
  if (p < 48) return 5;
  if (p < 56) return 5;   // conjuntos de cuerda y coros
  if (p < 64) return 6;
  if (p < 72) return 7;
  if (p < 80) return 8;
  return 9;
}

const frecuencia = (nota) => 440 * Math.pow(2, (nota - 69) / 12);

// (parseo del fichero SMF)
function leerVarInt(d, p) {
  let v = 0, b;
  do { b = d[p++]; v = (v << 7) | (b & 0x7F); } while (b & 0x80);
  return [v, p];
}

// Devuelve { notas: [{t, dur, nota, canal, programa, vel}], duracion }
export function parsearMidi(buf) {
  const d = new Uint8Array(buf);
  const dv = new DataView(buf);
  if (String.fromCharCode(d[0], d[1], d[2], d[3]) !== 'MThd') throw new Error('no es un MIDI');
  const nPistas = dv.getUint16(10);
  const division = dv.getUint16(12);
  if (division & 0x8000) throw new Error('MIDI con division SMPTE, no soportado');

  const eventos = [];           // {tick, tipo, ...}
  let p = 14;
  for (let t = 0; t < nPistas; t++) {
    if (String.fromCharCode(d[p], d[p+1], d[p+2], d[p+3]) !== 'MTrk') break;
    const largo = dv.getUint32(p + 4);
    let q = p + 8;
    const fin = q + largo;
    let tick = 0, estado = 0;
    while (q < fin) {
      let dt; [dt, q] = leerVarInt(d, q);
      tick += dt;
      let b = d[q];
      if (b & 0x80) { estado = b; q++; } // si no, es "running status"
      const tipo = estado & 0xF0, canal = estado & 0x0F;

      if (estado === 0xFF) {                       // meta
        const meta = d[q++];
        let len; [len, q] = leerVarInt(d, q);
        if (meta === 0x51 && len === 3) {
          const usPorNegra = (d[q] << 16) | (d[q+1] << 8) | d[q+2];
          eventos.push({ tick, tipo: 'tempo', valor: usPorNegra });
        }
        q += len;
      } else if (estado === 0xF0 || estado === 0xF7) {
        let len; [len, q] = leerVarInt(d, q);
        q += len;
      } else if (tipo === 0xC0 || tipo === 0xD0) {
        eventos.push({ tick, tipo: 'programa', canal, valor: d[q] });
        q += 1;
      } else if (tipo === 0x80 || tipo === 0x90 || tipo === 0xA0 || tipo === 0xB0 || tipo === 0xE0) {
        const a = d[q], b2 = d[q+1];
        q += 2;
        if (tipo === 0x90 && b2 > 0) eventos.push({ tick, tipo: 'on', canal, nota: a, vel: b2 });
        else if (tipo === 0x80 || (tipo === 0x90 && b2 === 0)) eventos.push({ tick, tipo: 'off', canal, nota: a });
      } else {
        q++;                                        // evento desconocido: avanzar
      }
    }
    p = fin;
  }

  eventos.sort((a, b) => a.tick - b.tick);

  // ticks -> segundos, respetando los cambios de tempo
  let usPorNegra = 500000;      // 120 pulsaciones por minuto por defecto
  let tickPrev = 0, tiempo = 0;
  const programas = new Array(16).fill(0);
  const sonando = new Map();    // canal|nota -> {t, vel, programa}
  const notas = [];

  for (const ev of eventos) {
    tiempo += ((ev.tick - tickPrev) / division) * (usPorNegra / 1e6);
    tickPrev = ev.tick;
    if (ev.tipo === 'tempo') { usPorNegra = ev.valor; continue; }
    if (ev.tipo === 'programa') { programas[ev.canal] = ev.valor; continue; }
    const clave = (ev.canal << 8) | ev.nota;
    if (ev.tipo === 'on') {
      sonando.set(clave, { t: tiempo, vel: ev.vel, programa: programas[ev.canal] });
    } else {
      const ini = sonando.get(clave);
      if (!ini) continue;
      sonando.delete(clave);
      notas.push({ t: ini.t, dur: Math.max(0.05, tiempo - ini.t), nota: ev.nota,
                   canal: ev.canal, programa: ini.programa, vel: ini.vel });
    }
  }
  const duracion = notas.reduce((m, n) => Math.max(m, n.t + n.dur), 0);
  return { notas, duracion };
}

import { Banco } from './sampler.js';

export class Musica {
  constructor(base, baseBanco) {
    this.base = base;
    this.baseBanco = baseBanco || base.replace(/\/music$/, '');
    this.banco = new Banco();
    this.cargandoBanco = null;
    this.ctx = null;
    this.maestro = null;
    this.reverb = null;
    this.ondas = new Map();      // familia -> PeriodicWave
    this.ruido = null;           // buffer de ruido para la percusion
    this.cache = new Map();
    this.actual = null;
    this.volumen = 0.3;
    this.activa = true;
    this.vivos = [];             // nodos sonando, para poder cortar
    this.timer = null;
  }

  _asegurarContexto() {
    if (this.ctx) return;
    const C = window.AudioContext || window.webkitAudioContext;
    this.ctx = new C();
    const ctx = this.ctx;

    this.maestro = ctx.createGain();
    this.maestro.gain.value = this.volumen;

    // Reverberacion corta: es lo que mas acerca el sonido al de un modulo
    // real. La respuesta al impulso se genera aqui, no se descarga nada.
    this.reverb = ctx.createConvolver();
    const seg = 1.4, n = (ctx.sampleRate * seg) | 0;
    const imp = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = imp.getChannelData(c);
      for (let i = 0; i < n; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 2.6);
      }
    }
    this.reverb.buffer = imp;

    const seco = ctx.createGain(); seco.gain.value = 0.82;
    // El GS de Windows lleva algo de reverberacion por defecto; con nada suena
    // seco, con mucha suena a catedral.
    const humedo = ctx.createGain(); humedo.gain.value = 0.16;
    this.maestro.connect(seco); seco.connect(ctx.destination);
    this.maestro.connect(this.reverb); this.reverb.connect(humedo);
    humedo.connect(ctx.destination);

    // ruido blanco reutilizable para la bateria
    const nr = ctx.sampleRate * 0.5 | 0;
    this.ruido = ctx.createBuffer(1, nr, ctx.sampleRate);
    const dr = this.ruido.getChannelData(0);
    for (let i = 0; i < nr; i++) dr[i] = Math.random() * 2 - 1;
  }

  _onda(fam) {
    if (this.ondas.has(fam)) return this.ondas.get(fam);
    const arm = FAMILIAS[fam].arm;
    const real = new Float32Array(arm.length + 1);
    const imag = new Float32Array(arm.length + 1);
    for (let k = 0; k < arm.length; k++) imag[k + 1] = arm[k];
    const w = this.ctx.createPeriodicWave(real, imag, { disableNormalization: false });
    this.ondas.set(fam, w);
    return w;
  }

  async cargar(nombre) {
    if (this.cache.has(nombre)) return this.cache.get(nombre);
    const r = await fetch(`${this.base}/${nombre.toLowerCase()}`);
    if (!r.ok) throw new Error('no existe ' + nombre);
    const tema = parsearMidi(await r.arrayBuffer());
    this.cache.set(nombre, tema);
    return tema;
  }

  parar() {
    clearTimeout(this.timer);
    this.timer = null;
    for (const n of this.vivos) { try { n.stop(); } catch (e) {} }
    this.vivos = [];
    this.actual = null;
  }

  async poner(nombre) {
    if (!this.activa || !nombre) return;
    if (this.actual === nombre) return;
    this.parar();
    this.actual = nombre;
    let tema;
    try { tema = await this.cargar(nombre); }
    catch (e) { this.actual = null; return; }
    if (this.actual !== nombre) return;      // cambiaron de mapa mientras cargaba
    this._asegurarContexto();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    // El banco de muestras se carga una sola vez, en segundo plano. Hasta que
    // este, suena la sintesis; en cuanto llega, el timbre pasa a ser el real.
    if (!this.banco.listo && !this.cargandoBanco) {
      this.cargandoBanco = this.banco.cargar(this.baseBanco, this.ctx).catch(() => {});
    }
    this._arrancar(tema, nombre);
  }

  // Programar las 1800 notas de golpe crea 1800 osciladores a la vez. En vez de
  // eso se va programando por ventanas de dos segundos.
  _arrancar(tema, nombre) {
    const t0 = this.ctx.currentTime + 0.12;
    let i = 0;
    const paso = () => {
      if (this.actual !== nombre) return;
      const limite = this.ctx.currentTime - t0 + 2.0;
      while (i < tema.notas.length && tema.notas[i].t < limite) this._nota(tema.notas[i++], t0);
      this.vivos = this.vivos.filter(n => n.__fin > this.ctx.currentTime);
      if (i < tema.notas.length) {
        this.timer = setTimeout(paso, 700);
      } else {
        // repetir en bucle, como en el juego
        this.timer = setTimeout(() => {
          if (this.actual === nombre) { this.vivos = []; this._arrancar(tema, nombre); }
        }, Math.max(800, (tema.duracion - (this.ctx.currentTime - t0)) * 1000 + 500));
      }
    };
    paso();
  }

  _nota(n, t0) {
    const ctx = this.ctx;
    const ini = t0 + n.t;
    const fin = ini + n.dur;
    const vel = Math.min(1, n.vel / 127);

    // Con el banco cargado se tocan las muestras reales del juego.
    if (this.banco.listo) {
      const src = this.banco.tocar(this.ctx, this.maestro, n.programa, n.nota,
                                   n.vel, ini, fin, n.canal === 9);
      if (src) { this.vivos.push(src); return; }
    }

    if (n.canal === 9) { this._percusion(n, ini, vel); return; }

    const fam = familiaDe(n.programa);
    const P = FAMILIAS[fam];
    const f = frecuencia(n.nota);

    const g = ctx.createGain();
    const filtro = ctx.createBiquadFilter();
    filtro.type = 'lowpass';
    // cuanto mas fuerte se toca, mas brillo: como un instrumento de verdad
    filtro.frequency.value = Math.min(11000, P.filtro * (0.45 + vel));
    filtro.Q.value = 0.6;

    const onda = this._onda(fam);
    for (const desafine of [-P.det, P.det]) {
      const o = ctx.createOscillator();
      o.setPeriodicWave(onda);
      o.frequency.value = f;
      o.detune.value = desafine;
      o.connect(filtro);
      o.start(ini);
      o.stop(fin + P.r + 0.05);
      o.__fin = fin + P.r + 0.05;
      this.vivos.push(o);
    }
    filtro.connect(g);
    g.connect(this.maestro);

    // ADSR
    const pico = 0.20 * vel;
    const sost = pico * P.s;
    const tA = ini + P.a;
    const tD = tA + P.d * (0.5 + 0.5 * (1 - vel));
    g.gain.setValueAtTime(0.0001, ini);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, pico), tA);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, sost), Math.min(tD, fin));
    g.gain.setValueAtTime(Math.max(0.0002, g.gain.value), Math.max(tA, fin));
    g.gain.exponentialRampToValueAtTime(0.0001, fin + P.r);
  }

  // Canal 10: bateria. Ruido filtrado segun la nota, que es lo que distingue
  // un bombo de un charles.
  _percusion(n, ini, vel) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.ruido;
    const filtro = ctx.createBiquadFilter();
    const g = ctx.createGain();
    let dur = 0.12, pico = 0.13 * vel;

    if (n.nota <= 37) {                       // bombo y toms graves
      filtro.type = 'lowpass'; filtro.frequency.value = 160; dur = 0.18; pico *= 1.7;
    } else if (n.nota === 38 || n.nota === 40) {   // caja
      filtro.type = 'bandpass'; filtro.frequency.value = 1900; filtro.Q.value = 0.8; dur = 0.16;
    } else if (n.nota >= 42 && n.nota <= 46) {     // charles
      filtro.type = 'highpass'; filtro.frequency.value = 7000; dur = n.nota === 46 ? 0.3 : 0.06;
      pico *= 0.7;
    } else {                                       // platos y demas
      filtro.type = 'highpass'; filtro.frequency.value = 5000; dur = 0.5; pico *= 0.6;
    }

    src.connect(filtro); filtro.connect(g); g.connect(this.maestro);
    g.gain.setValueAtTime(pico, ini);
    g.gain.exponentialRampToValueAtTime(0.0001, ini + dur);
    src.start(ini);
    src.stop(ini + dur + 0.02);
    src.__fin = ini + dur + 0.02;
    this.vivos.push(src);
  }

  setVolumen(v) {
    this.volumen = v;
    if (this.maestro) this.maestro.gain.value = v;
  }
}
