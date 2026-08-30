; Microsoft Store variant of the installer include.
;
; Store policy 10.2.9 says "initiating the install must not display an
; installation user interface (i.e., silent install is required)", and a User
; Account Control dialog is the only prompt it allows. The Store downloads the
; binary from our own versioned URL and runs it with no arguments, so shipping
; the normal wizard and telling people to pass /S is not an option — the
; installer has to be silent on its own. `SilentInstall silent` is the NSIS
; script attribute that does that, and electron-builder's `customHeader` macro
; is the supported way to reach the top level of the generated script.
;
; Nothing else differs from the public installer. The uninstall hook is pulled
; in from the file the public build already uses rather than restated here, so
; the two variants can never drift apart on what uninstalling removes.

!addincludedir "${PROJECT_DIR}\resources\nsis"
!include "cleanup-models.nsh"

!macro customHeader
  ; electron-builder compiles the uninstaller in a separate pass that sets this
  ; attribute itself (templates/nsis/installer.nsi). Setting it a second time
  ; there changes nothing and only produces a redefinition warning.
  !ifndef BUILD_UNINSTALLER
    SilentInstall silent
  !endif
!macroend
