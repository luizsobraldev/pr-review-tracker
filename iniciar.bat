@echo off
title PR Review Tracker
cd /d "%~dp0"
node --disable-warning=ExperimentalWarning server.js
pause
