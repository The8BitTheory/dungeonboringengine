; dungeonboringengine 0.2 – shared constants for stub (bank 0) and lib (bank 1)
; memory map: docs/specs/P6-engine.md section 2

DBE_VERSION = 3         ; 0.2 (0.1 = 2)

; bank 0, in common RAM (lower 8 KB during a call: $0000-$1FFF)
PARM     = $0C00        ; parameter block (2.3)
P0       = PARM+0       ; words, input and output of the functions
P1       = PARM+2
P2       = PARM+4
P3       = PARM+6
ITEMPH   = PARM+$08     ; phase for items of the content layer (set by the game)
VCLADR   = PARM+$0A     ; VIEW: address of the VCL list (ends at B1; VMS lists start at B0)
VCLLEN   = PARM+$0C     ; VIEW: length of the VCL list including the end byte
VMSLEN   = PARM+$0E     ; VIEW: bytes of the VMS lists
OBJVIS   = PARM+$10     ; VIEW: bit i = object i was output
OBJN     = PARM+$50     ; object list: count (0 ... 16)
OBJL     = PARM+$51     ; 16 x 6 bytes (2.5)
MAXOBJ   = 16
OBJLEN   = 6
STUB     = $0D00        ; Stub: $0D00 JMP init, $0D03 JMP call

; engine buffer (VCL list, followed by VMS lists), default and limits of BUFSET (3.3)
BUF_B0   = $1300
BUF_B1   = $1C00        ; exclusive; VDC-BASIC v3 starts at $1C00
BUF_MIN0 = $1300        ; smallest allowed buffer start (BUFSET window $1300-$1BFF)
BUF_MINLEN = 64

; bank 1 (memory map F, 2.4)
LIB      = $B000        ; lib: $B000 JMP dispatch, followed by "DBE", DBE_VERSION
LIB_END  = $DC00        ; code up to $DBFF (RAM under I/O, $FF00 = $7F); $DC00-$DFFF LIBTAB
BSS0     = $E000        ; lib variables $E000-$E7FF

; Zero page: $FA-$FD (Blitz!-compatible) and the ZPB block during a call (the stub saves it beforehand and
; writes it back afterwards; FAC/ARG of the interpreter, not used by any interrupt routine: test/vice_zp.py)
ZP0      = $FA          ; pointer (word)
ZP1      = $FC          ; pointer (word)
ZPB      = $63          ; block $63-$72
ZPBLEN   = 16           ; divisible by 4 (stub: unrolled four times)
; Functions that use ZPB (the stub saves the block only for them, P6j; proof: test/vice_zp.py --funcs).
; Anyone who re-implements a function that needs ZPB must register it here and in the stub (stub.s, call).
ZPB_F1   = 4            ; VIEW
ZPB_F2   = 12           ; GEOMSET
ZPB_FT   = 253          ; test function 253 (test build only)

; MMU
MMUCR    = $FF00
MMU_RCR  = $D506
CR_BANK0 = $00          ; bank 0, all ROMs, I/O
CR_LIB   = $7F          ; bank 1, RAM only, no I/O (lib code up to $DBFF, LIBTAB up to $DFFF)
CR_LIBIO = $7E          ; bank 1 with I/O (test function 250 only)
RCR_LIB  = $06          ; common RAM at the bottom, 8 KB (bits 0-3; bits 4-7 are kept)

; Kernal
STASH    = $FF77
STAVEC   = $02B9

; error codes in A (3.1)
E_OK      = 0
E_FORMAT  = 1           ; magic, version or lengths wrong
E_TOOMANY = 2           ; VIEW: list truncated or tables full
E_PARTIAL = 3           ; VIEW: edges of individual images omitted
E_GEOM    = 4           ; geometry ID, NE, D or stride does not fit
E_STATE   = 5           ; call order: GEOMSET or MAPINIT missing
E_RANGE   = 6           ; parameter out of range
E_NOTIMPL = $FF         ; function not present
