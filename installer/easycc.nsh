!macro copyEasyCcLegacyFile FILE_NAME
  ${If} ${FileExists} "$R0\resources\app\data\${FILE_NAME}"
    ${IfNot} ${FileExists} "$APPDATA\EasyCC\data\${FILE_NAME}"
      CopyFiles /SILENT "$R0\resources\app\data\${FILE_NAME}" "$APPDATA\EasyCC\data\${FILE_NAME}"
    ${EndIf}
  ${EndIf}
!macroend

!macro copyEasyCcLegacyDirectory DIRECTORY_NAME
  ${If} ${FileExists} "$R0\resources\app\data\${DIRECTORY_NAME}\*.*"
    CreateDirectory "$APPDATA\EasyCC\data\${DIRECTORY_NAME}"
    nsExec::ExecToLog '"$SYSDIR\robocopy.exe" "$R0\resources\app\data\${DIRECTORY_NAME}" "$APPDATA\EasyCC\data\${DIRECTORY_NAME}" /E /XC /XN /XO /R:0 /W:0 /NFL /NDL /NJH /NJS'
  ${EndIf}
!macroend

!macro customInit
  # Preserve state from releases that wrote into resources\app\data. This runs
  # before electron-builder uninstalls the previous version. Existing per-user
  # files always win; runtime migration retries any item missed here.
  ReadRegStr $R0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $R0 == ""
    ReadRegStr $R0 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${EndIf}
  ${If} $R0 == ""
    StrCpy $R0 "$INSTDIR"
  ${EndIf}

  CreateDirectory "$APPDATA\EasyCC\data"
  !insertmacro copyEasyCcLegacyFile "sessions.json"
  !insertmacro copyEasyCcLegacyFile "stages.json"
  !insertmacro copyEasyCcLegacyFile "parking-events.log"
  !insertmacro copyEasyCcLegacyFile "transitions.log"
  !insertmacro copyEasyCcLegacyFile "settings.json"
  !insertmacro copyEasyCcLegacyFile "agents.json"
  !insertmacro copyEasyCcLegacyFile "tasks.json"
  !insertmacro copyEasyCcLegacyFile "presets.json"
  !insertmacro copyEasyCcLegacyFile "teams.json"
  !insertmacro copyEasyCcLegacyFile "team-instances.json"
  !insertmacro copyEasyCcLegacyFile "debug.log"
  !insertmacro copyEasyCcLegacyDirectory "plan-versions"
  !insertmacro copyEasyCcLegacyDirectory "transcripts"
!macroend
