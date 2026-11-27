; dungeonboringengine 0.2 – Lib in Bank 1 ($B000)
;
; Called only via the stub (SYS 3331,F,X,Y). Runs with $FF00 = $7F (Bank 1, RAM only, no I/O; code up to $DBFF, LIBTAB $DC00-$DFFF)
; and shared RAM in the lower 8 KB ($0000-$1FFF); parameter block P0..P3 at $0C00 (Bank 0).
; Memory map, functions and error codes: docs/specs/P6-engine.md (2, 3).
;
; Status P6a (skeleton): dispatcher with the function table from 3, of which implemented
;   0 INIT      state cleared (BSS, OBJN = 0, buffer = default, pool off); X = DBE_VERSION;
;               P0 = code end, P1 = BSS end
;  11 POOLSET   P0 = pool start, P1 = pool end (exclusive, 0 = 65536); both 0 = no check
;  15 BUFSET    P0 = buffer start, P1 = buffer end (exclusive); A = 6 if start < $1300,
;               end > $1C00 or length < 64 (old buffer is kept); X bit 0 = fixed list address (P6j)
; Status P6c (map and assets): MAPINIT, SETPOS, CELL, SETCELL, SETITEM, GEOMSET, TEXSET, BGSET,
; SPRITESET, ITEMSET (checks 3.2; error order: E_STATE, E_RANGE (number), E_FORMAT, E_GEOM, E_RANGE (pool)).
; Decisions for P6c: see docs/specs/P6-engine.md "Result P6c".
; All other functions (and F >= 17): A = E_NOTIMPL, until their substep (P6d-P6f) implements them.
; Status P6d: VIEW without objects (engine/view.s, docs/specs/P6-engine.md "Result P6d").
; Status P6e: VIEW with objects and items (5.8; "Result P6e").
; Status P6f: MOVE (3.4) and automap bit 6 in VIEW (only MAPINIT X bit 0 with working copy; "Result P6f").
; Status P6j: BUFSET X bit 0 = fixed list address (VIEW copies the VCL list to B0; "Result P6j").
;
; Assemble with -DDBE_TEST (tests only, never in the game, with lib-test.cfg): functions 250 (MMU/common RAM probe),
; 251 (wait loop of P0 x about 1300 cycles), 252 (code under I/O at $DBF8) for the VICE smoke test and 253
; (zero page block ZPB under interrupts, test/vice_zp.py).
; Assemble with -DSIM: without LOADADDR (sim65 harness, test/sim).

        .include "dbe.inc"
        .macpack longbranch
.ifdef SIM
.define LIBSEG "LIBCODE"        ; sim65 harness: lib code at $B000 (test/sim/sim.cfg), separate from the C code
.else
.define LIBSEG "CODE"
.endif

; Zero page block ZPB ($63-$72, saved by the stub and written back): pointers and hot variables of VIEW
vp      = ZPB+0         ; VCL write pointer (downwards, points to the most recently written entry)
mp      = ZPB+2         ; VMS write pointer (upwards)
tp      = ZPB+4         ; tile of the cell (tile table + 8 t)
dp      = ZPB+6         ; directory entry of the image (resolve)
op      = ZPB+8         ; helper pointer of the producers (clipped VMS list), GEOMSET
zt      = ZPB+10        ; 6 bytes of hot single values (view.s)

gei     = zt+0          ; gcells (GEOMSET): element index, remainder, kind, slot, s of the cell, s + 15
gn      = zt+1
gart    = zt+2
gj      = zt+3
gcs     = zt+4
gsi     = zt+5

MAXCELL = 48            ; cell table (GEOMSET): cells of all depths
MAXWALL = 96            ; wall elements (kind 0/1) of all depths
MAXPEND = 16            ; pending area per depth (covering sides or fronts without DVG bit 3)

.ifndef SIM
        .segment "LOADADDR"
.ifdef DBE_TEST
        .word   LIB-$100        ; test build: test functions in front ($AF00, TESTLO in lib-test.cfg)
.else
        .word   LIB
.endif
.endif

        .export dbe_entry := entry
        .export bss_start, bss_end, code_end            ; for tests (label file)
        .export argx, buf_b0, buf_b1, buf_fix, pool_a, pool_b, pool_on
        .export t0, val, ptrs, recs, rows, itemtab, geom_ok, map_ok, map_w, map_h, map_wh, map_nt, map_ne, map_auto
        .export pos, vdir, px, py, map_out, dvg_vw, dvg_origin, dvg_id, dbg_ok, dbg_vram, dbg_base, dbg_p, bgfill
        .export ffon, ffill, hs

        .segment "LIBBSS"
bss_start:                      ; first part of LIBBSS (view.s adds more variables)
        .segment LIBSEG
entry:  jmp     dispatch
        .byte   "DBE", DBE_VERSION

dispatch:
        stx     argx
        sty     argy
        cmp     #NFUNC
.ifdef DBE_TEST
        bcc     @norm
        jmp     t_disp          ; F >= NFUNC: test functions 250-253 (TESTLO), otherwise notimpl
@norm:
.else
        bcs     notimpl
.endif
        asl
        tax
        lda     functab+1,x
        pha
        lda     functab,x
        pha
        rts

notimpl:
        lda     #E_NOTIMPL
        ldx     #0
        ldy     #0
        rts

; Table from 3: F = 0 ... 16; unimplemented entries = notimpl
functab:
        .word   f_init-1,     f_mapinit-1,  f_setpos-1,   f_move-1      ; 0 INIT, 1 MAPINIT, 2 SETPOS, 3 MOVE
        .word   f_view-1,     f_cell-1,     f_setcell-1,  notimpl-1     ; 4 VIEW, 5 CELL, 6 SETCELL, 7 (ENEMYSTEP)
        .word   notimpl-1,    f_spriteset-1,f_itemset-1,  f_poolset-1   ; 8 (WALLSET), 9 SPRITESET, 10 ITEMSET, 11 POOLSET
        .word   f_geomset-1,  f_texset-1,   f_bgset-1,    f_bufset-1    ; 12 GEOMSET, 13 TEXSET, 14 BGSET, 15 BUFSET
        .word   f_setitem-1                                             ; 16 SETITEM
NFUNC = (* - functab) / 2

ok:     lda     #E_OK
ret0:   ldx     #0
        ldy     #0
        rts

e_state: lda    #E_STATE
        bne     ret0
e_format: lda   #E_FORMAT
        bne     ret0
e_geom: lda     #E_GEOM
        bne     ret0

; ---------------------------------------------------------------- 0 INIT
f_init:
        lda     #<bss_start
        sta     ZP0
        lda     #>bss_start
        sta     ZP0+1
        ldy     #0
