@echo off
rem Puts the diary online: saves every change as a commit and pushes it to GitHub,
rem which publishes the site folder in about a minute.
cd /d "%~dp0.."
git add -A
git diff --cached --quiet && echo Nothing new to commit - pushing anything still waiting.
git diff --cached --quiet || git commit -q -m "Update %date% %time:~0,5%"
git push -u origin HEAD:main
echo.
echo Pushed. It goes live in about a minute at https://danielr12321.github.io/restaurant-diary/
pause
