@echo off
cd /d C:\Users\madhi\Claude\Scraper
call npm run build
node dist\cli.js run --all
node dist\cli.js export-fit-inbox
node dist\cli.js sync-sheet
