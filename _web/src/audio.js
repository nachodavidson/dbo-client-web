// Sonido. La musica del juego es MIDI y los navegadores no la reproducen de
// forma nativa, asi que por ahora solo se cargan los efectos (WAV). La musica
// queda pendiente de decidir: sintetizador con soundfont (mantiene el sonido
// exacto y pesa poco) o convertir a OGG (mas simple pero suma decenas de MB).

export class Audio2 {
  constructor(base) { this.base = base; this.cache = new Map(); this.activo = true; }

  efecto(nombre) {
    if (!this.activo) return;
    let a = this.cache.get(nombre);
    if (!a) { a = new Audio(`${this.base}/${nombre}`); this.cache.set(nombre, a); }
    a.currentTime = 0;
    a.play().catch(() => {});      // el navegador puede bloquear hasta que haya interaccion
  }
}
