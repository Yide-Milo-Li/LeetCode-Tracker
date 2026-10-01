; Preserve library data. Remove only an autostart value pointing to this installation.
Var TrackerForeignRun
!macro NSIS_HOOK_PREUNINSTALL
  StrCpy $TrackerForeignRun ""
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
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCTNAME}"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "${PRODUCTNAME}"
  tracker_keep_run:
!macroend

; The stock Tauri template also deletes this value by name. Restore a foreign installation's value.
!macro NSIS_HOOK_POSTUNINSTALL
  StrCmp $TrackerForeignRun "" tracker_run_restored
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCTNAME}" $TrackerForeignRun
  tracker_run_restored:
!macroend
