# Dream Blue Online — cliente web

El cliente de Dream Blue Online reescrito para el navegador. Habla el **mismo
protocolo** que el cliente de Windows, así que se conecta a un servidor de
Dreaminze Engine sin modificarle nada.

Mapas, sprites, música, combate, clima, inventario, equipo, magias, chat, y
registro de cuentas y personajes.

---

## 1. Arranque

El navegador no puede abrir sockets TCP crudos, así que hace falta un puente:

```
navegador --WebSocket--> :4002 wsbridge --TCP--> :4000 adapter --TCP--> :4001 tu servidor
```

Las tres primeras piezas son Python 3 **sin dependencias**. Tres terminales:

```bash
python _servicios/adapter.py 127.0.0.1:4001
```
```bash
python _servicios/wsbridge.py
```
```bash
python _web/servidor.py 8080
```

Abrir `http://127.0.0.1:8080`. Si el menú dice **Estado del Server: Online**,
las tres piezas están bien y el servidor responde.

El argumento del adaptador es **dónde está tu servidor**: `host:puerto`. Puede
ser otra máquina — `python _servicios/adapter.py mi.servidor.com:4000`.

### Si tu servidor ya usa el puerto 4000

El adaptador escucha ahí por defecto y chocarían. Se mueve, y se le avisa al
puente:

```bash
python _servicios/adapter.py 127.0.0.1:4000 --escucha 4100
python _servicios/wsbridge.py 127.0.0.1:4100
```

Si además cambiás el puerto del puente (`--escucha` también funciona ahí), hay
que tocar `PUERTO_PUENTE` en `_web/src/game.js`. Es el único sitio del cliente
donde aparece.

Los tres escuchan en `0.0.0.0`, así que desde otra máquina de la red o la VPN se
entra con `http://<ip-del-que-sirve>:8080` sin configurar nada más.

---

## 2. Adaptarlo a TU instalación

**Esta es la parte que importa.** El repo trae los assets de la instalación con
la que se desarrolló: 210 mapas y las hojas de gráficos de ese cliente. Si tu
servidor tiene otros mapas, otros tiles o sprites nuevos, **hay que regenerarlos
desde tu cliente** o vas a ver los de aquí.

Hace falta Pillow, solo para esto:

```bash
pip install pillow
```

### 2.1 Mapas

```bash
python _web/build_maps.py "C:/ruta/a/tu/cliente"
```

Lee los `map*.dat` de esa carpeta y escribe `_web/assets/maps.bin`. El cliente
carga los mapas **todos de una vez** al arrancar; cambiar de mapa después no
descarga nada.

### 2.2 Hojas de gráficos

```bash
python _web/build_gfx.py "C:/ruta/a/tu/cliente/GFX"
```

Acepta PNG y BMP, así que podés apuntarlo directo a la carpeta `GFX` del cliente
de Dreaminze. Convierte a WebP sin pérdida horneando el color-key negro de
DirectDraw como canal alfa: mismos píxeles exactos, una fracción del tamaño
(90 MB → 8 MB en una prueba real).

Las hojas de más de 16383 px de lado no caben en WebP — la de sprites de
Dreaminze mide 384×20000. Esas se guardan en PNG automáticamente, y el cliente
las encuentra igual: prueba `.webp` y si no está, `.png`.

Cuántas hojas de tiles hay se detecta solo: carga `tiles0`, `tiles1`… hasta que
falte la siguiente. No hay ningún número que ajustar.

### 2.3 ⚠️ STRIDE — el único número que hay que calcular

En `_web/src/maps.js`:

```js
export const STRIDE = 14;
```

**Es el ancho de tu hoja de tiles dividido entre 16.**

```bash
python -c "from PIL import Image; w=Image.open(r'C:/ruta/a/tu/cliente/GFX/tiles0.bmp').width; print('ancho', w, '-> STRIDE', w//16)"
```

| hoja | ancho | STRIDE |
|---|---|---|
| la de este repo | 224 | **14** |
| cliente de Dreaminze | 256 | **16** |

El motor numera las casillas de 16 en 16 px aunque dibuje de 32; por eso el paso
no coincide con las columnas visibles. Con el número equivocado el juego arranca
y se conecta **sin ningún error**, pero los mapas salen con las casillas
corridas. Es el fallo más fácil de cometer y el más confuso de diagnosticar.

### 2.4 Música

Los mapas referencian sus MIDIs por nombre de archivo. Si tu instalación tiene
otros, copiá tu carpeta `Music` sobre `_web/assets/music/`. Lo que falte suena a
silencio, sin error.

---

## 3. El adaptador, y cuándo apagarlo

Se sienta entre el cliente y el servidor y corrige tres cosas que hacían falta
para juntar el cliente de 2006 con el servidor de Dreaminze 1.3:

1. **El campo Suerte.** El servidor 1.3 lo manda en el paquete de clases; el
   cliente 3.01 no lo conoce, lee todo corrido, da todas las razas por
   bloqueadas y revienta al crear personaje.
2. **La versión** del login, que el cliente R2 anuncia distinta a la que el
   servidor acepta.
3. **El relleno antitrampas**: cuatro campos constantes que el servidor valida.

Si tu servidor está modificado, esos arreglos pueden ser justo lo que te rompe
el login. Se apagan:

```bash
python _servicios/adapter.py mi.servidor.com:4000 --crudo
```

Así el adaptador solo mira y registra, sin tocar un byte.

**Todo lo que pasa queda en `_servicios/adapter_log.txt`**, paquete por paquete y
campo por campo. Es la primera herramienta a mirar cuando algo no funciona.

---

## 4. Diagnóstico

