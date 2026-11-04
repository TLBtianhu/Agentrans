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
Var UnOptionsDialog
Var UnOptionsApp
Var UnOptionsSessions
Var UnOptionsSettings
Var UnOptionsModels
Var UnOptionsRuntimes
Var UnOptionsExports
Var UnOptionsAll
Var UnOptionsAllConfirmed

; The helper allows only selected data below the single root, while the app subtree is protected.
Function un.RemoveData
  System::Call '$PLUGINSDIR\window-frame.dll::UninstallRemoveData(w "$UnTarget", w "$INSTDIR\app", w "$UnHome") ?c'
FunctionEnd

Function UninstallOptionsSelectAll
  ${NSD_SetState} $UnOptionsSessions 1
  ${NSD_SetState} $UnOptionsSettings 1
  ${NSD_SetState} $UnOptionsModels 1
  ${NSD_SetState} $UnOptionsRuntimes 1
  ${NSD_SetState} $UnOptionsExports 1
FunctionEnd

Function UninstallOptionsAccept
  ${NSD_GetState} $UnOptionsSessions $UnCleanSessions
  ${NSD_GetState} $UnOptionsSettings $UnCleanSettings
  ${NSD_GetState} $UnOptionsModels $UnCleanModels
  ${NSD_GetState} $UnOptionsRuntimes $UnCleanRuntimes
  ${NSD_GetState} $UnOptionsExports $UnCleanExports
  StrCpy $R0 0
  ${If} $UnCleanSessions == 1
  ${AndIf} $UnCleanSettings == 1
  ${AndIf} $UnCleanModels == 1
  ${AndIf} $UnCleanRuntimes == 1
  ${AndIf} $UnCleanExports == 1
    StrCpy $R0 1
  ${EndIf}
  ${If} $R0 == 1
  ${AndIf} $UnOptionsAllConfirmed != 1
    MessageBox MB_YESNO|MB_ICONQUESTION "$(UNINSTALL_OPTIONS_CONFIRM)" /SD IDNO
    ${If} ${Errors}
      Abort
    ${EndIf}
    StrCpy $UnOptionsAllConfirmed 1
  ${EndIf}
  SendMessage $UnOptionsDialog ${WM_CLOSE} 0 0
FunctionEnd

Function UninstallOptionsCancel
  SendMessage $UnOptionsDialog ${WM_CLOSE} 0 0
  Quit
FunctionEnd

Function UninstallOptions
  StrCpy $UnCleanApp 1
  StrCpy $UnCleanSessions 0
  StrCpy $UnCleanSettings 0
  StrCpy $UnCleanModels 0
  StrCpy $UnCleanRuntimes 0
  StrCpy $UnCleanExports 0
  StrCpy $UnOptionsAllConfirmed 0
  ${If} ${Silent}
    Return
  ${EndIf}
  nsDialogs::Create 1018
  Pop $UnOptionsDialog
  ${NSD_CreateLabel} 0 0 100% 12u "$(UNINSTALL_OPTIONS_TITLE)"
  ${NSD_CreateLabel} 0 16u 100% 12u "$(UNINSTALL_OPTIONS_HINT)"
  ${NSD_CreateCheckbox} 0 32u 100% 12u "$(UNINSTALL_OPTIONS_APP)"
  Pop $UnOptionsApp
  ${NSD_Check} $UnOptionsApp
  EnableWindow $UnOptionsApp 0
  ${NSD_CreateCheckbox} 0 48u 100% 12u "$(UNINSTALL_OPTIONS_SESSIONS)"
  Pop $UnOptionsSessions
  ${NSD_CreateCheckbox} 0 64u 100% 12u "$(UNINSTALL_OPTIONS_SETTINGS)"
  Pop $UnOptionsSettings
  ${NSD_CreateCheckbox} 0 80u 100% 12u "$(UNINSTALL_OPTIONS_MODELS)"
  Pop $UnOptionsModels
  ${NSD_CreateCheckbox} 0 96u 100% 12u "$(UNINSTALL_OPTIONS_RUNTIMES)"
  Pop $UnOptionsRuntimes
  ${NSD_CreateCheckbox} 0 112u 100% 12u "$(UNINSTALL_OPTIONS_EXPORTS)"
  Pop $UnOptionsExports
  ${NSD_CreateButton} 0 132u 100% 14u "$(UNINSTALL_OPTIONS_ALL)"
  Pop $UnOptionsAll
  ${NSD_OnClick} $UnOptionsAll UninstallOptionsSelectAll
  ${NSD_CreateButton} 0 154u 48% 16u "$(UNINSTALL_OPTIONS_ACCEPT)"
  Pop $R0
  ${NSD_OnClick} $R0 UninstallOptionsAccept
  ${NSD_CreateButton} 52% 154u 48% 16u "$(UNINSTALL_OPTIONS_CANCEL)"
  Pop $R1
  ${NSD_OnClick} $R1 UninstallOptionsCancel
  nsDialogs::Show
FunctionEnd

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
  Call UninstallOptions
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
