!macro customUnInstall
  ; Current Privoca cache path
  StrCpy $0 "$PROFILE\.cache\Privoca\models"
  IfFileExists "$0\*.*" 0 +3
    RMDir /r "$0"
    DetailPrint "Removed Privoca cached models"
  StrCpy $1 "$PROFILE\.cache\Privoca"
  RMDir "$1"

  ; Legacy DictateVoice cache path cleanup
  StrCpy $0 "$PROFILE\.cache\dictatevoice\models"
  IfFileExists "$0\*.*" 0 +3
    RMDir /r "$0"
    DetailPrint "Removed legacy DictateVoice cached models"
  StrCpy $1 "$PROFILE\.cache\dictatevoice"
  RMDir "$1"
!macroend
