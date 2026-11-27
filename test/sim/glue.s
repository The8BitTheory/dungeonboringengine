; sim65 harness: calls the lib like the stub (A = F, X, Y), result A, X, Y in global variables
        .export _dbe_run, _dbe_f, _dbe_a, _dbe_x, _dbe_y
        .import dbe_entry, buf_b0
        .export _dbe_b0 := buf_b0
        .bss
_dbe_f: .res 1
_dbe_a: .res 1
_dbe_x: .res 1
_dbe_y: .res 1
        .code
_dbe_run:
        lda     _dbe_f
        ldx     _dbe_x
        ldy     _dbe_y
        jsr     dbe_entry
        sta     _dbe_a
        stx     _dbe_x
        sty     _dbe_y
        rts
