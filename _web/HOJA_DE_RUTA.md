# Estado del cliente web  ·  que hay y que falta

Inventario sacado del **propio cliente**, no de suposiciones. `DBO.exe` va
empaquetado con MoleBox y sus textos estan cifrados en disco, pero **en memoria
estan en claro**: volcando el proceso vivo y minando las cadenas UTF-16 aparece
entera su tabla de comandos (copia en `tabla_cliente.txt`, 803 entradas).

El juego tiene **148 paquetes de entrada, 55 de salida y 31 comandos de chat**.

---

## YA FUNCIONA

**Mundo y movimiento**
- Los 210 mapas, 9 capas, composicion cacheada por mapa (sin pantallas de carga)
- Caminar con interpolacion, colisiones, warps entre mapas, carteles
- Camara centrada y sujeta a los bordes, como el original
- Sprites: 12 fotogramas (4 direcciones x 3), el 3.º es el ataque
- BIGSPRITES: criaturas de 64x64 ancladas por los pies
- Musica MIDI (sintetizada) y efectos de sonido

**Controles oficiales** (los que documenta la ayuda del propio juego)
- Flechas mover · **Shift** correr · **Ctrl** golpear
- **Insert** lanzar la magia elegida
- **F6 / F7 / F8** restaurar HP / MP / SP (con los mensajes textuales del original)
- **Fin** girar sin moverse del sitio
- **Espacio** recoger del suelo
- Doble clic en el mapa para elegir blanco (`search`)

**Red**
- **Registro completo**: crear y borrar cuenta, las tres ranuras de
  personaje, crear (raza, sexo y atributos) y borrar, y entrar
- Login, eleccion de personaje, peticion de mapa
- Mi personaje y **los demas jugadores, ahora con movimiento** (`playermove`,
  `playerdir`, `playerxy`)
- Criaturas: aparecer, moverse, girar, atacar, morir, vida
- Objetos tirados en el suelo (`MAPITEMDATA`, `SPAWNITEM`, `mapgetitem`)
- **Arcos y flechas**: el vuelo lo calcula el cliente y avisa donde cayo
- Numeros de dano flotantes, barras de vida sobre las criaturas
- Clima (lluvia, nieve, tormenta con relampagos) y ciclo de dia y noche
- Chat con **los colores reales** del servidor (paleta QBColor de VB6)
- `!nombre texto` privado · `%texto` al clan
- **26 comandos de chat**; los que no conoce se mandan con `checkcommands`,
  igual que hace el cliente original (asi funcionan `/guardar`, `/gm`, ...)

**Interfaz**
- Barras de HP/MP/SP/experiencia, estadisticas, repartir puntos
- Inventario de 24 ranuras con los iconos reales, usar y arrojar
- Equipo sobre el panel original extraido del ejecutable
- Lista de magias (elegir con doble clic), lista de conectados, chat

---

## FALTA

1. **Tiendas** — `updateshop`, `shopeditor`, pestanas Weapon/Shield/Armor/
   Helmet/Spell/Others, `fixitem`.
2. **Banco** — `openbank`, `playerbank`, `bankdeposit`, `bankwithdraw`.
   El paquete ya llega (152 campos, 50 ranuras), solo falta la ventana.
3. **Comercio entre jugadores** — `pptrading`, `qtrade`, `swapitems`.
4. **Chat privado en ventana** — `ppchatting`, `qchat`, `sendchat`.
5. **Clanes** — `MAKEGUILD`, `GUILDMEMBER`, `GUILDLEAVE`, ...
6. **Grupo** — `PARTY`, `JOINPARTY`, `LEAVEPARTY`.
7. **Editores de administrador** — item, npc, tienda, magia, emoticono, flecha
   y mapa. Los formatos ya estan capturados: `SAVEITEM` 24 campos,
   `SAVENPC` 47, `SAVESPELL` 17.
8. **Emoticonos** — `emotemsg`, `updateemoticon`.
9. **Cambio de apariencia** — `spritechange`, `buysprite`, `checksprite`.
10. **La familia `attributenpc*`** — un segundo tipo de criatura que el motor
    trata aparte.
11. **Ver a los demas jugadores** — el codigo esta y comprobado por estructura,
    pero el servidor solo manda `PLAYERDATA` de quien esta en TU mapa, y no ha
    coincidido nadie. Es lo unico que no se puede verificar en solitario.

