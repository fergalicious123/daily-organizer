@echo off
REM Serve the organizer locally and open it.
REM
REM A web server is required, not optional: ES modules and service workers are
REM both blocked on file:// paths, so double-clicking index.html will not work.
REM Port 8000 matches the origin registered with Google, so sync works locally.

cd /d "%~dp0"

echo Starting Daily Organizer on http://localhost:8000
echo Close this window to stop the server.
echo.

start "" "http://localhost:8000"

REM tools/serve.py is http.server plus no-cache headers. Without them the
REM browser quietly serves stale JS after you edit a file.
python tools\serve.py 8000
if errorlevel 1 (
  echo.
  echo Could not start Python. Install it from https://python.org
  echo and make sure "Add Python to PATH" is ticked during setup.
  pause
)
