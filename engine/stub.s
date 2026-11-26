; dungeonboringengine – Stub in Bank 0 ($0D00, gemeinsames RAM)
;
; SYS 3328          : init – Kernal-Interruptweiche nach Bank 1 kopieren, Lib initialisieren (= Funktion 0)
; SYS 3331,F,X,Y    : Lib-Funktion F aufrufen, Ergebnis per RREG A,X,Y
;
; Der Stub schaltet für die Dauer des Aufrufs das untere 8-KB-RAM gemeinsam ($D506)
; und $FF00 auf Bank 1 ohne I/O ($7F; Lib-Code bis $DBFF, Tabellen bis $DFFF). Parameterblock ($0C00), Puffer der Engine ($1300-$1BFF)
; und Stub bleiben dabei sichtbar. Interrupts laufen über die Kopie der Kernal-Weiche
; in Bank 1 ($FF05-$FFFF) weiter. Die Zeropage $63-$72 (ZPB, FAC/ARG) rettet der Stub vor dem Aufruf und schreibt
; sie danach zurück, aber nur für die Funktionen, die sie benutzen (VIEW, GEOMSET, Testfunktion 253; dbe.inc ZPB_F*,
; P6j); die Lib benutzt sie dort frei (Nachweis, dass keine Interruptroutine sie anfasst und die übrigen Funktionen
; sie nicht berühren: test/vice_zp.py, --funcs).

        .include "dbe.inc"

        .segment "LOADADDR"
        .word   STUB

        .segment "CODE"
        jmp     init
        jmp     call

init:   lda     #CR_BANK0       ; ROM sichtbar, I/O an
        sta     MMUCR
        lda     #<$FF00         ; Kernal $FF05-$FFFF -> Bank 1 (wie c128-vdc-gui)
        sta     ZP0
        lda     #>$FF00
        sta     ZP0+1
        lda     #ZP0
        sta     STAVEC
        ldy     #5
@rom:   lda     $FF00,y
        ldx     #1
        jsr     STASH
        iny
        bne     @rom
        lda     #0              ; Funktion 0 (INFO) liefert Version und Größen
        tax
        tay
        ; weiter in call

call:   sta     sv_a
        stx     sv_x
        sty     sv_y
        ldx     #0              ; P6j: ZPB nur für die Funktionen retten, die ihn benutzen (ZPB_F1, ZPB_F2, Test 253)
        cmp     #ZPB_F1
        beq     @zs
        cmp     #ZPB_F2
        beq     @zs
        cmp     #ZPB_FT
        bne     @nz
@zs:    ldx     #ZPBLEN/4-1     ; vierfach entrollt (9 Zyklen je Byte)
@sv:    lda     ZPB,x
        sta     sv_zp,x
        lda     ZPB+ZPBLEN/4,x
        sta     sv_zp+ZPBLEN/4,x
        lda     ZPB+ZPBLEN/2,x
        sta     sv_zp+ZPBLEN/2,x
        lda     ZPB+3*ZPBLEN/4,x
        sta     sv_zp+3*ZPBLEN/4,x
        dex
        bpl     @sv             ; X = $FF
@nz:    stx     sv_f
        lda     MMUCR
        sta     sv_cr
        lda     #CR_BANK0       ; I/O an (BANK 0 von BASIC hat kein I/O)
        sta     MMUCR
        lda     MMU_RCR
        sta     sv_rcr
        and     #$F0
        ora     #RCR_LIB
        sta     MMU_RCR         ; erst gemeinsames RAM, dann Bank wechseln
        lda     #CR_LIB
        sta     MMUCR
        lda     sv_a
        ldx     sv_x
        ldy     sv_y
call_lib:
        jsr     LIB
call_ret:
        sta     sv_a
        stx     sv_x
        sty     sv_y
        lda     #CR_BANK0       ; erst zurück nach Bank 0, dann gemeinsames RAM verkleinern
        sta     MMUCR
        lda     sv_rcr
        sta     MMU_RCR
        lda     sv_cr
        sta     MMUCR
        bit     sv_f
        bpl     @nr
        ldx     #ZPBLEN/4-1
@rs:    lda     sv_zp,x
        sta     ZPB,x
        lda     sv_zp+ZPBLEN/4,x
        sta     ZPB+ZPBLEN/4,x
        lda     sv_zp+ZPBLEN/2,x
        sta     ZPB+ZPBLEN/2,x
        lda     sv_zp+3*ZPBLEN/4,x
        sta     ZPB+3*ZPBLEN/4,x
        dex
        bpl     @rs
@nr:    lda     sv_a
        ldx     sv_x
        ldy     sv_y
call_rts:
        rts

sv_a:   .byte   0
sv_x:   .byte   0
sv_y:   .byte   0
sv_cr:  .byte   0
sv_rcr: .byte   0
sv_f:   .byte   0               ; Bit 7: ZPB gerettet
sv_zp:  .res    ZPBLEN
        .export call_lib, call_ret, call_rts    ; Haltepunkte für test/vice_zp.py, test/vice_view.py
