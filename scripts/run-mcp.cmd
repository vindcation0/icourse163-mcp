@echo off
cd /d "%~dp0\.."
node --import tsx src/stdio.ts