@clr:   tya
        sta     (ZP0),y
        inc     ZP0
        bne     :+
        inc     ZP0+1
:       lda     ZP0
        cmp     #<bss_end
        bne     @clr
        lda     ZP0+1
        cmp     #>bss_end
        bne     @clr
        lda     #0
        ldx     #9              ; clear ITEMPH ... OBJVIS ($0C08-$0C11)
@parm:  sta     PARM+$08,x
        dex
        bpl     @parm
        sta     OBJN
        lda     #<BUF_B0        ; default buffer
        sta     buf_b0
        sta     VCLADR
        lda     #>BUF_B0
        sta     buf_b0+1
        sta     VCLADR+1
        lda     #<BUF_B1
        sta     buf_b1
        lda     #>BUF_B1
        sta     buf_b1+1
        lda     #<code_end
        sta     P0
        lda     #>code_end
        sta     P0+1
        lda     #<bss_end
        sta     P1
        lda     #>bss_end
        sta     P1+1
        lda     #E_OK
        ldx     #DBE_VERSION
        ldy     #0
        rts

range:  lda     #E_RANGE
        bne     ret0

; ---------------------------------------------------------------- 11 POOLSET
f_poolset:
        lda     P0
        ora     P0+1
        ora     P1
        ora     P1+1
        bne     @on
        sta     pool_on         ; both 0: no check
        jmp     ok
@on:    lda     P1
        ora     P1+1
        beq     @set            ; end 0 = 65536: always greater than the start
        lda     P0              ; start >= end (empty or negative pool): E_RANGE
        cmp     P1
        lda     P0+1
        sbc     P1+1
        bcs     range
@set:   lda     P0
        sta     pool_a
        lda     P0+1
        sta     pool_a+1
        lda     P1
        sta     pool_b
        lda     P1+1
        sta     pool_b+1
        lda     #1
        sta     pool_on
        jmp     ok

; ---------------------------------------------------------------- 15 BUFSET
f_bufset:
        lda     P0
        cmp     #<BUF_MIN0
        lda     P0+1
        sbc     #>BUF_MIN0
        bcc     range           ; start < $1300
        lda     #<BUF_B1
        cmp     P1
        lda     #>BUF_B1
        sbc     P1+1
        bcc     range           ; end > $1C00
        sec
        lda     P1
        sbc     P0
        tax
        lda     P1+1
        sbc     P0+1
        bcc     range           ; end < start
        bne     @len
        cpx     #BUF_MINLEN
        bcc     range           ; length < 64
@len:   lda     P0
        sta     buf_b0
        lda     P0+1
        sta     buf_b0+1
        lda     P1
        sta     buf_b1
        lda     P1+1
        sta     buf_b1+1
        lda     argx            ; P6j: X bit 0 = fixed list address (VIEW puts the VCL list at B0)
        lsr
        ror     buf_fix         ; Bit 7
        jmp     ok

; ================================================================ P6c: map and assets
; ---------------------------------------------------------------- Helpers
p0_zp0: lda     P0              ; ZP0 = P0
        sta     ZP0
        lda     P0+1
        sta     ZP0+1
        rts

; X = index into eqtab; (ZP0) = data. C = 1: a byte differs (magic, version, fixed lengths)
chkeq:  lda     eqtab,x
        bmi     @ok
        tay
        lda     eqtab+1,x
        cmp     (ZP0),y
        bne     @bad
        inx
        inx
        bne     chkeq
@ok:    clc
        rts
@bad:   sec
        rts

; X = index into geotab; (ZP0) = data. C = 1: a header field differs from the geometry (dvg_vw + index)
chkgeo: lda     geotab,x
        bmi     @ok
        tay
        lda     geotab+1,x
        stx     t3
        tax
        lda     dvg_vw,x
        ldx     t3
        cmp     (ZP0),y
        bne     @bad
        inx
        inx
        bne     chkgeo
@ok:    clc
        rts
@bad:   sec
        rts

; Y = header offset: acc = word in the header
ldacc:  lda     (ZP0),y
        sta     acc
        iny
        lda     (ZP0),y
        sta     acc+1
        rts

; Y = header offset: C = 1 if the word in the header <> acc
chkw:   lda     (ZP0),y
        cmp     acc
        bne     @bad
        iny
        lda     (ZP0),y
        cmp     acc+1
        bne     @bad
        clc
        rts
@bad:   sec
        rts

; Addresses: ptrs+X ... (A) = content start (ZP0) + words from the header starting at Y; end at ptrs+A
addtab: sta     t3
@w:     clc
        lda     (ZP0),y
        adc     ZP0
        sta     ptrs,x
        iny
        lda     (ZP0),y
        adc     ZP0+1
        sta     ptrs+1,x
        iny
        inx
        inx
        cpx     t3
        bne     @w
        rts

; Pool (3.2): U = acc, base = P1. C = 1: violation
chk_pool:
        lda     pool_on
        beq     @ok
        lda     P1
        cmp     pool_a
        lda     P1+1
        sbc     pool_a+1
        bcc     @bad            ; base < pool start
        clc
        lda     P1
        adc     acc
        sta     acc
        lda     P1+1
        adc     acc+1
        sta     acc+1
        bcs     @ovf            ; base + U >= 65536
        lda     pool_b
        ora     pool_b+1
        beq     @ok             ; end 65536
        lda     pool_b
        cmp     acc
        lda     pool_b+1
        sbc     acc+1
        bcc     @bad            ; base + U > pool end
@ok:    clc
        rts
@ovf:   lda     acc             ; exactly 65536 only with pool end 65536
        ora     acc+1
        ora     pool_b
        ora     pool_b+1
        bne     @bad
        clc
        rts
@bad:   sec
        rts

; Record start X (recs): valid, VRAM base (P1), content start (ZP0), three table addresses from the header starting at Y; X is preserved
fillrec:
        txa
        pha
        lda     #1
        sta     recs,x
        lda     P1
        sta     recs+1,x
        lda     P1+1
        sta     recs+2,x
        lda     ZP0
        sta     recs+8,x
        lda     ZP0+1
        sta     recs+9,x
        txa
        clc
        adc     #recs-ptrs+10
        tax
        adc     #6              ; C = 0
        jsr     addtab
        pla
        tax
        rts

; P0 >= W*H: C = 1
cell_range:
        lda     P0
        cmp     map_wh
        lda     P0+1
        sbc     map_wh+1
        rts

; ZP0 = layer Y (0 tile, 2 content layer) + cell P0
getcell:
        clc
        lda     map_cells,y
        adc     P0
        sta     ZP0
        lda     map_cells+1,y
        adc     P0+1
        sta     ZP0+1
        rts

; A = tile index -> A = flags of the tile
tileflags:
        sta     ZP1
        lda     #0
        sta     ZP1+1
        ldx     #3
