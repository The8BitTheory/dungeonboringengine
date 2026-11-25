; dungeonboringengine 0.2 – Lib in Bank 1 ($B000)
;
; Aufruf nur über den Stub (SYS 3331,F,X,Y). Läuft mit $FF00 = $7E (Bank 1, RAM, I/O)
; und gemeinsamem RAM unten 8 KB ($0000-$1FFF); Parameterblock P0..P3 bei $0C00 (Bank 0).
; Speicherkarte, Funktionen und Fehlercodes: docs/specs/P6-engine.md (2, 3).
;
; Stand P6a (Gerüst): Dispatcher mit der Funktionstabelle aus 3, davon umgesetzt
;   0 INIT      Zustand gelöscht (BSS, OBJN = 0, Puffer = Standard, Pool aus); X = DBE_VERSION;
;               P0 = Codeende, P1 = BSS-Ende
;  11 POOLSET   P0 = Poolanfang, P1 = Poolende (exklusiv, 0 = 65536); beide 0 = keine Prüfung
;  15 BUFSET    P0 = Pufferanfang, P1 = Pufferende (exklusiv); A = 6 bei Anfang < $0200,
;               Ende > $1C00 oder Länge < 64 (alter Puffer bleibt)
; Stand P6c (Karte und Assets): MAPINIT, SETPOS, CELL, SETCELL, SETITEM, GEOMSET, TEXSET, BGSET,
; SPRITESET, ITEMSET (Prüfungen 3.2; Fehlerreihenfolge: E_STATE, E_RANGE (Nummer), E_FORMAT, E_GEOM, E_RANGE (Pool)).
; Festlegungen zu P6c: siehe docs/specs/P6-engine.md "Ergebnis P6c".
; Alle anderen Funktionen (und F >= 17): A = E_NOTIMPL, bis ihr Teilschritt (P6d-P6f) sie umsetzt.
; Stand P6d: VIEW ohne Objekte (engine/view.s, docs/specs/P6-engine.md "Ergebnis P6d").
;
; Übersetzen mit -DDBE_TEST (nur Tests, nie im Spiel): Funktionen 250 (MMU-/Common-RAM-Probe)
; und 251 (Warteschleife von P0 x etwa 1300 Zyklen) für den VICE-Rauchtest.
; Übersetzen mit -DSIM: ohne LOADADDR (sim65-Harness, test/sim).

        .include "dbe.inc"
        .macpack longbranch

.ifndef SIM
        .segment "LOADADDR"
        .word   LIB
.endif

        .export dbe_entry := entry
        .export bss_start, bss_end, code_end            ; für Tests (Labeldatei)
        .export argx, buf_b0, buf_b1, pool_a, pool_b, pool_on
        .export t0, val, ptrs, recs, rows, itemtab, geom_ok, map_ok, map_w, map_h, map_wh, map_nt, map_ne, map_auto
        .export pos, vdir, px, py, map_out, dvg_vw, dvg_origin, dvg_id, dbg_ok, dbg_vram, dbg_base, dbg_p, bgfill

        .segment "LIBBSS"
bss_start:                      ; erster Teil von LIBBSS (view.s legt weitere Variablen an)
        .segment "CODE"
entry:  jmp     dispatch
        .byte   "DBE", DBE_VERSION

dispatch:
        stx     argx
        sty     argy
.ifdef DBE_TEST
        cmp     #250
        bcc     @norm
        bne     @t1
        jmp     t_probe
@t1:    cmp     #251
        bne     @norm
        jmp     t_wait
@norm:
.endif
        cmp     #NFUNC
        bcs     notimpl
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

; Tabelle aus 3: F = 0 ... 16; nicht umgesetzte Einträge = notimpl
functab:
        .word   f_init-1,     f_mapinit-1,  f_setpos-1,   notimpl-1     ; 0 INIT, 1 MAPINIT, 2 SETPOS, 3 MOVE
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
        ldx     #9              ; ITEMPH ... OBJVIS ($0C08-$0C11) löschen
@parm:  sta     PARM+$08,x
        dex
        bpl     @parm
        sta     OBJN
        lda     #<BUF_B0        ; Standardpuffer
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
        sta     pool_on         ; beide 0: keine Prüfung
        jmp     ok
@on:    lda     P1
        ora     P1+1
        beq     @set            ; Ende 0 = 65536: immer größer als der Anfang
        lda     P0              ; Anfang >= Ende (leerer oder negativer Pool): E_RANGE
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
        lda     P0+1
        cmp     #>BUF_MIN0
        bcc     range           ; Anfang < $0200
        lda     #<BUF_B1
        cmp     P1
        lda     #>BUF_B1
        sbc     P1+1
        bcc     range           ; Ende > $1C00
        sec
        lda     P1
        sbc     P0
        tax
        lda     P1+1
        sbc     P0+1
        bcc     range           ; Ende < Anfang
        bne     @len
        cpx     #BUF_MINLEN
        bcc     range           ; Länge < 64
