; dungeonboringengine 0.2 – gemeinsame Konstanten für Stub (Bank 0) und Lib (Bank 1)
; Speicherkarte: docs/specs/P6-engine.md Abschnitt 2

DBE_VERSION = 3         ; 0.2 (0.1 = 2)

; Bank 0, im gemeinsamen RAM (unten 8 KB während eines Aufrufs: $0000-$1FFF)
PARM     = $0C00        ; Parameterblock (2.3)
P0       = PARM+0       ; Wörter, Ein- und Ausgabe der Funktionen
P1       = PARM+2
P2       = PARM+4
P3       = PARM+6
ITEMPH   = PARM+$08     ; Phase für Gegenstände der Inhaltsebene (Spiel setzt)
VCLADR   = PARM+$0A     ; VIEW: Adresse der VCL-Liste (endet bei B1; VMS-Listen ab B0)
VCLLEN   = PARM+$0C     ; VIEW: Länge der VCL-Liste inklusive Ende-Byte
VMSLEN   = PARM+$0E     ; VIEW: Bytes der VMS-Listen
OBJVIS   = PARM+$10     ; VIEW: Bit i = Objekt i wurde ausgegeben
OBJN     = PARM+$50     ; Objektliste: Anzahl (0 ... 16)
OBJL     = PARM+$51     ; 16 x 6 Byte (2.5)
MAXOBJ   = 16
OBJLEN   = 6
STUB     = $0D00        ; Stub: $0D00 JMP init, $0D03 JMP call

; Puffer der Engine (VCL-Liste, dahinter VMS-Listen), Standard und Grenzen von BUFSET (3.3)
BUF_B0   = $1300
BUF_B1   = $1C00        ; exklusiv; ab $1C00 liegt VDC-BASIC v3
BUF_MIN0 = $1300        ; kleinster erlaubter Pufferanfang (BUFSET-Fenster $1300-$1BFF)
BUF_MINLEN = 64

; Bank 1 (Speicherkarte F, 2.4)
LIB      = $B000        ; Lib: $B000 JMP dispatch, danach "DBE", DBE_VERSION
LIB_END  = $DC00        ; Code bis $DBFF (RAM unter I/O, $FF00 = $7F); $DC00-$DFFF LIBTAB
BSS0     = $E000        ; Lib-Variablen $E000-$E7FF

; Zeropage: $FA-$FD (Blitz!-verträglich) und der Block ZPB während eines Aufrufs (der Stub rettet ihn vorher und
; schreibt ihn danach zurück; FAC/ARG des Interpreters, von keiner Interruptroutine benutzt: test/vice_zp.py)
ZP0      = $FA          ; Zeiger (Wort)
ZP1      = $FC          ; Zeiger (Wort)
ZPB      = $63          ; Block $63-$72
ZPBLEN   = 16

; MMU
MMUCR    = $FF00
MMU_RCR  = $D506
CR_BANK0 = $00          ; Bank 0, alle ROMs, I/O
CR_LIB   = $7F          ; Bank 1, nur RAM, ohne I/O (Lib-Code bis $DBFF, LIBTAB bis $DFFF)
CR_LIBIO = $7E          ; Bank 1 mit I/O (nur Testfunktion 250)
RCR_LIB  = $06          ; gemeinsames RAM unten, 8 KB (Bits 0-3; Bits 4-7 bleiben)

; Kernal
STASH    = $FF77
STAVEC   = $02B9

; Fehlercodes in A (3.1)
E_OK      = 0
E_FORMAT  = 1           ; Magic, Version oder Längen falsch
E_TOOMANY = 2           ; VIEW: Liste gekürzt bzw. Tabellen voll
E_PARTIAL = 3           ; VIEW: Ränder einzelner Bilder weggelassen
E_GEOM    = 4           ; Geometrie-ID, NE, D oder Stride passt nicht
E_STATE   = 5           ; Reihenfolge: GEOMSET bzw. MAPINIT fehlt
E_RANGE   = 6           ; Parameter außerhalb
E_NOTIMPL = $FF         ; Funktion nicht vorhanden
