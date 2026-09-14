@echo off
cd /d C:\Users\madhi\Claude\Scraper
call npm run build
node dist\cli.js new-tracker-tab
