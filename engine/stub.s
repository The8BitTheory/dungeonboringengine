; dungeonboringengine – stub in bank 0 ($0D00, common RAM)
;
; SYS 3328          : init – copy the Kernal interrupt switch to bank 1, initialise the lib (= function 0)
; SYS 3331,F,X,Y    : call lib function F, result via RREG A,X,Y
;
; For the duration of the call the stub makes the lower 8 KB of RAM common ($D506)
; and sets $FF00 to bank 1 without I/O ($7F; lib code up to $DBFF, tables up to $DFFF). Parameter block ($0C00), engine buffer ($1300-$1BFF)
; and stub remain visible. Interrupts keep running through the copy of the Kernal switch
; in bank 1 ($FF05-$FFFF). The stub saves the zero page $63-$72 (ZPB, FAC/ARG) before the call and writes
; it back afterwards, but only for the functions that use it (VIEW, GEOMSET, test function 253; dbe.inc ZPB_F*,
; P6j); the lib uses it freely there (proof that no interrupt routine touches it and the other functions
; do not touch it: test/vice_zp.py, --funcs).

        .include "dbe.inc"

        .segment "LOADADDR"
        .word   STUB

        .segment "CODE"
        jmp     init
        jmp     call

init:   lda     #CR_BANK0       ; ROM visible, I/O on
        sta     MMUCR
        lda     #<$FF00         ; Kernal $FF05-$FFFF -> bank 1 (as in c128-vdc-gui)
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
        lda     #0              ; function 0 (INFO) returns version and sizes
        tax
        tay
        ; falls through to call

call:   sta     sv_a
        stx     sv_x
        sty     sv_y
        ldx     #0              ; P6j: save ZPB only for the functions that use it (ZPB_F1, ZPB_F2, test 253)
        cmp     #ZPB_F1
        beq     @zs
        cmp     #ZPB_F2
        beq     @zs
        cmp     #ZPB_FT
        bne     @nz
@zs:    ldx     #ZPBLEN/4-1     ; unrolled four times (9 cycles per byte)
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
        lda     #CR_BANK0       ; I/O on (BASIC's BANK 0 has no I/O)
        sta     MMUCR
        lda     MMU_RCR
        sta     sv_rcr
        and     #$F0
        ora     #RCR_LIB
        sta     MMU_RCR         ; first common RAM, then switch bank
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
        lda     #CR_BANK0       ; first back to bank 0, then shrink the common RAM
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
sv_f:   .byte   0               ; bit 7: ZPB saved
sv_zp:  .res    ZPBLEN
        .export call_lib, call_ret, call_rts    ; breakpoints for test/vice_zp.py, test/vice_view.py
