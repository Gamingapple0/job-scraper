@echo off
cd /d "%~dp0"
echo RUNNING > pipeline-status.txt
call npm run build >> data\logs\pipeline-run.log 2>&1
set BUILD_EXIT=%ERRORLEVEL%
echo BUILD_EXIT=%BUILD_EXIT% >> pipeline-status.txt
if not %BUILD_EXIT%==0 (
  echo DONE >> pipeline-status.txt
  exit /b %BUILD_EXIT%
)
node dist\cli.js run --all >> data\logs\pipeline-run.log 2>&1
set SCRAPE_EXIT=%ERRORLEVEL%
echo SCRAPE_EXIT=%SCRAPE_EXIT% >> pipeline-status.txt
echo DONE >> pipeline-status.txt
