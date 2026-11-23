; dungeonboringengine – gemeinsame Konstanten für Stub (Bank 0) und Lib (Bank 1)

DBE_VERSION = 1

; Bank 0, im gemeinsamen RAM (unten 4 KB während eines Aufrufs)
VCLBUF   = $0B00        ; VCL-Liste, die VIEW schreibt (max. 256 Byte)
PARM     = $0C00        ; Parameterblock
P0       = PARM+0       ; Wort
P1       = PARM+2       ; Wort
P2       = PARM+4       ; Wort
P3       = PARM+6       ; Wort
STUB     = $0D00        ; Stub: $0D00 JMP init, $0D03 JMP call

; Bank 1
LIB      = $C000        ; Lib: $C000 JMP dispatch

; Zeropage: nur $FA-$FD (Blitz!-verträglich)
ZP0      = $FA          ; Zeiger (Wort)
ZP1      = $FC          ; Zeiger (Wort)

; MMU
MMUCR    = $FF00
MMU_RCR  = $D506
CR_BANK0 = $00          ; Bank 0, alle ROMs, I/O
CR_LIB   = $7E          ; Bank 1, nur RAM, I/O
RCR_LIB  = $05          ; gemeinsames RAM unten, 4 KB (Bits 0-3; Bits 4-7 bleiben)

; Kernal
STASH    = $FF77
STAVEC   = $02B9

; Fehlercodes in A
E_OK      = 0
E_FORMAT  = 1           ; falsches Datenformat
E_TOOMANY = 2           ; zu viele Einträge
E_NOTIMPL = $FF         ; Funktion nicht vorhanden
