@echo off
setlocal
cd /d "%~dp0"
title LeetCode Tracker
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-desktop.ps1" %*