@s:     asl     ZP1
        rol     ZP1+1
        dex
        bne     @s
        clc
        lda     ZP1
        adc     map_tiles
        sta     ZP1
        lda     ZP1+1
        adc     map_tiles+1
        sta     ZP1+1
        ldy     #6
        lda     (ZP1),y
        rts

; px, py from pos (repeated subtraction)
calcxy: lda     pos
        sta     acc
        lda     pos+1
        sta     acc+1
        ldx     #0
@l:     lda     acc+1
        bne     @s
        lda     acc
        cmp     map_w
        bcc     @d
@s:     sec
        lda     acc
        sbc     map_w
        sta     acc
        lda     acc+1
        sbc     #0
        sta     acc+1
        inx
        bne     @l
@d:     lda     acc
        sta     px
        stx     py
        rts

; ---------------------------------------------------------------- 1 MAPINIT
f_mapinit:
        lda     #0
        sta     map_ok
        jsr     p0_zp0
        ldx     #mg_dmp-eqtab
        jsr     chkeq
        jcs     e_format
        ldy     #3
        lda     (ZP0),y
        sta     map_w
        jeq     e_format
        iny
        lda     (ZP0),y
        sta     map_h
        jeq     e_format
        lda     #0              ; wh = W * H
        sta     map_wh
        sta     map_wh+1
        ldx     map_h
@m:     clc
        lda     map_wh
        adc     map_w
        sta     map_wh
        bcc     @n
        inc     map_wh+1
@n:     dex
        bne     @m
        lda     map_wh+1        ; <= 16384
        cmp     #$40
        bcc     @sz
        jne     e_format
        lda     map_wh
        jne     e_format
@sz:    iny                     ; NT (0 = 256)
        lda     (ZP0),y
        sta     map_nt
        ldx     #0
        cmp     #1
        bcs     @nt
        inx
@nt:    stx     map_nt+1
        ldy     #11             ; NE, start, direction, outer tile (bytes 6-11)
        ldx     #5
@h:     lda     (ZP0),y
        sta     map_ne,x
        dey
        dex
        bpl     @h
        lda     pos             ; start < W*H
        cmp     map_wh
        lda     pos+1
        sbc     map_wh+1
        jcs     e_format
        lda     vdir
        cmp     #4
        jcs     e_format
        lda     map_nt+1        ; outer tile < NT
        bne     @o
        lda     map_out
        cmp     map_nt
        jcs     e_format
@o:     lda     #24             ; offsets gapless: 24, +WH, +WH, +8 NT, +4 NE = length
        sta     acc
        lda     #0
        sta     acc+1
        ldy     #12
        jsr     chkw
        jcs     e_format
        ldx     #0
@s:     ldy     offtab,x        ; addend (index from map_wh), left shift, header offset
        lda     map_wh,y
        sta     val
        lda     map_wh+1,y
        sta     val+1
        ldy     offtab+1,x
        beq     @ad
@sh:    asl     val
        rol     val+1
        bcs     @fmt            ; 4 NE >= 65536
        dey
        bne     @sh
@ad:    clc
        lda     acc
        adc     val
        sta     acc
        lda     acc+1
        adc     val+1
        sta     acc+1
        bcs     @fmt            ; length >= 65536
        ldy     offtab+2,x
        jsr     chkw
@fmt:   jcs     e_format
        inx
        inx
        inx
        cpx     #12
        bne     @s
        ldx     #0              ; addresses: tile layer, content layer, tile table, events
        ldy     #12
        lda     #8
        jsr     addtab
        lda     P1
        ora     P1+1
        jeq     @nocopy
        lda     map_wh          ; working copy: 2 * W * H bytes
        asl
        sta     acc
        lda     map_wh+1
        rol
        sta     acc+1
        lda     P1+1            ; target >= $4000 (below that are BASIC variables) ...
        cmp     #$40
        jcc     range
        clc                     ; ... and target + 2 W H <= LIB (lib, BSS, DVG, I/O, MMU untouched)
        lda     P1
        adc     acc
        tax
        lda     P1+1
        adc     acc+1
        jcs     range
        cpx     #<(LIB+1)
        sbc     #>(LIB+1)
        jcs     range
        lda     map_cells       ; ZP0 = source, ZP1 = target
        sta     ZP0
        lda     map_cells+1
        sta     ZP0+1
        lda     P1
        sta     ZP1
        lda     P1+1
        sta     ZP1+1
        ldy     #0
        lda     acc+1
        beq     @rest
@pg:    lda     (ZP0),y
        sta     (ZP1),y
        iny
        bne     @pg
        inc     ZP0+1
        inc     ZP1+1
        dec     acc+1
        bne     @pg
@rest:  lda     acc
        beq     @cd
@r:     lda     (ZP0),y
        sta     (ZP1),y
        iny
        cpy     acc
        bne     @r
@cd:    lda     P1
        sta     map_cells
        clc
        adc     map_wh
        sta     map_cont
        lda     P1+1
        sta     map_cells+1
        adc     map_wh+1
        sta     map_cont+1
@nocopy:
        jsr     mtiles          ; tile tables for VIEW
        lda     argx            ; automap only with bit 0 and working copy (P1 <> 0, P1 still input)
        and     #1
        ldx     P1
        bne     @au
        ldx     P1+1
        bne     @au
        lda     #0
@au:    sta     map_auto
        lda     #1
        sta     map_ok
        lda     #0
        sta     OBJN
        jsr     calcxy
        lda     pos
        sta     P0
        lda     pos+1
        sta     P0+1
        lda     vdir
        sta     P1
        lda     #0
        sta     P1+1
        ldx     map_w
        ldy     map_h
        rts

; Tile tables (VIEW): tpl/tph = address of tile record t, tsm = bit 7 surfaces (one wall <> 0),
; bit 6 blocked (COVERING and all four walls), bits 0-5 = tile flags (COVERING $04, CONTENT $20)
mtiles: lda     map_tiles
        sta     ZP1
        lda     map_tiles+1
        sta     ZP1+1
        ldx     #0
@t:     lda     ZP1
        sta     tpl,x
        lda     ZP1+1
        sta     tph,x
        ldy     #6
        lda     (ZP1),y
        and     #$3F
        sta     t0
        ldy     #3
        lda     #0
        sta     t1              ; walls <> 0
@w:     lda     (ZP1),y
        beq     @w0
        inc     t1
@w0:    dey
        bpl     @w
        lda     t1
        beq     @s
        lda     t0
        ora     #$80
        ldy     t1
        cpy     #4
        bne     @s1
        and     #$04            ; all four and COVERING: blocked
        beq     @s0
        lda     t0
        ora     #$C0
        bne     @s1
