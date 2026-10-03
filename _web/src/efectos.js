// Efectos que viven sobre el mapa y no son actores: numeros de dano que suben,
// flechas en vuelo, animaciones de magia y los objetos tirados en el suelo.
//
// Todos se dibujan entre los actores y la capa de delante, con las mismas
// coordenadas de camara.

import { TS } from './maps.js';

// Paleta QBColor de Visual Basic. El servidor manda el color de cada mensaje
// como un indice de 0 a 15; sin esto todo el chat sale del mismo color y se
// pierde la diferencia entre un aviso global, un susurro y un mensaje de admin.
export const QBCOLOR = [
  '#000000', '#000080', '#008000', '#008080', '#800000', '#800080', '#808000', '#c0c0c0',
  '#808080', '#0000ff', '#00ff00', '#00ffff', '#ff0000', '#ff00ff', '#ffff00', '#ffffff',
];
export const color = (n) => QBCOLOR[(parseInt(n, 10) || 0) & 15];

const MS_TEXTO = 1100;

export class Efectos {
  constructor(hojaFlechas, hojaHechizos) {
    this.hojaFlechas = hojaFlechas;
    this.hojaHechizos = hojaHechizos;
    this.textos = [];
    this.flechas = [];
    this.magias = [];
  }

  // Numero de dano flotante. `tono`: 'dano' (recibido) o 'golpe' (infligido).
  texto(t, x, y, tono = 'golpe') {
    this.textos.push({ t: String(t), x, y, tono, t0: performance.now() });
  }

  // Una flecha que sale de (x,y) en direccion `dir` y recorre hasta `alcance`
  // casillas. Cuando llega al final o topa, llama a `alImpactar(x, y)`.
  flecha(num, x, y, dir, alcance, alImpactar) {
    this.flechas.push({
      num, x, y, dir, quedan: alcance, alImpactar,
      px: x * TS, py: y * TS, t0: performance.now(), msCasilla: 45,
    });
  }

  magia(anim, x, y) {
    if (anim > 0) this.magias.push({ anim, x, y, t0: performance.now(), ms: 600 });
  }

  // `bloqueado(x,y)` decide si la flecha se detiene ahi (pared o criatura).
  actualizar(ahora, bloqueado) {
    this.textos = this.textos.filter(t => ahora - t.t0 < MS_TEXTO);
    this.magias = this.magias.filter(m => ahora - m.t0 < m.ms);

    const D = [[0, -1], [0, 1], [-1, 0], [1, 0]];
    this.flechas = this.flechas.filter(f => {
      const pasos = Math.floor((ahora - f.t0) / f.msCasilla);
      const [dx, dy] = D[f.dir] || [0, 1];
      const avance = Math.min(pasos, f.quedan);
      const nx = f.x + dx * avance, ny = f.y + dy * avance;
      f.px = nx * TS; f.py = ny * TS;
      if (avance >= f.quedan || bloqueado(nx, ny)) {
        f.alImpactar(nx, ny);
        return false;
      }
      return true;
    });
  }

  dibujar(ctx, cx, cy) {
    const ahora = performance.now();

    // flechas: la hoja tiene 4 columnas (una por direccion) y una fila por flecha
    if (this.hojaFlechas) {
      for (const f of this.flechas) {
        const sy = f.num * TS;
        if (sy + TS > this.hojaFlechas.height) continue;
        ctx.drawImage(this.hojaFlechas, f.dir * TS, sy, TS, TS,
                      Math.round(f.px - cx), Math.round(f.py - cy), TS, TS);
      }
    }

    // magias: 12 fotogramas por fila
    if (this.hojaHechizos) {
      for (const m of this.magias) {
        const p = (ahora - m.t0) / m.ms;
        const f = Math.min(11, (p * 12) | 0);
        const sy = m.anim * TS;
        if (sy + TS > this.hojaHechizos.height) continue;
        ctx.drawImage(this.hojaHechizos, f * TS, sy, TS, TS,
                      Math.round(m.x * TS - cx), Math.round(m.y * TS - cy), TS, TS);
      }
    }

    // numeros de dano: suben y se desvanecen
    ctx.font = 'bold 11px Verdana, sans-serif';
    ctx.textAlign = 'center';
    for (const t of this.textos) {
      const p = (ahora - t.t0) / MS_TEXTO;
      const dx = Math.round(t.x * TS - cx + TS / 2);
      const dy = Math.round(t.y * TS - cy - p * 22);
      ctx.globalAlpha = Math.max(0, 1 - p);
      ctx.fillStyle = '#000';
      ctx.fillText(t.t, dx + 1, dy + 1);
      ctx.fillStyle = t.tono === 'dano' ? '#ff5a4a' : '#ffe066';
      ctx.fillText(t.t, dx, dy);
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = 'left';
  }
}
