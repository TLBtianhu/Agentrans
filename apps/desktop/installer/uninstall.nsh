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
Var UnError
Var UnErrorLog
Var UnErrorHint
Var UnRegistryView

; A failed removal can already have removed siblings. Keep registration and the root uninstaller for recovery.
Function un.RemovalFailed
  DetailPrint "Uninstall removal failed: Win32 $UnError; target: $UnTarget"
  StrCpy $UnErrorLog ""
  ClearErrors
  CreateDirectory "$TEMP\Agentrans-uninstall"
  ${IfNot} ${Errors}
    GetTempFileName $UnErrorLog "$TEMP\Agentrans-uninstall"
    ${If} ${Errors}
      StrCpy $UnErrorLog ""
    ${EndIf}
  ${EndIf}
  StrCpy $0 1
  ${If} ${Silent}
    StrCpy $0 0
  ${EndIf}
  System::Call '$PLUGINSDIR\window-frame.dll::UninstallReportFailure(p $HWNDPARENT, i $UnError, w "$UnTarget", w "$UnErrorLog", i r0, w "$(^SetupCaption)", w "$(INSTALLER_UNINSTALL_FAILED)", w "$UnErrorHint", w "$(INSTALLER_EXTRACT_COPY)", w "$(INSTALLER_EXTRACT_EXPAND)", w "$(INSTALLER_EXTRACT_COLLAPSE)", w "$(INSTALLER_EXTRACT_SAVED)", w "$(INSTALLER_EXTRACT_UNSAVED)", w "$(INSTALLER_EXTRACT_COPIED)") i.r1 ?c'
  SetErrorLevel 2
  Quit
FunctionEnd

; The helper allows only selected data below the single root, while the app subtree is protected.
Function un.RemoveData
  StrCpy $UnErrorHint "$(INSTALLER_UNINSTALL_HINT)"
  System::Call '$PLUGINSDIR\window-frame.dll::UninstallRemoveData(w "$UnTarget", w "$INSTDIR\app", w "$UnHome") i.s ?c'
  Pop $UnError
  ${If} $UnError != 0
    Call un.RemovalFailed
  ${EndIf}
FunctionEnd

Function un.RemoveApp
  StrCpy $UnErrorHint "$(INSTALLER_UNINSTALL_HINT)"
  StrCpy $UnTarget "$INSTDIR\app"
  System::Call '$PLUGINSDIR\window-frame.dll::UninstallRemoveRoot(w "$UnTarget", w "$UnHome") i.s ?c'
  Pop $UnError
  ${If} $UnError != 0
    Call un.RemovalFailed
  ${EndIf}
FunctionEnd

!macro un.CheckRegistration Key
  StrCpy $UnTarget "HKCU\${Key}"
  System::Call '$PLUGINSDIR\window-frame.dll::UninstallCheckRegistration(w "${Key}", w "$INSTDIR", i $UnRegistryView) i.s ?c'
  Pop $UnError
  ${If} $UnError != 0
    Call un.RemovalFailed
  ${EndIf}
!macroend

Function un.CheckOwnership
  StrCpy $UnErrorHint "$(INSTALLER_UNINSTALL_OWNERSHIP_HINT)"
  StrCpy $UnRegistryView 0
  !ifdef APP_ARM64
    StrCpy $UnRegistryView 256
  !else
    !ifdef APP_64
      ${If} ${RunningX64}
        StrCpy $UnRegistryView 256
      ${EndIf}
    !endif
  !endif
  !insertmacro un.CheckRegistration "${INSTALL_REGISTRY_KEY}"
  !insertmacro un.CheckRegistration "${UNINSTALL_REGISTRY_KEY}"
  !ifdef UNINSTALL_REGISTRY_KEY_2
    !insertmacro un.CheckRegistration "${UNINSTALL_REGISTRY_KEY_2}"
  !endif
  StrCpy $UnTarget "$oldDesktopLink"
  Call un.CheckShortcut
  StrCpy $UnTarget "$oldStartMenuLink"
  Call un.CheckShortcut
FunctionEnd

Function un.CheckShortcut
  System::Call '$PLUGINSDIR\window-frame.dll::UninstallCheckShortcut(w "$UnTarget", w "$INSTDIR\app\${APP_EXECUTABLE_FILENAME}", w "$INSTDIR\${APP_EXECUTABLE_FILENAME}") i.s ?c'
  Pop $UnError
  ${If} $UnError != 0
    Call un.RemovalFailed
  ${EndIf}
FunctionEnd

!macro customRemoveFiles
  SetOutPath $TEMP
  Call un.CheckOwnership
  Call un.RemoveApp
  Call un.CheckOwnership
  Delete "$INSTDIR\7zip-installer-COPYING.txt"
  Delete "$INSTDIR\7zip-installer-LICENSE.txt"
  ${IfNot} ${isUpdated}
    ${GetParameters} $R0
    ClearErrors
    ${GetOptions} $R0 "/KEEP_APP_DATA" $R1
    ${If} ${Errors}
      StrCpy $UnErrorHint "$(INSTALLER_UNINSTALL_HINT)"
      ; Delete synchronously: a delayed path deletion could remove the next installation's uninstaller.
      StrCpy $UnTarget "$INSTDIR\Uninstall ${PRODUCT_FILENAME}.exe"
      System::Call '$PLUGINSDIR\window-frame.dll::UninstallRemoveFile(w "$UnTarget") i.s ?c'
      Pop $UnError
      ${If} $UnError != 0
        Call un.RemovalFailed
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

Function un.CleanData
  Call un.CheckOwnership
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
  ; Only a AGENTRANS_HOME published as a Windows environment variable is visible here.
  ReadEnvStr $UnHome AGENTRANS_HOME
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