| Lo que ves | Qué pasa | Qué hacer |
|---|---|---|
| `Estado del Server: Offline` | el puente no corre, o escucha en otro puerto | arrancar `wsbridge.py`; revisar `PUERTO_PUENTE` en `game.js` |
| `El server esta apagado, volve a intentarlo mas tarde` | el puente está, pero el adaptador no llega al servidor | revisar el `host:puerto` del adaptador; probar `telnet` a mano |
| `Version de DBO anterior, por favor visite...` | el servidor rechaza la versión del login | el adaptador ya la reescribe a 3/1/121; si tu servidor espera otra, cambiar `VERSION_OK` en `adapter.py` |
| `Estas usando una version antigua del juego o no es el cliente original...` | no le gusta el relleno antitrampas | cambiar `RELLENO_OK` en `adapter.py`, o `--crudo` si tu servidor no lo valida |
| `Cuenta doblada no permitida!` | ya hay una sesión abierta con esa cuenta | cerrar la otra (el cliente de Windows suele ser el culpable) |
| Entra, pero el mapa es un rompecabezas | `STRIDE` equivocado | §2.3 |
| Entra, pero hay huecos negros donde debería haber suelo | faltan hojas de tiles | `build_gfx.py` contra tu `GFX` |
| Entra, pero el mapa no es el que debería | `maps.bin` es de otra instalación | `build_maps.py` contra tu cliente |
| Al crear personaje la lista de razas sale vacía | el campo Suerte | quitar `--crudo`; si tu servidor **no** manda ese campo, ponerlo |
| Te expulsa al tirar un objeto | `MAPDROPITEM` con cantidad distinta a la del inventario | hay que mandar **exactamente** la cantidad que dice el inventario; los objetos no acumulables llevan 0 |
| Te desconecta solo, sin mensaje | le llegó un paquete que no entiende | mirar las últimas líneas de `adapter_log.txt` |
| `ValueError: encoding error 5: Image size exceeds WebP limit` | una hoja pasa de 16383 px | ya está resuelto: se guarda en PNG. Si lo ves, el repo está desactualizado |

### Comprobación de que quedó bien

1. El menú dice **Online**.
2. Entrás con una cuenta y aparece la pantalla de personajes con los tuyos.
3. Entrás al juego y el mapa se ve **igual que en el cliente de Windows**, no
   corrido ni con huecos.
4. Caminás y el personaje se mueve; el pie de página muestra mapa y posición.
5. Abrís el inventario y los iconos son los que corresponden.

---

## 5. Mapa del repo

```
_web/
  index.html            la interfaz, recortada del ejecutable original
  servidor.py           servidor web local, sin caché
  src/
    game.js             el juego: estado, red, menú, bucle principal
    red.js              protocolo: campos Chr(0), terminador Chr(237)
    maps.js             lector de maps.bin   <-- STRIDE vive aquí
    render.js           dibujo del mapa por capas
    sprite.js           personajes, animación y paperdoll
    ui.js               paneles, inventario, chat
    midi.js, sampler.js, audio.js, efectos.js
  assets/               hojas WebP, maps.bin, música, sfx, interfaz
  build_maps.py         map*.dat  -> assets/maps.bin
  build_gfx.py          GFX/*.bmp -> assets/*.webp
  mundo.py              reconstruye la geografía -> mundo.json
  mapa_total.html       visor del mundo entero
  HOJA_DE_RUTA.md       qué está hecho, qué falta, y el protocolo deducido
  tabla_cliente.txt     las 803 cadenas del cliente original

_servicios/
  adapter.py            proxy que arregla el protocolo y REGISTRA TODO
  wsbridge.py           WebSocket -> TCP
  levantar_web.bat      arranca todo de una (rutas de la máquina original)
```

Antes de tocar el protocolo, leer **`_web/HOJA_DE_RUTA.md`**: tiene el formato
exacto de los paquetes que costó deducir — inventario, equipo, daño, cuentas,
personajes — para no volver a averiguarlos.

---

## 6. Mapa del mundo

`http://127.0.0.1:8080/mapa_total.html` muestra los mapas cosidos por sus warps,
con buscador, zoom y fichas. Para regenerarlo con los tuyos:

```bash
python _web/mundo.py "C:/ruta/a/tu/cliente"
```

Los `mapN.dat` no guardan su posición en el mundo: los campos Up/Down/Left/Right
están todos en cero. La geografía se reconstruye distinguiendo **costuras** de
**puertas** — un warp en un borde que aterriza en el borde opuesto del vecino
significa que los dos mapas son contiguos; uno que aterriza en mitad del destino
es una tienda o una cueva y no implica nada.

---

## 7. Lo que falta

Tienda, banco, comercio entre jugadores, ventana de chat privado, clanes, grupo,
emoticonos, cambio de apariencia y los editores de administrador. Los formatos de
paquete ya están capturados (`SAVEITEM` 24 campos, `SAVENPC` 47, `SAVESPELL` 17);
lo que falta es la interfaz. La lista completa está en `_web/HOJA_DE_RUTA.md`.

---

## 8. Cómo se hizo

Nunca se descompiló nada. El cliente original va empaquetado con MoleBox y sus
cadenas están cifradas en disco, pero en memoria están en claro: volcando el
proceso vivo apareció la tabla entera de comandos (803 entradas,
`_web/tabla_cliente.txt`). Los assets salieron llamando a las propias funciones
del sistema de archivos virtual de MoleBox con frida. El protocolo, de escuchar
el tráfico real.

Y las reglas de dibujo —qué fotograma va en cada pose, en qué orden se superpone
el equipo— se **midieron**: se mueve el personaje desde el cliente web, se
captura la ventana del cliente de Windows y se busca por fuerza bruta qué
combinación reproduce esos píxeles. Por eso el muñeco sale idéntico píxel a píxel
en las cuatro direcciones, con y sin equipo.