@s0:    lda     t0
        ora     #$80
@s1:    sta     t0
@s:     lda     t0
        sta     tsm,x
        clc
        lda     ZP1
        adc     #8
        sta     ZP1
        bcc     @n
        inc     ZP1+1
@n:     inx
        beq     @e              ; 256 tiles
        cpx     map_nt
        bne     @t
@e:     rts

; Table of the offset check: addend (byte index from map_wh), left shift, header offset of the sum
offtab: .byte   0,0,14, 0,0,16, 2,3,18, 4,2,20

; ---------------------------------------------------------------- 2 SETPOS
f_setpos:
        lda     map_ok
        jeq     e_state
        jsr     cell_range
        jcs     range
        lda     argx
        cmp     #4
        jcs     range
        sta     vdir
        lda     P0
        sta     pos
        lda     P0+1
        sta     pos+1
        jsr     calcxy
        jmp     ok

; ---------------------------------------------------------------- 3 MOVE (P6f, 3.4)
; X = action: 0/1 forward/back, 2/3 left/right, 4/5/6 turn left/right/around; A = 6 if X >= 7.
; Result X: 0 ok, 1 map/SOLID, 2 object; Y: tile (position or target) or object index; P0 = position,
; P1 = content byte of the position, P2 = index of the first event of the position ($FFFF none)
f_move: lda     map_ok
        jeq     e_state
        ldx     argx
        cpx     #7
        jcs     range
        lda     vdir
        clc
        adc     mvtab,x
        and     #3
        cpx     #4
        jcc     @step
        sta     vdir            ; turn
        ldx     #0
@fin:   stx     t1              ; result X, Y (t2)
        sty     t2
        lda     pos
        sta     P0
        lda     pos+1
        sta     P0+1
        txa
        bne     @nt
        tay                     ; X = 0: Y = tile of the position
        jsr     getcell
        lda     (ZP0),y
        sta     t2
@nt:    ldy     #2              ; P1 = content byte
        jsr     getcell
        ldy     #0
        lda     (ZP0),y
        sta     P1
        sty     P1+1
        dey                     ; P2 = index of the first event of the cell ($FFFF none)
        sty     P2
        sty     P2+1
        lda     map_ev
        sta     ZP0
        lda     map_ev+1
        sta     ZP0+1
        iny
        sty     acc
        sty     acc+1
@e:     lda     acc
        cmp     map_ne
        lda     acc+1
        sbc     map_ne+1
        bcs     @d
        ldy     #1              ; list sorted by cell (P4 2.5): stop at the first greater entry
        lda     (ZP0),y
        cmp     pos+1
        bcc     @nx
        bne     @d
        dey
        lda     (ZP0),y
        cmp     pos
        bcc     @nx
        bne     @d
        lda     acc
        sta     P2
        lda     acc+1
        sta     P2+1
@d:     ldx     t1
        ldy     t2
        lda     #E_OK
        rts
@nx:    clc
        lda     ZP0
        adc     #4
        sta     ZP0
        bcc     @i
        inc     ZP0+1
@i:     inc     acc
        bne     @e
        inc     acc+1
        bne     @e
@step:  tax                     ; X = target direction d; target cell (acc = x, y), outside: 8 bit, $FF >= W
        clc
        lda     px
        adc     mvdel,x
        sta     acc
        cmp     map_w
        bcs     @out
        clc
        lda     py
        adc     mvdel+3,x
        sta     acc+1
        cmp     map_h
        bcc     @in
@out:   ldx     #1              ; outside: outer tile
        ldy     map_out
        jmp     @fin
@in:    txa                     ; cell index = pos + step: E +1, W -1, S +W, N -W
        lsr
        lda     #1
        bcs     @a
        lda     map_w
@a:     ldy     #0
        cpx     #0
        beq     @ng
        cpx     #3
        bne     @pl
@ng:    eor     #$FF            ; negative
        clc
        adc     #1
        dey
@pl:    clc
        adc     pos
        sta     P0
        tya
        adc     pos+1
        sta     P0+1
        ldy     #0              ; tile of the target
        jsr     getcell
        lda     (ZP0),y
        sta     t0
        jsr     tileflags
        lsr                     ; SOLID = bit 0
        bcc     @ow
        ldx     #1
        ldy     t0
        jmp     @fin
@ow:    lda     OBJN            ; objects of the list (at most 16): first one without bit 6/7 on the target cell
        cmp     #MAXOBJ+1
        bcc     @oc
        lda     #MAXOBJ
@oc:    sta     t1
        ldx     #0
        ldy     #0
@ol:    cpy     t1
        beq     @go
        lda     OBJL,x
        cmp     P0
        bne     @on
        lda     OBJL+1,x
        cmp     P0+1
        bne     @on
        lda     OBJL+5,x
        and     #$C0
        beq     @ob
@on:    txa
        clc
        adc     #OBJLEN
        tax
        iny
        bne     @ol
@ob:    ldx     #2              ; Y = object index
        jmp     @fin
@go:    lda     P0              ; perform the step
        sta     pos
        lda     P0+1
        sta     pos+1
        lda     acc
        sta     px
        lda     acc+1
        sta     py
        ldx     #0
        jmp     @fin
; Direction increment per action; dx per direction N E S W (mvdel[d]), dy = mvdel[d + 3]
mvtab:  .byte   0, 2, 3, 1, 3, 1, 2
mvdel:  .byte   0, 1, 0, $FF, 0, 1, 0

; ---------------------------------------------------------------- 5 CELL
f_cell: lda     map_ok
        jeq     e_state
        jsr     cell_range
        bcs     @out
        ldy     #0
        jsr     getcell
        ldy     #0
        lda     (ZP0),y
        sta     t0
        ldy     #2
        jsr     getcell
        ldy     #0
        lda     (ZP0),y
        sta     t1
        lda     #E_OK
        beq     @fin
@out:   lda     map_out
        sta     t0
        lda     #0
        sta     t1
        lda     #E_RANGE
@fin:   pha
        lda     t0
        jsr     tileflags
        sta     P1
        lda     #0
        sta     P1+1
        ldx     t0
        ldy     t1
        pla
        rts

; ---------------------------------------------------------------- 6 SETCELL, 16 SETITEM
f_setcell:
        lda     map_ok
        jeq     e_state
        lda     map_nt+1
        bne     @in
        lda     argx
        cmp     map_nt
        jcs     range
@in:    ldy     #0
        beq     setl
f_setitem:
        lda     map_ok
        jeq     e_state
        ldy     #2
setl:   jsr     cell_range
        jcs     range
        jsr     getcell
        ldy     #0
        lda     argx
        sta     (ZP0),y
        jmp     ok