@len:   lda     P0
        sta     buf_b0
        lda     P0+1
        sta     buf_b0+1
        lda     P1
        sta     buf_b1
        lda     P1+1
        sta     buf_b1+1
        jmp     ok

; ================================================================ P6c: Karte und Assets
; ---------------------------------------------------------------- Hilfen
p0_zp0: lda     P0              ; ZP0 = P0
        sta     ZP0
        lda     P0+1
        sta     ZP0+1
        rts

; X = Index in eqtab; (ZP0) = Daten. C = 1: ein Byte weicht ab (Magic, Version, feste Längen)
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

; X = Index in geotab; (ZP0) = Daten. C = 1: ein Kopffeld weicht von der Geometrie (dvg_vw + Index) ab
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

; Y = Kopf-Offset: acc = Wort im Kopf
ldacc:  lda     (ZP0),y
        sta     acc
        iny
        lda     (ZP0),y
        sta     acc+1
        rts

; Y = Kopf-Offset: C = 1, wenn das Wort im Kopf <> acc
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

; Adressen: ptrs+X ... (A) = Inhaltsanfang (ZP0) + Wörter aus dem Kopf ab Y; Ende bei ptrs+A
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

; Pool (3.2): U = acc, Basis = P1. C = 1: Verstoß
chk_pool:
        lda     pool_on
        beq     @ok
        lda     P1
        cmp     pool_a
        lda     P1+1
        sbc     pool_a+1
        bcc     @bad            ; Basis < Poolanfang
        clc
        lda     P1
        adc     acc
        sta     acc
        lda     P1+1
        adc     acc+1
        sta     acc+1
        bcs     @ovf            ; Basis + U >= 65536
        lda     pool_b
        ora     pool_b+1
        beq     @ok             ; Ende 65536
        lda     pool_b
        cmp     acc
        lda     pool_b+1
        sbc     acc+1
        bcc     @bad            ; Basis + U > Poolende
@ok:    clc
        rts
@ovf:   lda     acc             ; genau 65536 nur bei Poolende 65536
        ora     acc+1
        ora     pool_b
        ora     pool_b+1
        bne     @bad
        clc
        rts
@bad:   sec
        rts

; Satzanfang X (recs): gültig, VRAM-Basis (P1), Inhaltsanfang (ZP0), drei Tabellenadressen aus dem Kopf ab Y; X bleibt
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

; ZP0 = Ebene Y (0 Kachel-, 2 Inhaltsebene) + Zelle P0
getcell:
        clc
        lda     map_cells,y
        adc     P0
        sta     ZP0
        lda     map_cells+1,y
        adc     P0+1
        sta     ZP0+1
        rts

; A = Kachelindex -> A = Flags der Kachel
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

; px, py aus pos (fortgesetzte Subtraktion)
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
        ldy     #11             ; NE, Start, Richtung, Außenkachel (Bytes 6-11)
        ldx     #5
@h:     lda     (ZP0),y
        sta     map_ne,x
        dey
        dex
        bpl     @h
        lda     pos             ; Start < W*H
        cmp     map_wh
        lda     pos+1
        sbc     map_wh+1
        jcs     e_format
        lda     vdir
        cmp     #4
        jcs     e_format
        lda     map_nt+1        ; Außenkachel < NT
        bne     @o
        lda     map_out
        cmp     map_nt
        jcs     e_format
@o:     lda     #24             ; Offsets lückenlos: 24, +WH, +WH, +8 NT, +4 NE = Länge
        sta     acc
        lda     #0
        sta     acc+1
        ldy     #12
        jsr     chkw
        jcs     e_format
        ldx     #0
@s:     ldy     offtab,x        ; Summand (Index ab map_wh), Linksschub, Kopf-Offset
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
        bcs     @fmt            ; Länge >= 65536
        ldy     offtab+2,x
        jsr     chkw
@fmt:   jcs     e_format
        inx
        inx
        inx
        cpx     #12
        bne     @s
        ldx     #0              ; Adressen: Kachelebene, Inhaltsebene, Kacheltabelle, Ereignisse
        ldy     #12
        lda     #8
        jsr     addtab
        lda     P1
        ora     P1+1
        jeq     @nocopy
        lda     map_wh          ; Arbeitskopie: 2 * W * H Byte
        asl
        sta     acc
        lda     map_wh+1
        rol
        sta     acc+1
        lda     P1+1            ; Ziel >= $2000 (darunter gemeinsames RAM) ...
        cmp     #$20
        jcc     range
        clc                     ; ... und Ziel + 2 W H <= LIB (Lib, BSS, DVG, I/O, MMU unberührt)
        lda     P1
        adc     acc
        tax
        lda     P1+1
        adc     acc+1
        jcs     range
        cpx     #<(LIB+1)
        sbc     #>(LIB+1)
        jcs     range
        lda     map_cells       ; ZP0 = Quelle, ZP1 = Ziel
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
        lda     argx
        and     #1
        sta     map_auto
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

