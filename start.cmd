@echo off
rem Double-click to start Abyss on Windows (same as: py start.py). Flags pass through.
setlocal
where py >nul 2>nul
if %errorlevel%==0 (py -3 "%~dp0start.py" %*) else (python "%~dp0start.py" %*)
if errorlevel 1 pause