; ---------------------------------------------------------------- 10 ITEMSET
f_itemset:
        lda     argx
        cmp     #64
        jcs     range
        lda     argy
        cmp     #9
        jcs     range
        ldx     argx
        lda     itemtab,x       ; itemn = number of entries <> 0 (VIEW: items only if itemn > 0)
        beq     @o
        dec     itemn
@o:     lda     argy
        sta     itemtab,x
        beq     @r
        inc     itemn
@r:     jmp     ok

; ---------------------------------------------------------------- 12 GEOMSET
f_geomset:
        jsr     p0_zp0
        ldx     #mg_dvg-eqtab
        jsr     chkeq
        jcs     e_format
        ldy     #3              ; 1 <= VW <= 80
        lda     (ZP0),y
        jeq     e_format
        cmp     #81
        jcs     e_format
        iny                     ; 1 <= VH <= 100
        lda     (ZP0),y
        jeq     e_format
        cmp     #101
        jcs     e_format
        iny                     ; D <= 7
        lda     (ZP0),y
        cmp     #8
        jcs     e_format
        iny                     ; S <= 15 (VIEW: at most 31 cells per depth)
        lda     (ZP0),y
        cmp     #16
        jcs     e_format
        iny                     ; NE >= 1
        lda     (ZP0),y
        jeq     e_format
        jsr     gcells          ; check the element table and build the cell table; error: no valid geometry
        bcc     @ge
        lda     #0
        sta     geom_ok
        jmp     e_format
@ge:
        ldx     #0              ; t0 = 1: different ID than before
        ldy     #12
        lda     (ZP0),y
        cmp     dvg_id
        bne     @d
        iny
        lda     (ZP0),y
        cmp     dvg_id+1
        beq     @s
@d:     inx
@s:     stx     t0
        ldy     #15             ; VW, VH, D, S, NE, stride, origin, ID, y0, y1 (bytes 3-15)
        ldx     #12
@c:     lda     (ZP0),y
        sta     dvg_vw,x
        dey
        dex
        bpl     @c
        lda     P1
        and     P1+1
        cmp     #$FF
        beq     @nor
        lda     P1
        sta     dvg_origin
        lda     P1+1
        sta     dvg_origin+1
@nor:   ldx     #dvg_depth-ptrs ; depth table, element table
        ldy     #18
        lda     #dvg_depth-ptrs+4
        jsr     addtab
        lda     #0
        sta     t1              ; deleted S2 records
        sta     t2              ; deleted DTS (bits 0-2), DBG (bit 3)
        lda     t0
        jeq     @rows
        lda     #1
        sta     t3
        ldx     #0
@dts:   lda     recs,x
        beq     @nd
        lda     #0
        sta     recs,x
        lda     t3
        ora     t2
        sta     t2
@nd:    asl     t3
        txa
        clc
        adc     #16
        tax
        cpx     #48
        bne     @dts
        lda     dbg_ok
        beq     @s2
        lda     #0
        sta     dbg_ok
        lda     t3
        ora     t2
        sta     t2
@s2:    lda     #1
        sta     t3
@sl:    lda     recs,x
        beq     @ns
        lda     recs+5,x        ; ID <> 0 and different geometry: delete
        ora     recs+6,x
        bne     @kill
        lda     recs+8,x        ; ID 0: delete only for different D or stride
        sta     ZP1
        lda     recs+9,x
        sta     ZP1+1
        ldy     #6
        lda     (ZP1),y
        cmp     dvg_d
        bne     @kill
        ldy     #34
        lda     (ZP1),y
        cmp     dvg_stride
        bne     @kill
        iny
        lda     (ZP1),y
        cmp     dvg_stride+1
        beq     @ns
@kill:  lda     #0
        sta     recs,x
        lda     t3
        ora     t1
        sta     t1
@ns:    asl     t3
        txa
        clc
        adc     #16
        tax
        cpx     #176
        bne     @sl
@rows:  lda     dvg_stride      ; row[y] = origin + y * stride (intermediate values in the zero page block)
        sta     vp
        lda     dvg_stride+1
        sta     vp+1
        lda     dvg_origin+1
        sta     mp
        lda     dvg_vh
        asl
        sta     mp+1
        lda     dvg_origin
        ldx     #0
@r:     sta     rows,x
        tay
        lda     mp
        sta     rows+1,x
        adc     vp+1            ; C = 0 (from cpx: x < 2 VH)
        sta     mp
        tya
        clc
        adc     vp
        bcc     @r1
        inc     mp
        clc
@r1:    inx
        inx
        cpx     mp+1
        bcc     @r
        lda     #1
        sta     geom_ok
        ldx     t1
        ldy     t2
        lda     #E_OK
        rts


; ---------------------------------------------------------------- Cell table (GEOMSET)
; Checks and builds at the same time (single pass; on error the geometry is invalid). ZP0 = DVG (content). C = 1: format error (P6-engine.md 7):
; first + n <= NE per depth, kind <= 4, |s| <= S, elements of a cell contiguous (P3 5.3), at most 16 elements,
; one floor and one ceiling element per cell; kind 0-3: x + w <= VW, y + h <= VH; walls: c0 <= c1 <= VW;
; pending area (covering sides, covering fronts without bit 3) <= MAXPEND per depth; <= MAXCELL cells, <= MAXWALL walls.
gcells: ldx     #79             ; far view (5.7a): hs = s + 15 = 15, sides of depth D shift (ghs)
        lda     #15
@hi:    sta     hs,x
        dex
        bpl     @hi
        ldy     #3              ; VW, VH, S, NE into the zero page block (vp, vp+1, mp, mp+1)
        lda     (ZP0),y
        sta     vp
        iny
        lda     (ZP0),y
        sta     vp+1
        ldy     #6
        lda     (ZP0),y
        sta     mp
        iny
        lda     (ZP0),y
        sta     mp+1
        ldy     #18             ; tp = depth table
        clc
        lda     (ZP0),y
        adc     ZP0
        sta     tp
        iny
        lda     (ZP0),y
        adc     ZP0+1
        sta     tp+1
        lda     #0
        sta     gkc
        sta     gwc
        sta     gd
@dep:   ldy     #4              ; first, n
        lda     (tp),y
        sta     gei
        iny
        clc
        adc     (tp),y
        jcs     @bad
        cmp     mp+1            ; first + n <= NE
        beq     @fn
        jcs     @bad
