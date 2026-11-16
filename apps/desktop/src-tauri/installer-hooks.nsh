; Preserve library data. Remove only an autostart value pointing to this installation.
Var TrackerForeignRun
Var TrackerOwnedRun

; Connected stdio clients can retain node.exe after the tray Runtime exits.
; Check write access before replacing any files; never terminate unrelated Node processes.
!macro NSIS_HOOK_PREINSTALL
  Push $R0
  tracker_runtime_write_check:
    IfFileExists "$INSTDIR\node.exe" 0 tracker_runtime_write_ready
    ClearErrors
    FileOpen $R0 "$INSTDIR\node.exe" a
    IfErrors tracker_runtime_write_blocked
    FileClose $R0
    Goto tracker_runtime_write_ready
  tracker_runtime_write_blocked:
    IfSilent tracker_runtime_write_abort
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "The installed private Runtime is in use or is not writable.$\r$\n$\r$\nExit LeetCode Tracker from its tray menu and disconnect connected MCP clients before retrying.$\r$\n$\r$\nFile: $INSTDIR\node.exe" IDRETRY tracker_runtime_write_check
  tracker_runtime_write_abort:
    Pop $R0
    SetErrorLevel 1
    Abort "Private Runtime is unavailable for replacement."
  tracker_runtime_write_ready:
    Pop $R0
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  StrCpy $TrackerForeignRun ""
  StrCpy $TrackerOwnedRun 0
  ; The library is deliberately retained even if the stock uninstall checkbox was selected.
  StrCpy $DeleteAppDataCheckboxState 0
  ; Tauri passes /UPDATE to the old uninstaller during an upgrade. Preserve that login choice.
  StrCmp $UpdateMode "1" tracker_keep_run
  ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCTNAME}"
  StrCmp $R0 '$"$INSTDIR\${MAINBINARYNAME}.exe$" --background' tracker_remove_run
  StrCmp $R0 '$INSTDIR\${MAINBINARYNAME}.exe --background' tracker_remove_run tracker_foreign_run
  tracker_foreign_run:
    StrCpy $TrackerForeignRun $R0
    Goto tracker_keep_run
  tracker_remove_run:
    ; Defer mutation until uninstall actually succeeds, including the running-app guard.
    StrCpy $TrackerOwnedRun 1
  tracker_keep_run:
!macroend

; The stock Tauri template also deletes this value by name. Restore a foreign installation's value.
!macro NSIS_HOOK_POSTUNINSTALL
  StrCmp $TrackerOwnedRun "1" 0 tracker_restore_foreign
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "${PRODUCTNAME}"
  tracker_restore_foreign:
  StrCmp $TrackerForeignRun "" tracker_run_restored
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCTNAME}" $TrackerForeignRun
  tracker_run_restored:
!macroend
