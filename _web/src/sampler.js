// Sampler: toca las notas con las MUESTRAS REALES del juego.
//
// La musica del DBO original la reproducia el "Microsoft GS Wavetable Synth"
// de Windows, cuyo juego de muestras vive en C:\Windows\System32\drivers\gm.dls.
// De ahi salen `soundbank.bin` (el PCM) y `soundbank.json` (el indice), asi que
// lo que suena aqui no es una imitacion: son las mismas ondas, la misma
// afinacion y las mismas envolventes que sonaban en el juego.
//
// Del banco solo se exportan los instrumentos que los 28 MIDI usan de verdad:
// 217 ondas, 1,4 MB. Se carga en segundo plano, despues del juego.

const dB = (unidades) => Math.pow(10, (unidades / 655360) / 20);

export class Banco {
  constructor() {
    this.listo = false;
    this.ondas = [];       // AudioBuffer por onda
    this.meta = null;
  }

  async cargar(base, ctx) {
    const [indice, crudo] = await Promise.all([
      fetch(`${base}/soundbank.json`).then(r => r.json()),
      fetch(`${base}/soundbank.bin`).then(r => r.arrayBuffer()),
    ]);
    const pcm = new Int16Array(crudo);
    this.meta = indice;
    this.ondas = indice.ondas.map(w => {
      // Cada onda conserva su propia frecuencia de muestreo; el navegador
      // hace la conversion al vuelo, igual que haria el sintetizador.
      const buf = ctx.createBuffer(1, w.n, w.hz);
      const canal = buf.getChannelData(0);
      for (let i = 0; i < w.n; i++) canal[i] = pcm[w.off + i] / 32768;
      return buf;
    });
    this.listo = true;
    return this;
  }

  // Elige la region del instrumento que cubre esa nota y esa velocidad.
  region(programa, nota, vel, percusion) {
    const lista = percusion ? this.meta.perc : this.meta.prog[programa];
    if (!lista || !lista.length) return null;
    let porNota = null;
    for (const r of lista) {
      if (nota < r.kmin || nota > r.kmax) continue;
      if (vel >= r.vmin && vel <= r.vmax) return r;
      if (!porNota) porNota = r;
    }
    if (porNota) return porNota;
    // fuera de rango: la region cuyo tramo de teclas quede mas cerca
    let mejor = lista[0], dist = Infinity;
    for (const r of lista) {
      const dd = nota < r.kmin ? r.kmin - nota : nota - r.kmax;
      if (dd < dist) { dist = dd; mejor = r; }
    }
    return mejor;
  }

  // Programa el sonido de una nota. Devuelve el nodo fuente, o null.
  tocar(ctx, destino, programa, nota, vel, ini, fin, percusion) {
    if (!this.listo) return null;
    const r = this.region(percusion ? 0 : String(programa), nota, vel, percusion);
    if (!r) return null;
    const w = this.meta.ondas[r.w];
    if (!w) return null;

    // La region puede reafinar y rebuclear la onda; si no trae datos propios,
    // manda lo que dice la onda.
    const raiz = r.raiz !== undefined ? r.raiz : w.raiz;
    const fino = r.fino !== undefined ? r.fino : w.fino;
    const aten = r.aten !== undefined ? r.aten : w.aten;
    const bini = r.bini !== undefined ? r.bini : w.bini;
    const blen = r.blen !== undefined ? r.blen : w.blen;

    const src = ctx.createBufferSource();
    src.buffer = this.ondas[r.w];
    src.playbackRate.value = Math.pow(2, (nota - raiz) / 12) * Math.pow(2, fino / 1200);

    const sostenido = !percusion && bini >= 0 && blen > 0;
    if (sostenido) {
      src.loop = true;
      src.loopStart = bini / w.hz;
      src.loopEnd = (bini + blen) / w.hz;
    }

    const g = ctx.createGain();
    src.connect(g);
    g.connect(destino);

    // Envolvente de la propia articulacion DLS
    const a = r.a !== undefined ? r.a : 0;
    const d = r.d !== undefined ? r.d : 20;
    const s = r.s !== undefined ? r.s : 1;
    const rel = r.r !== undefined ? r.r : 0.25;

    // La curva de velocidad del GS es aproximadamente cuadratica
    const pico = dB(aten) * Math.pow(vel / 127, 2) * 0.9;
    const min = 0.00005;
    const tA = ini + Math.min(a, 0.4);
    const nivelS = Math.max(min, pico * s);

    g.gain.setValueAtTime(min, ini);
    if (tA > ini) g.gain.linearRampToValueAtTime(Math.max(min, pico), tA);
    else g.gain.setValueAtTime(Math.max(min, pico), ini);
    g.gain.exponentialRampToValueAtTime(nivelS, tA + Math.max(0.01, d));

    const paro = percusion ? ini + this.ondas[r.w].duration / src.playbackRate.value
                           : fin;
    if (!percusion) {
      // Al soltar la tecla hay que enganchar la caida en el valor que la
      // envolvente tenga EN ESE INSTANTE. Se calcula, porque `gain.value` da el
      // valor de ahora mismo, no el que habra cuando suene la nota.
      const dd = Math.max(0.01, d);
      let v;
      if (paro <= tA) v = pico * Math.max(0, (paro - ini) / Math.max(1e-4, tA - ini));
      else            v = pico * Math.pow(nivelS / pico, Math.min(1, (paro - tA) / dd));
      v = Math.max(min, v);
      g.gain.cancelScheduledValues(paro);
      g.gain.setValueAtTime(v, paro);
      g.gain.exponentialRampToValueAtTime(min, paro + Math.max(0.03, Math.min(rel, 2)));
    }

    src.start(ini);
    const corte = percusion ? paro + 0.02 : paro + Math.max(0.05, Math.min(rel, 2)) + 0.02;
    src.stop(corte);
    src.__fin = corte;
    return src;
  }
}