@fn:    ldy     #5
        lda     (tp),y
        sta     gn
        lda     #0
        sta     gpend
        sta     gseen
        sta     gseen+1
        sta     gseen+2
        sta     gseen+3
        sta     gcn
        lda     #$80
        sta     gcs             ; current s: none
        ldx     gd
        lda     gkc
        sta     d_k0,x
        lda     gei             ; op = element table + 16 first
        sta     op
        lda     #0
        asl     op
        rol
        asl     op
        rol
        asl     op
        rol
        asl     op
        rol
        sta     op+1
        ldy     #20
        clc
        lda     (ZP0),y
        adc     op
        sta     op
        iny
        lda     (ZP0),y
        adc     op+1
        adc     ZP0+1
        sta     op+1
        clc
        lda     op
        adc     ZP0
        sta     op
        bcc     @el
        inc     op+1
@el:    lda     gn
        jeq     @dend
        ldy     #0
        lda     (op),y
        cmp     #5
        jcs     @bad
        sta     gart
        ldy     #2              ; |s| <= S
        lda     (op),y
        bpl     @sp
        eor     #$FF
        adc     #1              ; C = 0
@sp:    cmp     mp
        beq     @so
        bcs     @bad
@so:    ldy     #2
        lda     (op),y
        cmp     gcs
        beq     @same
        sta     gcs             ; new cell: s must not have occurred in this depth yet
        clc
        adc     #15
        sta     gsi
        lsr
        lsr
        lsr
        tax
        lda     gsi
        and     #7
        tay
        lda     bittab,y
        and     gseen,x
        bne     @bad
        lda     bittab,y
        ora     gseen,x
        sta     gseen,x
        lda     gkc
        cmp     #MAXCELL
        bcs     @bad
        lda     #0
        sta     gj
        sta     gfl
        sta     gce
        inc     gcn
        inc     gkc
        ldx     gkc
        dex
        lda     gsi
        sta     k_si,x
        lda     op
        sta     k_elo,x
        lda     op+1
        sta     k_ehi,x
        lda     gei
        sta     k_ei,x
        lda     gwc
        sta     k_wo,x
        lda     #0
        sta     k_wn,x
        lda     #$FF
        sta     k_fl,x
        sta     k_ce,x
        sta     k_ob,x
        bne     @chk
@bad:   sec
        rts
@same:  clc
        lda     gj
        adc     #16
        bcs     @bad            ; more than 16 elements in the cell
        sta     gj
@chk:   lda     gart
        cmp     #4
        bne     @nob
        ldx     gkc             ; object slot: first and last in the cell (P6e)
        lda     gj
        sta     k_oe-1,x
        lda     k_ob-1,x
        cmp     #$FF
        jne     @next
        lda     gj
        sta     k_ob-1,x
        jmp     @next
@nob:
        ldy     #4              ; x + w <= VW
        lda     (op),y
        ldy     #6
        clc
        adc     (op),y
        bcs     @bad
        ldy     #3
        cmp     (ZP0),y
        beq     @x1
        bcs     @bad
@x1:    ldy     #5              ; y + h <= VH
        lda     (op),y
        ldy     #7
        clc
        adc     (op),y
        bcs     @bad
        cmp     vp+1
        beq     @y1
        bcs     @bad
@y1:    lda     gart
        cmp     #2
        bcs     @band
        ldy     #13             ; wall: c0 <= c1 <= VW
        lda     (op),y
        cmp     vp
        beq     @c1
        bcs     @bad
@c1:    ldy     #12
        lda     (op),y
        ldy     #13
        cmp     (op),y
        beq     @c2
        bcs     @bad
@c2:    lda     gwc
        cmp     #MAXWALL
        bcs     @bad
        inc     gwc
        ldx     gkc
        inc     k_wn-1,x
        ldx     gwc
        lda     gj
        sta     wl-1,x
        jsr     ghs
@pd:    ldy     #3              ; pending area: bit 0 and (side or without bit 3)
        lda     (op),y
        lsr
        bcc     @next
        ldx     gart
        bne     @pc
        and     #4              ; bit 3 (bit 2 after lsr)
        bne     @next
@pc:    inc     gpend
        lda     gpend
        cmp     #MAXPEND+1
        bcs     @bad2
        bcc     @next
@band:  lsr                     ; kind 2: C = 0 floor, kind 3: C = 1 ceiling
        ldx     gkc
        bcs     @bce
        lda     gfl
        bne     @bad2
        inc     gfl
        lda     gj
        sta     k_fl-1,x
        bcc     @next
@bce:   lda     gce
        bne     @bad2
        inc     gce
        lda     gj
        sta     k_ce-1,x
@next:  clc                     ; next element
        lda     op
        adc     #16
        sta     op
        bcc     @n1
        inc     op+1
@n1:    inc     gei
        dec     gn
        jmp     @el
@bad2:  sec
        rts
@dend:  ldx     gd
        lda     gcn
        sta     d_kn,x
        clc                     ; next depth
        lda     tp
        adc     #8
        sta     tp
        bcc     @d1
        inc     tp+1
@d1:    inc     gd
        ldy     #5
        lda     (ZP0),y
        cmp     gd
        jcs     @dep
        clc
        rts

bittab: .byte   1, 2, 4, 8, 16, 32, 64, 128

; ---------------------------------------------------------------- 13 TEXSET
f_texset:
        lda     argx
        cmp     #3
        jcs     range
        asl
        asl
        asl
        asl
        tax                     ; X = record start
        lda     P0
        ora     P0+1
        bne     @set
        sta     recs,x          ; delete
        jmp     ok
@set:   lda     geom_ok
        jeq     e_state
        jsr     p0_zp0
        stx     t0
        ldx     #mg_dts-eqtab
        jsr     chkeq
        jcs     e_format
        ldy     #3              ; kind = X
        lda     (ZP0),y
        cmp     argx
        jne     e_format
        ldy     #9              ; 1 <= NST <= 32
        lda     (ZP0),y
        jeq     e_format
        cmp     #33
        jcs     e_format
        ldx     #gt_dts-geotab
        jsr     chkgeo
        jcs     e_geom
.ifndef VMS_COPY
        lda     P0+1            ; VCL type 9: lists in Bank 1 only from $4000 (VDC-BASIC P2d, 6a)
        cmp     #$40
        jcc     range
.endif
        ldy     #24             ; U
        jsr     ldacc
        jsr     chk_pool
        jcs     range
        ldx     t0
        ldy     #12             ; slot map, style table, directory
        jsr     fillrec
        ldy     #8              ; NS, NST
        lda     (ZP0),y
        sta     recs+3,x
        iny
        lda     (ZP0),y
        sta     recs+4,x
        sta     t1
        lda     recs+12,x       ; style rows: sty[kind * 32 + st] = style table + st * NS
        sta     acc
        lda     recs+13,x
        sta     acc+1
        lda     recs+3,x
        sta     t2
        txa
        asl
        tay
@st:    lda     acc
        sta     sty_lo,y
        lda     acc+1
        sta     sty_hi,y
        clc
        lda     acc
        adc     t2
        sta     acc
        bcc     @s1
        inc     acc+1
