@echo off
cd /d C:\Users\madhi\Claude\Scraper
node dist\cli.js export-tracker-inbox
node dist\cli.js sync-sheet