; Tabelle der Offsetprüfung: Summand (Byte-Index ab map_wh), Linksschub, Kopf-Offset der Summe
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
        sta     itemtab,x
        jmp     ok

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
        iny                     ; S <= 15 (VIEW: höchstens 31 Zellen je Tiefe)
        lda     (ZP0),y
        cmp     #16
        jcs     e_format
        iny                     ; NE >= 1
        lda     (ZP0),y
        jeq     e_format
        ldx     #0              ; t0 = 1: andere ID als bisher
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
        ldy     #15             ; VW, VH, D, S, NE, stride, origin, ID, y0, y1 (Bytes 3-15)
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
@nor:   ldx     #dvg_depth-ptrs ; Tiefentabelle, Elementtabelle
        ldy     #18
        lda     #dvg_depth-ptrs+4
        jsr     addtab
        lda     #0
        sta     t1              ; gelöschte S2-Sätze
        sta     t2              ; gelöschte DTS (Bit 0-2), DBG (Bit 3)
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
        lda     recs+5,x        ; ID <> 0 und andere Geometrie: löschen
        ora     recs+6,x
        bne     @kill
        lda     recs+8,x        ; ID 0: nur bei anderem D oder Stride löschen
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
@rows:  lda     dvg_origin      ; row[y] = origin + y * stride
        sta     acc
        lda     dvg_origin+1
        sta     acc+1
        lda     dvg_vh
        asl
        sta     t3
        ldx     #0
@r:     lda     acc
        sta     rows,x
        lda     acc+1
        sta     rows+1,x
        clc
        lda     acc
        adc     dvg_stride
        sta     acc
        lda     acc+1
        adc     dvg_stride+1
        sta     acc+1
        inx
        inx
        cpx     t3
        bne     @r
        lda     #1
        sta     geom_ok
        ldx     t1
        ldy     t2
        lda     #E_OK
        rts

; ---------------------------------------------------------------- 13 TEXSET
f_texset:
        lda     argx
        cmp     #3
        jcs     range
        asl
        asl
        asl
        asl
        tax                     ; X = Satzanfang
        lda     P0
        ora     P0+1
        bne     @set
        sta     recs,x          ; löschen
        jmp     ok
@set:   lda     geom_ok
        jeq     e_state
        jsr     p0_zp0
        stx     t0
        ldx     #mg_dts-eqtab
        jsr     chkeq
        jcs     e_format
        ldy     #3              ; Art = X
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
        ldy     #24             ; U
        jsr     ldacc
        jsr     chk_pool
        jcs     range
        ldx     t0
        ldy     #12             ; Slotkarte, Stiltabelle, Verzeichnis
        jsr     fillrec
        ldy     #8              ; NS, NST
        lda     (ZP0),y
        sta     recs+3,x
        iny
        lda     (ZP0),y
        sta     recs+4,x
        sta     t1
        lda     recs+12,x       ; Stilzeilen: sty[Art * 32 + st] = Stiltabelle + st * NS
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

; ---------------------------------------------------------------- 14 BGSET
f_bgset:
        lda     argx
        sta     bgfill
        lda     P0
        ora     P0+1
        bne     @set
        sta     dbg_ok          ; keine Tapete
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
        adc     #48             ; C = 0 nach asl (argx < 8); Sätze 3 ... 10
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
        ldy     #4              ; ID: 0 oder = DVG-ID
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
        ldy     #30             ; U
        jsr     ldacc
        jsr     chk_pool
        jcs     range
        ldx     t0
        ldy     #16             ; Indextabelle, Verzeichnis, Kerntabelle
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
        lda     #0              ; recs+14 = NA * D (Indextabelle: (f * NA + ai) * D + d - 1), recs+15 = 0
        sta     recs+15,x
        ldy     recs+3,x
@nd:    clc
        adc     dvg_d
        dey
        bne     @nd
        sta     recs+14,x
        jmp     ok