@s1:    iny
        dec     t1
        bne     @st
        jmp     ok

; Far view (5.7a): a side (op) of depth D shifts the cell boundaries in the horizon band (far edge, P_{D+1}):
; s < 0: hs[c] - 1 for c < x + w; s > 0: hs[c] + 1 for c >= x (gcells, only during build)
ghs:    lda     gart
        beq     @r              ; front
        ldy     #5
        lda     (ZP0),y         ; D
        cmp     gd
        bne     @r
        ldy     #4
        lda     (op),y          ; x
        tax
        ldy     #2
        lda     (op),y          ; s
        bpl     @p
        txa
        ldy     #6
        clc
        adc     (op),y          ; x + w (<= VW checked)
        tax
@m:     dex
        bmi     @r
        dec     hs,x
        bpl     @m              ; hs >= 15 - S >= 0
@p:     cpx     vp              ; VW
        bcs     @r
        inc     hs,x
        inx
        bne     @p
@r:     rts

; ---------------------------------------------------------------- 14 BGSET
f_bgset:
        lda     argx
        sta     bgfill
        lda     argy            ; far view (5.7a): Y <> 0 = on, P2 low = fill byte
        sta     ffon
        lda     P2
        sta     ffill
        lda     P0
        ora     P0+1
        bne     @set
        sta     dbg_ok          ; no wallpaper
        jmp     ok
@set:   lda     geom_ok
        jeq     e_state
        jsr     p0_zp0
        ldx     #mg_dbg-eqtab
        jsr     chkeq
        jcs     e_format
        ldy     #7              ; P >= 1
        lda     (ZP0),y
        iny
        ora     (ZP0),y
        jeq     e_format
        ldx     #gt_dbg-geotab
        jsr     chkgeo
        jcs     e_geom
        ldy     #20             ; U
        jsr     ldacc
        jsr     chk_pool
        jcs     range
        ldy     #11             ; P, y0, h, Flags (Bytes 7-11)
        ldx     #4
@c:     lda     (ZP0),y
        sta     dbg_p,x
        dey
        dex
        bpl     @c
        lda     P1
        sta     dbg_vram
        lda     P1+1
        sta     dbg_vram+1
        lda     ZP0
        sta     dbg_base
        lda     ZP0+1
        sta     dbg_base+1
        jsr     bgoffs          ; o_v mod P per direction (view.s)
        lda     #1
        sta     dbg_ok
        jmp     ok

; ---------------------------------------------------------------- 9 SPRITESET
f_spriteset:
        lda     argx
        cmp     #8
        jcs     range
        asl
        asl
        asl
        asl
        adc     #48             ; C = 0 after asl (argx < 8); records 3 ... 10
        tax
        lda     P0
        ora     P0+1
        bne     @set
        sta     recs,x
        jmp     ok
@set:   lda     geom_ok
        jeq     e_state
        jsr     p0_zp0
        stx     t0
        ldx     #mg_s2-eqtab
        jsr     chkeq
        jcs     e_format
        ldy     #7              ; NA 1 ... 4, NP >= 1
        lda     (ZP0),y
        jeq     e_format
        cmp     #5
        jcs     e_format
        iny
        lda     (ZP0),y
        jeq     e_format
        ldy     #4              ; ID: 0 or = DVG-ID
        lda     (ZP0),y
        sta     t1
        iny
        lda     (ZP0),y
        sta     t2
        ora     t1
        beq     @id
        lda     t1
        cmp     dvg_id
        jne     e_geom
        lda     t2
        cmp     dvg_id+1
        jne     e_geom
@id:    ldx     #gt_s2-geotab
        jsr     chkgeo
        jcs     e_geom
.ifndef VMS_COPY
        lda     P0+1            ; VCL type 9: lists in Bank 1 only from $4000 (like TEXSET)
        cmp     #$40
        jcc     range
.endif
        ldy     #30             ; U
        jsr     ldacc
        jsr     chk_pool
        jcs     range
        ldx     t0
        ldy     #16             ; index table, directory, core table
        jsr     fillrec
        ldy     #7              ; NA, NP
        lda     (ZP0),y
        sta     recs+3,x
        iny
        lda     (ZP0),y
        sta     recs+4,x
        lda     t1
        sta     recs+5,x
        lda     t2
        sta     recs+6,x
        lda     #0              ; recs+14 = NA * D (index table: (f * NA + ai) * D + d - 1), recs+15 = 0
        sta     recs+15,x
        ldy     recs+3,x
@nd:    clc
        adc     dvg_d
        dey
        bne     @nd
        sta     recs+14,x
        jmp     ok

; ---------------------------------------------------------------- Tables of the header checks
; eqtab: (header offset, value) up to $FF: magic, version, fixed lengths
eqtab:
mg_dmp: .byte   0,'D', 1,'M', 2,1, $FF
mg_dvg: .byte   0,'D', 1,'V', 2,1, 16,16, 17,8, $FF
mg_dts: .byte   0,'D', 1,'T', 2,1, $FF
mg_dbg: .byte   0,'D', 1,'B', 2,1, $FF
mg_s2:  .byte   0,'S', 1,'2', 2,1, $FF
; geotab: (header offset, index from dvg_vw) up to $FF: the header field must equal the value of the geometry
;   Index 0 VW, 1 VH, 2 D, 3 S, 4 NE, 5/6 stride, 7/8 origin, 9/10 ID
geotab:
gt_dts: .byte   4,9, 5,10, 6,4, 7,2, 28,5, 29,6, $FF           ; ID, NE, D, stride
gt_dbg: .byte   3,0, 4,1, 5,9, 6,10, $FF                        ; VW, VH, ID
gt_s2:  .byte   6,2, 34,5, 35,6, $FF                            ; D, stride (ID getrennt)

.ifdef DBE_TEST
; ---------------------------------------------------------------- 250-253 (test only; TESTLO in front of the lib, $AF00)
        .segment "TESTLO"
t_disp: cmp     #250
        bne     @t1
        jmp     t_probe
@t1:    cmp     #251
        bne     @t2
        jmp     t_wait
@t2:    cmp     #252
        bne     @t3
        jmp     t_hi
@t3:    cmp     #253
        jne     notimpl
        jmp     t_zp
