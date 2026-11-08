@echo off
title Video Downloader Server
echo ========================================
echo   Video Downloader Server
echo ========================================
echo.
cd /d "%~dp0"
python server.py
pause