---

## Datos del protocolo deducidos (para no volver a averiguarlos)

- Cuentas y personajes (los nombres van revueltos a proposito en este motor):
  `newfaccountied | cuenta | clave`, `delimaccounted | cuenta | clave`,
  `gatglasses` (sin campos), `addachara | nombre | sexo | raza | ranura`,
  `delimbocharu | ranura`, `usagakarim | ranura`.
  Crear y borrar cuenta NO necesitan sesion: valen en una conexion recien
  abierta. Sexo 0 = varon (MaleSprite de la raza), 1 = mujer (FemaleSprite);
  la ranura va de 1 a 3, como las secciones [CHAR1..3] del fichero de cuenta.
- `ALLCHARS`: las TRES ranuras seguidas, ocupadas o no, `nombre, raza, nivel`.
- `NEWCHARCLASSES`: `Name HP MP SP STR DEF SPEED MAGI MSpr FSpr Locked` por
  raza (once campos, ya sin el `Luck` que quita el adaptador).
- El servidor contesta a todo con `mensaje`, salga bien o mal: lo unico que
  los distingue es el texto. Los buenos son "Tu cuenta ha sido creada con
  exito!", "Has borrado la cuenta", "El personaje se creo con exito!" y
  "El personaje ha sido borrado!".
- El servidor NO comprueba que el nombre tenga tres letras (acepta "zz"), pero
  SI rechaza los signos. Esa comprobacion es del cliente.

- `PLAYERWORNEQ` / `itemworn`: `indice, Armadura, Arma, Casco, Escudo, Botas,
  Amuleto, Hada` — el primer campo es el indice del jugador, no una ranura.
- `UPDATEITEM` / `SAVEITEM` (24): `num, nombre, pic, tipo, Data1..3, StrReq,
  DefReq, SpeedReq, ClassReq, AccessReq, AddHP, AddMP, AddSP, AddStr, AddDef,
  AddMagi, AddSpeed, AddEXP, descripcion, durabilidad`.
- **`Data3` de un arma es el numero de flecha**: si vale 0 el arma es cuerpo a
  cuerpo; si vale N el servidor contesta `checkarrows` y el arma dispara la
  flecha N. Comprobado poniendo Data3 = 1, 2 y 3 y viendo cambiar la respuesta.
- `UPDATEArrow`: `num, nombre, pic, alcance`.
- `checkarrows`: `indiceJugador, numFlecha, ?`.
- `arrowhit`: `1 si cayo sobre una criatura / 0 si no, numFlecha, x, y`.
- `MAPITEMDATA`: 20 ranuras de `num, valor, durabilidad, x, y`.
- `SPAWNITEM`: `ranura, num, valor, durabilidad, x, y`.
- `MAPNPCDATA`: 15 ranuras de `num, x, y, direccion`.
- `UPDATENPC`: `num, nombre, sprite, esGrande, vidaMaxima`.
- `PLAYERSP` (y HP/MP): `maximo, actual`.
- Mensajes de chat: el 2.º campo es un indice **QBColor** de 0 a 15.

### Combate (capturado peleando de verdad, 2026-09-15)

Los nombres enganan, hay que leerlos al reves de lo que parece:

- `BLITPLAYERDMG <cantidad> <ranuraNpc>` = lo que **pega el jugador**; el numero
  va sobre la criatura.
- `BLITNPCDMG <cantidad>` = lo que **pega la criatura**; el numero va sobre mi.
- `damagedisplay <0 pego / 1 me pegan> <texto> <color>` — **no es un numero**,
  es la linea de texto para el chat ("Golpeas a vanx y le sacas 9 puntos de
  vida.", "Pierdes 1 Puntos de vida.").
- `NPCATTACK <ranura>` · `NPCDIR <ranura> <direccion>`
- `sound attack` al golpear, `sound pain` al recibir, `sound critical` en el
  golpe critico (que ademas manda "Sientes una gran energia al golpear!").
- Al morir la criatura: los `damagedisplay` de muerte y experiencia, un
  `SPAWNITEM` por cada objeto que suelta, `NPCDEAD <ranura>`, `levelup` si
  toca, y mas tarde `SPAWNNPC` cuando reaparece.

**Una criatura con Fuerza 0 no hace dano** (dato del servidor, no del
protocolo): parece inofensiva aunque el combate funcione.