; 250: A = $D506 AND $0F (expects $06), X = $FF00 at the call (expects $7F), Y = byte the lib sees at
;      $1300; writes $A5 to $1301 (BASIC reads it in Bank 0: shared RAM up to $1FFF).
;      $D506 is readable only with I/O: briefly $FF00 = $7E (the lib's only I/O access, test build only)
t_probe:
        lda     #$A5
        sta     $1301
        ldy     $1300
        ldx     MMUCR
        lda     #CR_LIBIO
        sta     MMUCR
        lda     MMU_RCR
        stx     MMUCR
        and     #$0F
        rts
; 251: P0 rounds of about 1300 cycles each (interrupts keep running)
t_wait:
        lda     P0
        sta     ZP0
        lda     P0+1
        sta     ZP0+1
@o:     ldx     #0
@i:     dex
        bne     @i
        lda     ZP0
        bne     :+
        dec     ZP0+1
:       dec     ZP0
        lda     ZP0
        ora     ZP0+1
        bne     @o
        lda     #E_OK
        ldx     #0
        ldy     #0
        rts
; 253: fill zero page block ZPB with a pattern, wait P0 rounds like 251 (interrupts run), check the pattern:
;      A = 0 unchanged, otherwise 1; X = number of changed bytes (test/vice_zp.py)
t_zp:   ldx     #ZPBLEN-1
@f:     txa
        eor     #$A5
        sta     ZPB,x
        dex
        bpl     @f
        jsr     t_wait
        ldy     #0
        ldx     #ZPBLEN-1
@c:     txa
        eor     #$A5
        cmp     ZPB,x
        beq     @n
        iny
@n:     dex
        bpl     @c
        tya
        tax
        beq     @r
        lda     #1
@r:     ldy     #0
        rts
; 252: code in RAM under I/O (lib-test.cfg places TESTHI at $DBF8, the end of the file): A = 0, X = $42,
;      Y = own first byte at $DBF8 (expects $A9: BLOAD loaded up to $DBFF, the lib sees RAM instead of I/O)
        .segment "TESTHI"
t_hi:   lda     #0
        ldx     #$42
        ldy     t_hi
        rts
        .segment LIBSEG
.endif

        .include "view.s"

        .segment LIBSEG
code_end:                       ; end of code (only one segment CODE, no RODATA)

; ---------------------------------------------------------------- Variables (Bank 1 $E000-$E7FF)
        .segment "LIBBSS"
argx:   .res 1
argy:   .res 1
buf_b0: .res 2                  ; buffer (BUFSET): start, end exclusive
buf_b1: .res 2
buf_fix:.res 1                  ; bit 7: fixed list address (BUFSET X bit 0, P6j)
pool_a: .res 2                  ; pool (POOLSET): start, end exclusive (0 = 65536)
pool_b: .res 2
pool_on:.res 1                  ; 0 = no check
;
; P6c
t0:     .res 1                  ; intermediate values
t1:     .res 1
t2:     .res 1
t3:     .res 1
acc:    .res 2
val:    .res 2
; Pointers and record table: ptrs + 0 tile layer, 2 content layer, 4 tile table, 6 events (absolute addresses),
; 8 depth table, 10 element table of the DVG, from 12 recs
ptrs:
map_cells = ptrs
map_cont = ptrs+2
map_tiles = ptrs+4
map_ev = ptrs+6
dvg_depth = ptrs+8
dvg_elem = ptrs+10
        .res 12
; recs: 11 records of 16 bytes: DTS wall, floor, ceiling, then S2 records 0 ... 7.
;   0 valid, 1-2 VRAM base, 3 NS / NA, 4 NST / NP, 5-6 geometry ID (S2), 8-9 content start,
;   10-15 absolute addresses: slot map, style table, directory / index table, directory, core table
recs:   .res 176
; Map (BSS order matters: MAPINIT copies header bytes 6-11 to map_ne)
map_ok: .res 1
map_w:  .res 1
map_h:  .res 1
map_wh: .res 2                  ; order wh, nt, ne: offtab
map_nt: .res 2                  ; 1 ... 256
map_ne: .res 2                  ; number of events
pos:    .res 2                  ; position (cell index)
vdir:   .res 1                  ; viewing direction 0 ... 3
map_out:.res 1                  ; outer tile
map_auto:.res 1                 ; automap bit (P6f)
px:     .res 1
py:     .res 1
; DVG (order = header bytes 3-15)
geom_ok:.res 1
dvg_vw: .res 1
dvg_vh: .res 1
dvg_d:  .res 1
dvg_s:  .res 1
dvg_ne: .res 1
dvg_stride: .res 2
dvg_origin: .res 2
dvg_id: .res 2
dvg_y0: .res 1                  ; horizon
dvg_y1: .res 1
rows:   .res 200                ; row[y] = origin + y * stride
; DBG (order = header bytes 7-11)
dbg_ok: .res 1
dbg_vram: .res 2
dbg_base: .res 2
dbg_p:  .res 2
dbg_y0: .res 1
dbg_h:  .res 1
dbg_flags: .res 1
bgfill: .res 1
bgomt:  .res 8                  ; o_v mod P per direction (BGSET)
ffon:   .res 1                  ; far view fill on (BGSET Y <> 0, P6 5.7a)
ffill:  .res 1                  ; far view fill byte (BGSET P2 low)
hs:     .res 80                 ; far view: s + 15 of the cell of depth D per horizon column (GEOMSET, gcells)
itemtab:.res 64                 ; item -> record + 1
itemn:  .res 1                  ; entries <> 0 in itemtab
sty_lo: .res 96                 ; TEXSET: address of the style row [kind * 32 + st]
sty_hi: .res 96
tpl:    .res 256                ; tile tables (MAPINIT, mtiles)
tph:    .res 256
bss_end:
; ---------------------------------------------------------------- Tables (Bank 1 $DC00-$DFFF, INIT does not clear them)
        .segment "LIBTAB"
; Cell table (GEOMSET, gcells): per cell k (depths in sequence, cells in DVG order)
k_si:   .res MAXCELL            ; s + 15
k_elo:  .res MAXCELL            ; address of the first element
k_ehi:  .res MAXCELL
k_ei:   .res MAXCELL            ; index of the first element (slot)
k_wo:   .res MAXCELL            ; first wall in wl
k_wn:   .res MAXCELL            ; number of walls (kind 0/1)
k_fl:   .res MAXCELL            ; floor/ceiling element: 16 * slot in the cell, $FF none
k_ce:   .res MAXCELL
k_ob:   .res MAXCELL            ; object slots: 16 * slot of the first and the last, k_ob = $FF none
k_oe:   .res MAXCELL
d_k0:   .res 8                  ; per depth: first cell, number of cells
d_kn:   .res 8
wl:     .res MAXWALL            ; walls: 16 * slot in the cell (DVG order)
tsm:    .res 256                ; tile summary (MAPINIT, mtiles)
gkc:    .res 1
gwc:    .res 1
gd:     .res 1
gpend:  .res 1
gseen:  .res 4
gcn:    .res 1
gfl:    .res 1
gce:    .res 1
        .segment "LIBBSS"
