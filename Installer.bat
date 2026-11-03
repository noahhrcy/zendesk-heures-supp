@echo off
title Heures supp Zendesk - installation
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0outils\installer.ps1" -Source "%~dp0."
