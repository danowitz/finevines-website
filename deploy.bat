@echo off
REM Fine Vines nightly/on-demand pipeline. Run from the repo root.
finevines.exe enrich || goto :fail
finevines.exe build || goto :fail
finevines.exe deploy || goto :fail
echo Done.
exit /b 0
:fail
echo FAILED - see output above. The site was NOT updated.
exit /b 1
