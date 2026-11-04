; Electron user data and updater downloads leave with the application; the Harness home is never touched.
!include FileFunc.nsh
Var UnTarget
Var UnHome
Var UnCleanApp
Var UnCleanSessions
Var UnCleanSettings
Var UnCleanModels
Var UnCleanRuntimes
Var UnCleanExports

; The helper allows only selected data below the single root, while the app subtree is protected.
Function un.RemoveData
  System::Call '$PLUGINSDIR\window-frame.dll::UninstallRemoveData(w "$UnTarget", w "$INSTDIR\app", w "$UnHome") ?c'
FunctionEnd

Function un.RemoveApp
  System::Call '$PLUGINSDIR\window-frame.dll::UninstallRemoveRoot(w "$INSTDIR\app", w "$UnHome") ?c'
FunctionEnd

!macro customRemoveFiles
  SetOutPath $TEMP
  Call un.RemoveApp
  Delete "$INSTDIR\7zip-installer-COPYING.txt"
  Delete "$INSTDIR\7zip-installer-LICENSE.txt"
  ${IfNot} ${isUpdated}
    ${GetParameters} $R0
    ClearErrors
    ${GetOptions} $R0 "/KEEP_APP_DATA" $R1
    ${If} ${Errors}
      FileOpen $0 "$TEMP\agentrans-uninstall-cleanup.cmd" w
      FileWrite $0 "@echo off$\r$\n"
      FileWrite $0 "ping 127.0.0.1 -n 3 >nul$\r$\n"
      FileWrite $0 'del /f /q "$INSTDIR\Uninstall ${PRODUCT_FILENAME}.exe"$\r$\n'
      FileWrite $0 'del /f /q "%~f0"$\r$\n'
      FileClose $0
      Exec '"$SYSDIR\cmd.exe" /c "$TEMP\agentrans-uninstall-cleanup.cmd"'
    ${EndIf}
  ${EndIf}
!macroend

Function un.CleanData
  ${If} ${isUpdated}
    Return
  ${EndIf}
  ; The installer runs an older uninstaller with /KEEP_APP_DATA when replacing it from another directory.
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/KEEP_APP_DATA" $R1
  ${IfNot} ${Errors}
    Return
  ${EndIf}
  ; NSIS always uses app-only scope; the production CLI's dialog owns optional data scopes.
  StrCpy $UnCleanApp 1
  StrCpy $UnCleanSessions 0
  StrCpy $UnCleanSettings 0
  StrCpy $UnCleanModels 0
  StrCpy $UnCleanRuntimes 0
  StrCpy $UnCleanExports 0
  ; Only a DSH_HOME published as a Windows environment variable is visible here.
  ReadEnvStr $UnHome DSH_HOME
  ClearErrors
  ${If} $UnCleanApp == 1
    StrCpy $UnTarget "$INSTDIR\data\cache"
    Call un.RemoveData
  ${EndIf}
  ${If} $UnCleanSessions == 1
    StrCpy $UnTarget "$INSTDIR\data\sessions"
    Call un.RemoveData
  ${EndIf}
  ${If} $UnCleanSettings == 1
    StrCpy $UnTarget "$INSTDIR\data\settings"
    Call un.RemoveData
    StrCpy $UnTarget "$INSTDIR\data\install"
    Call un.RemoveData
  ${EndIf}
  ${If} $UnCleanModels == 1
    StrCpy $UnTarget "$INSTDIR\models"
    Call un.RemoveData
  ${EndIf}
  ${If} $UnCleanRuntimes == 1
    StrCpy $UnTarget "$INSTDIR\runtime-envs"
    Call un.RemoveData
  ${EndIf}
  ${If} $UnCleanExports == 1
    StrCpy $UnTarget "$INSTDIR\data\exports"
    Call un.RemoveData
  ${EndIf}
FunctionEnd
