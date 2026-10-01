; Preserve library data. Remove only an autostart value pointing to this installation.
!macro NSIS_HOOK_PREUNINSTALL
  ; Tauri passes /UPDATE to the old uninstaller during an upgrade. Preserve that login choice.
  StrCmp $UpdateMode "1" tracker_keep_run
  ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCTNAME}"
  StrCmp $R0 '$"$INSTDIR\${MAINBINARYNAME}.exe$" --background' tracker_remove_run
  StrCmp $R0 '$INSTDIR\${MAINBINARYNAME}.exe --background' tracker_remove_run tracker_keep_run
  tracker_remove_run:
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCTNAME}"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "${PRODUCTNAME}"
  tracker_keep_run:
!macroend
