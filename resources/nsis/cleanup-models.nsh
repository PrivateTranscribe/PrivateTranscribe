!macro customUnInstall
  ; Ask before removing model caches (can be several GB).
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "Remove downloaded model caches (Whisper, Parakeet, GGUF)?$\r$\nThese can be several GB. Click No to keep them." \
    IDYES do_wipe_models IDNO skip_wipe_models
  do_wipe_models:

  ; Clean up all Privoca model cache subdirectories
  StrCpy $R0 "$PROFILE\.cache\Privoca"

  ; Whisper model cache (~/.cache/Privoca/whisper-models)
  StrCpy $0 "$R0\whisper-models"
  IfFileExists "$0\*.*" 0 +3
    RMDir /r "$0"
    DetailPrint "Removed Privoca whisper model cache"

  ; Parakeet model cache (~/.cache/Privoca/parakeet-models)
  StrCpy $0 "$R0\parakeet-models"
  IfFileExists "$0\*.*" 0 +3
    RMDir /r "$0"
    DetailPrint "Removed Privoca Parakeet model cache"

  ; Local GGUF/llama model cache (~/.cache/Privoca/models)
  StrCpy $0 "$R0\models"
  IfFileExists "$0\*.*" 0 +3
    RMDir /r "$0"
    DetailPrint "Removed Privoca local GGUF model cache"

  ; Remove parent cache directory if now empty
  RMDir "$R0"

  ; Legacy DictateVoice cache path cleanup
  StrCpy $0 "$PROFILE\.cache\dictatevoice\models"
  IfFileExists "$0\*.*" 0 +3
    RMDir /r "$0"
    DetailPrint "Removed legacy DictateVoice cached models"
  StrCpy $1 "$PROFILE\.cache\dictatevoice"
  RMDir "$1"

  skip_wipe_models:
!macroend
