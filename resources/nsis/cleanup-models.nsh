; Custom uninstall hook for PrivateTranscribe.
; Only asks about removing app data/model caches during a MANUAL uninstall (not during updates).
;
; When the NSIS installer triggers the uninstaller as part of an update, it passes
; _?=<install_path> on the command line. We check $CMDLINE for "_?=" to detect this.

!include "LogicLib.nsh"
!include "WordFunc.nsh"

!macro customUnInstall
  ; Check if this is an update (uninstaller called by new installer)
  ; During updates, $CMDLINE will contain "_?=<path>"
  StrCpy $R9 "0"   ; assume manual uninstall

  ${WordFind} "$CMDLINE" "_?=" "E+1{" $R8
  ; If _?= was found, $R8 won't be empty (or an error)
  StrCmp "$R8" "" +3 0
    StrCmp "$R8" "$CMDLINE" +2 0
      StrCpy $R9 "1"   ; this is an update

  ${If} $R9 == "0"
    MessageBox MB_YESNO|MB_ICONQUESTION \
      "Remove PrivateTranscribe app data too?$\r$\n$\r$\nThis deletes settings, transcription history, logs, API keys saved in the app, and local app cache files.$\r$\n$\r$\nClick No to uninstall the app but keep your data." \
      IDYES do_wipe_app_data IDNO ask_wipe_models

do_wipe_app_data:
    ; Electron userData path on Windows: %APPDATA%\PrivateTranscribe
    StrCpy $0 "$APPDATA\PrivateTranscribe"
    IfFileExists "$0\*.*" 0 +3
      RMDir /r "$0"
      DetailPrint "Removed PrivateTranscribe app data"

    ; Local app cache path, if used by Electron/Chromium.
    StrCpy $0 "$LOCALAPPDATA\PrivateTranscribe"
    IfFileExists "$0\*.*" 0 +3
      RMDir /r "$0"
      DetailPrint "Removed PrivateTranscribe local app cache"

    ; Legacy app data paths from earlier product names.
    StrCpy $0 "$APPDATA\Privoca"
    IfFileExists "$0\*.*" 0 +3
      RMDir /r "$0"
      DetailPrint "Removed legacy Privoca app data"
    StrCpy $0 "$LOCALAPPDATA\Privoca"
    IfFileExists "$0\*.*" 0 +3
      RMDir /r "$0"
      DetailPrint "Removed legacy Privoca local app cache"
    StrCpy $0 "$APPDATA\DictateVoice"
    IfFileExists "$0\*.*" 0 +3
      RMDir /r "$0"
      DetailPrint "Removed legacy DictateVoice app data"
    StrCpy $0 "$LOCALAPPDATA\DictateVoice"
    IfFileExists "$0\*.*" 0 +3
      RMDir /r "$0"
      DetailPrint "Removed legacy DictateVoice local app cache"

ask_wipe_models:
    MessageBox MB_YESNO|MB_ICONQUESTION \
      "Remove downloaded model caches (Whisper, Parakeet, GGUF)?$\r$\nThese can be several GB. Click No to keep them." \
      IDYES do_wipe_models IDNO skip_wipe_models
  ${Else}
    ; During updates, silently skip — models are preserved across versions.
    DetailPrint "Update detected — keeping model caches."
    Goto skip_wipe_models
  ${EndIf}

do_wipe_models:

  ; Clean up current PrivateTranscribe model cache subdirectories
  StrCpy $R0 "$PROFILE\.cache\PrivateTranscribe"

  ; Whisper model cache (~/.cache/PrivateTranscribe/whisper-models)
  StrCpy $0 "$R0\whisper-models"
  IfFileExists "$0\*.*" 0 +3
    RMDir /r "$0"
    DetailPrint "Removed PrivateTranscribe whisper model cache"

  ; Parakeet model cache (~/.cache/PrivateTranscribe/parakeet-models)
  StrCpy $0 "$R0\parakeet-models"
  IfFileExists "$0\*.*" 0 +3
    RMDir /r "$0"
    DetailPrint "Removed PrivateTranscribe Parakeet model cache"

  ; Local GGUF/llama model cache (~/.cache/PrivateTranscribe/models)
  StrCpy $0 "$R0\models"
  IfFileExists "$0\*.*" 0 +3
    RMDir /r "$0"
    DetailPrint "Removed PrivateTranscribe local GGUF model cache"

  ; Remove parent cache directory if now empty
  RMDir "$R0"

  ; Legacy Privoca cache path cleanup
  StrCpy $0 "$PROFILE\.cache\Privoca\whisper-models"
  IfFileExists "$0\*.*" 0 +3
    RMDir /r "$0"
    DetailPrint "Removed legacy Privoca whisper model cache"
  StrCpy $0 "$PROFILE\.cache\Privoca\parakeet-models"
  IfFileExists "$0\*.*" 0 +3
    RMDir /r "$0"
    DetailPrint "Removed legacy Privoca Parakeet model cache"
  StrCpy $0 "$PROFILE\.cache\Privoca\models"
  IfFileExists "$0\*.*" 0 +3
    RMDir /r "$0"
    DetailPrint "Removed legacy Privoca local GGUF model cache"
  StrCpy $1 "$PROFILE\.cache\Privoca"
  RMDir "$1"

  ; Legacy DictateVoice cache path cleanup
  StrCpy $0 "$PROFILE\.cache\dictatevoice\models"
  IfFileExists "$0\*.*" 0 +3
    RMDir /r "$0"
    DetailPrint "Removed legacy DictateVoice cached models"
  StrCpy $1 "$PROFILE\.cache\dictatevoice"
  RMDir "$1"

skip_wipe_models:
!macroend
