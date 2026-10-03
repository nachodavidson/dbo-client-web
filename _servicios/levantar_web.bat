@echo off
title Dream Blue Online - web
cd /d "%~dp0"

echo.
echo   Dream Blue Online (web)
echo   ------------------------------------------------
echo   1/4  servidor del juego   (puerto 4001)
echo   2/4  adaptador            (puerto 4000)
echo   3/4  puente WebSocket     (puerto 4002)
echo   4/4  pagina web           (puerto 8080)
echo.

REM --- 1) el servidor del juego. Tarda unos 12 segundos en escuchar.
REM     El /D es imprescindible: server.exe busca Data.ini, los mapas y las
REM     cuentas en la carpeta desde la que se lo lanza. Sin eso arranca, no
REM     encuentra nada y se cierra solo.
start "DBO servidor" /D "%~dp0..\_dreaminze\Dreaminze Engine 1.3\Servidor" "%~dp0..\_dreaminze\Dreaminze Engine 1.3\Servidor\server.exe"
echo   Esperando a que arranque el servidor...
timeout /t 18 /nobreak >nul

REM --- 2) el adaptador: corrige el protocolo entre el cliente y este servidor
start "DBO adaptador" python adapter.py

REM --- 3) el puente: convierte WebSocket del navegador en TCP del juego
timeout /t 2 /nobreak >nul
start "DBO puente" python wsbridge.py

REM --- 4) la pagina. Escucha en todas las interfaces para que se pueda
REM        entrar desde otro equipo por la VPN.
timeout /t 1 /nobreak >nul
start "DBO web" python ..\_web\servidor.py 8080

timeout /t 2 /nobreak >nul
start "" http://127.0.0.1:8080

echo.
echo   Listo. Se abrieron cuatro ventanas: dejalas abiertas mientras juegan.
echo.
echo   En esta maquina:  http://127.0.0.1:8080
echo   Desde otro PC:    http://%COMPUTERNAME%:8080
echo.
pause
