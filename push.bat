@echo off
REM Push this app to GitHub.
REM
REM The remote is already configured, so this just sends the commits. The first
REM time, Git will open a browser to sign you in to GitHub — that sign-in is
REM yours to complete; nothing here can or should do it for you.

cd /d "%~dp0"

echo Pushing to https://github.com/fergalicious123/daily-organizer
echo.
echo If a browser window opens asking you to sign in to GitHub, that is expected.
echo.

git push -u origin main

if errorlevel 1 (
  echo.
  echo Push failed. Common causes:
  echo   - Sign-in was cancelled or timed out. Run this again.
  echo   - The repo already has commits. Try:  git pull --rebase origin main
  echo   - Wrong account signed in. Check with: git remote -v
  echo.
) else (
  echo.
  echo Pushed. Next: enable GitHub Pages, then add the origin
  echo   https://fergalicious123.github.io
  echo to your OAuth client's authorised JavaScript origins.
  echo.
  echo Your site will be at:
  echo   https://fergalicious123.github.io/daily-organizer/
  echo.
)

pause
