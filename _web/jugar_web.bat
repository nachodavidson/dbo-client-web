@echo off
title Dream Blue Online - servidor web local
cd /d "%~dp0"
echo.
echo   Dream Blue Online (web)
echo   Abriendo http://127.0.0.1:8080
echo.
echo   Deja esta ventana abierta mientras juegas.
echo.
start "" http://127.0.0.1:8080
python servidor.py 8080