; ---------------------------------------------------------------- Tabellen der Kopfprüfungen
; eqtab: (Kopf-Offset, Wert) bis $FF: Magic, Version, feste Längen
eqtab:
mg_dmp: .byte   0,'D', 1,'M', 2,1, $FF
mg_dvg: .byte   0,'D', 1,'V', 2,1, 16,16, 17,8, $FF
mg_dts: .byte   0,'D', 1,'T', 2,1, $FF
mg_dbg: .byte   0,'D', 1,'B', 2,1, $FF
mg_s2:  .byte   0,'S', 1,'2', 2,1, $FF
; geotab: (Kopf-Offset, Index ab dvg_vw) bis $FF: das Kopffeld muss dem Wert der Geometrie gleichen
;   Index 0 VW, 1 VH, 2 D, 3 S, 4 NE, 5/6 stride, 7/8 origin, 9/10 ID
geotab:
gt_dts: .byte   4,9, 5,10, 6,4, 7,2, 28,5, 29,6, $FF           ; ID, NE, D, stride
gt_dbg: .byte   3,0, 4,1, 5,9, 6,10, $FF                        ; VW, VH, ID
gt_s2:  .byte   6,2, 34,5, 35,6, $FF                            ; D, stride (ID getrennt)

.ifdef DBE_TEST
; ---------------------------------------------------------------- 250 / 251 (nur Test)
; 250: A = $D506 AND $0F (erwartet $06), X = $FF00 (erwartet $7E), Y = Byte, das die Lib bei
;      $1300 sieht; schreibt $A5 nach $1301 (BASIC liest es in Bank 0: gemeinsames RAM bis $1FFF)
t_probe:
        lda     #$A5
        sta     $1301
        ldy     $1300
        ldx     MMUCR
        lda     MMU_RCR
        and     #$0F
        rts
; 251: P0 Runden zu je etwa 1300 Zyklen (Interrupts laufen weiter)
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
.endif

        .include "view.s"

        .segment "CODE"
code_end:                       ; Codeende (nur ein Segment CODE, kein RODATA)

; ---------------------------------------------------------------- Variablen (Bank 1 $E000-$E7FF)
        .segment "LIBBSS"
argx:   .res 1
argy:   .res 1
buf_b0: .res 2                  ; Puffer (BUFSET): Anfang, Ende exklusiv
buf_b1: .res 2
pool_a: .res 2                  ; Pool (POOLSET): Anfang, Ende exklusiv (0 = 65536)
pool_b: .res 2
pool_on:.res 1                  ; 0 = keine Prüfung
;
; P6c
t0:     .res 1                  ; Zwischenwerte
t1:     .res 1
t2:     .res 1
t3:     .res 1
acc:    .res 2
val:    .res 2
; Zeiger und Satztabelle: ptrs + 0 Kachelebene, 2 Inhaltsebene, 4 Kacheltabelle, 6 Ereignisse (absolute Adressen),
; 8 Tiefentabelle, 10 Elementtabelle der DVG, ab 12 recs
ptrs:
map_cells = ptrs
map_cont = ptrs+2
map_tiles = ptrs+4
map_ev = ptrs+6
dvg_depth = ptrs+8
dvg_elem = ptrs+10
        .res 12
; recs: 11 Sätze zu 16 Byte: DTS Wand, Boden, Decke, dann S2-Sätze 0 ... 7.
;   0 gültig, 1-2 VRAM-Basis, 3 NS / NA, 4 NST / NP, 5-6 Geometrie-ID (S2), 8-9 Inhaltsanfang,
;   10-15 absolute Adressen: Slotkarte, Stiltabelle, Verzeichnis / Indextabelle, Verzeichnis, Kerntabelle
recs:   .res 176
; Karte (BSS-Reihenfolge wichtig: MAPINIT kopiert Kopfbytes 6-11 nach map_ne)
map_ok: .res 1
map_w:  .res 1
map_h:  .res 1
map_wh: .res 2                  ; Reihenfolge wh, nt, ne: offtab
map_nt: .res 2                  ; 1 ... 256
map_ne: .res 2                  ; Anzahl Ereignisse
pos:    .res 2                  ; Position (Zellindex)
vdir:   .res 1                  ; Blickrichtung 0 ... 3
map_out:.res 1                  ; Außenkachel
map_auto:.res 1                 ; Automap-Bit (P6f)
px:     .res 1
py:     .res 1
; DVG (Reihenfolge = Kopfbytes 3-15)
geom_ok:.res 1
dvg_vw: .res 1
dvg_vh: .res 1
dvg_d:  .res 1
dvg_s:  .res 1
dvg_ne: .res 1
dvg_stride: .res 2
dvg_origin: .res 2
dvg_id: .res 2
dvg_y0: .res 1                  ; Horizont
dvg_y1: .res 1
rows:   .res 200                ; row[y] = origin + y * stride
; DBG (Reihenfolge = Kopfbytes 7-11)
dbg_ok: .res 1
dbg_vram: .res 2
dbg_base: .res 2
dbg_p:  .res 2
dbg_y0: .res 1
dbg_h:  .res 1
dbg_flags: .res 1
bgfill: .res 1
itemtab:.res 64                 ; Gegenstand -> Satz + 1
sty_lo: .res 96                 ; TEXSET: Adresse der Stilzeile [Art * 32 + st]
sty_hi: .res 96
bss_end:
