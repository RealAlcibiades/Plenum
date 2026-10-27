@echo off
"%TS_FAKE_NODE%" "%~dp0fake.mjs" %*
exit /b %ERRORLEVEL%
