@echo off
setlocal DisableDelayedExpansion
set "signTool=%AGENTRANS_DESKTOP_WINDOWS_SIGNTOOL%"
set "certificateFile=%AGENTRANS_DESKTOP_WINDOWS_CER_FILE%"
set "tokenPin=%AGENTRANS_DESKTOP_WINDOWS_TOKEN_PIN%"
set "keyContainer=%AGENTRANS_DESKTOP_WINDOWS_KEY_CONTAINER%"
set "targetFile=%AGENTRANS_DESKTOP_WINDOWS_SIGN_TARGET%"
set "appendSignature="
if "%AGENTRANS_DESKTOP_WINDOWS_SIGN_APPEND%"=="1" set "appendSignature=/as"
set "AGENTRANS_DESKTOP_WINDOWS_SIGNTOOL="
set "AGENTRANS_DESKTOP_WINDOWS_CER_FILE="
set "AGENTRANS_DESKTOP_WINDOWS_TOKEN_PIN="
set "AGENTRANS_DESKTOP_WINDOWS_KEY_CONTAINER="
set "AGENTRANS_DESKTOP_WINDOWS_SIGN_TARGET="
set "AGENTRANS_DESKTOP_WINDOWS_SIGN_APPEND="
set "signTool=" & set "certificateFile=" & set "tokenPin=" & set "keyContainer=" & set "targetFile=" & set "appendSignature=" & "%signTool%" sign /v /fd sha256 /f "%certificateFile%" /kc "[{{%tokenPin%}}]=%keyContainer%" /csp "eToken Base Cryptographic Provider" %appendSignature% "%targetFile%"
exit /b %errorlevel%
