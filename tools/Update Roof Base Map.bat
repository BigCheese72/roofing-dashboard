@echo off
setlocal
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
    echo Python isn't installed or isn't on your PATH.
    echo Install it from https://python.org and try again.
    pause
    exit /b 1
)

python update_roof_base_map.py %*

if errorlevel 1 (
    echo.
    echo Something went wrong ^- see the messages above.
    pause
)
