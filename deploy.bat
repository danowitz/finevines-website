@echo off
REM FineVines LOCAL FALLBACK pipeline. The real one runs in GitHub Actions
REM (.github/workflows/pipeline.yml) on every push, nightly at 08:15 UTC, on
REM manual dispatch, and when the review console fires a repository_dispatch.
REM
REM Use this only when Actions is unavailable or a run needs reproducing on this
REM machine. It runs enrich -> collection editorial -> build -> deploy and
REM stops at the first error.
REM
REM It deliberately does NOT do three of the pipeline's steps: it does not drain
REM the review console's change queue (finevines applyqueue), does not source
REM bottle photographs (tools/labelfetch/cistage.sh), and does not send the
REM digest email (finevines notify).
REM
REM AFTER a successful run, COMMIT AND PUSH data/, assets/img/wines/ and
REM .bunny-manifest.json. Otherwise the next pipeline run diffs against stale
REM state and re-uploads the entire site.
finevines.exe enrich || goto :fail
finevines.exe enrichcollections -limit 50 -review-days 365 || goto :fail
finevines.exe build || goto :fail
finevines.exe deploy || goto :fail
echo Done. Now commit and push data/, assets/img/wines/ and .bunny-manifest.json
exit /b 0
:fail
echo FAILED - see output above. The site was NOT updated.
exit /b 1
