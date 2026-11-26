; Soul installer — per-user, no admin rights needed
Unicode true
!include "MUI2.nsh"
!define APP "Soul"
!ifndef VERSION
  !define VERSION "3.3.1"
!endif
Name "${APP}"
OutFile "..\dist\Soul-Setup-${VERSION}.exe"
InstallDir "$LOCALAPPDATA\Programs\Soul"
RequestExecutionLevel user
SetCompressor /SOLID lzma
!define MUI_ICON "..\icon.ico"
!define MUI_UNICON "..\icon.ico"
!define MUI_WELCOMEPAGE_TITLE "Install Soul ${VERSION}"
!define MUI_WELCOMEPAGE_TEXT "Soul is a fast, themeable VRChat companion.$\r$\n$\r$\nYour history, theme and settings are kept in %APPDATA%\Soul and are not touched by installing, updating or uninstalling."
!define MUI_FINISHPAGE_RUN "$INSTDIR\Soul.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Open Soul now"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "Soul"
VIAddVersionKey "FileDescription" "Soul installer"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "Soul"

Section "Soul" SecMain
  ; close a running Soul (and its VR helper) so the files can be replaced
  nsExec::Exec 'taskkill /F /IM Soul.exe'
  Sleep 800
  SetOutPath "$INSTDIR"
  File "..\dist\Soul.exe"
  File "..\README.txt"
  File "..\icon.ico"
  CreateDirectory "$SMPROGRAMS\Soul"
  CreateShortcut "$SMPROGRAMS\Soul\Soul.lnk" "$INSTDIR\Soul.exe" "" "$INSTDIR\Soul.exe" 0
  CreateShortcut "$SMPROGRAMS\Soul\Uninstall Soul.lnk" "$INSTDIR\Uninstall.exe"
  CreateShortcut "$DESKTOP\Soul.lnk" "$INSTDIR\Soul.exe" "" "$INSTDIR\Soul.exe" 0
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Soul" "DisplayName" "Soul"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Soul" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Soul" "Publisher" "Soul"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Soul" "DisplayIcon" "$INSTDIR\Soul.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Soul" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Soul" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Soul" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Soul" "NoRepair" 1
  ; if "start with Windows" was on, point it at the installed copy
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Soul"
  StrCmp $0 "" +2
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Soul" '"$INSTDIR\Soul.exe" --background'
SectionEnd

Section "Uninstall"
  nsExec::Exec 'taskkill /F /IM Soul.exe'
  Sleep 800
  Delete "$INSTDIR\Soul.exe"
  Delete "$INSTDIR\README.txt"
  Delete "$INSTDIR\icon.ico"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  Delete "$SMPROGRAMS\Soul\Soul.lnk"
  Delete "$SMPROGRAMS\Soul\Uninstall Soul.lnk"
  RMDir "$SMPROGRAMS\Soul"
  Delete "$DESKTOP\Soul.lnk"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Soul"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Soul"
  ; your history and settings in %APPDATA%\Soul are kept on purpose
SectionEnd
