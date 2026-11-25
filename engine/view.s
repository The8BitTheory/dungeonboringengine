; dungeonboringengine 0.2 – VIEW (P6d: ohne Objekte), eingebunden von lib.s
;
; docs/specs/P6-engine.md Abschnitt 5 (5.1-5.7, 5.9 Bänder mit Rand, 5.10, 5.11); die Liste ist bytegleich mit
; tools/dbeview.py view(). Ablauf:
;   Sichtdurchlauf vorne -> hinten (vdepth je Tiefe: Zellen, Boden, Decke, Tapete, Wartebereich), jeder
;   angenommene Eintrag kommt mit seinen Parametern in die Sichtliste (it_*); seine Größe (VCL-Bytes iv,
;   VMS-Bytes im) liefert derselbe Erzeuger (gen) im Zählmodus (wmode = 0).
;   Ausgabe hinten -> vorne (vout): gen im Schreibmodus (wmode = $80) für alle Einträge rückwärts.
; Zeropage: ZP0 = Elementzeiger im Sichtdurchlauf bzw. VCL-Schreibzeiger in der Ausgabe; ZP1 frei für Hilfen.
; Selbstmodifizierender Code nur in vcopy (Blockkopie der VMS-Listen).

MAXITEM  = 96           ; Sichtliste (7)
MAXPEND  = 16           ; Wartebereich je Tiefe (deckende Seiten bzw. Fronten ohne DVG-Bit 3)
MAXGRP   = 32           ; Zellen je Tiefe (S <= 15, GEOMSET prüft)
WM_W     = $80          ; wmode: schreiben
IT_STRIP = $80          ; Eintragstyp Bit 7: Rand weggelassen (5.10)
IT_WALL  = 0            ; Wand- oder Kachelbild: g_kind, g_a = Element, g_p = Verzeichniseintrag
IT_BAND  = 1            ; Bandbild: g_kind, g_p, g_a = y0, g_b = Zeilen, g_c0/g_c1 = Spalten
IT_BG    = 2            ; Tapete: g_a = r0, g_b = r1, g_c0/g_c1
TF_DECK  = $04          ; Kachel-Flags (DMP)
TF_INH   = $20
EF_DECK  = $01          ; Bild-Flags (DTS)
EF_ZEIL  = $04
EF_RAND  = $08

; ---------------------------------------------------------------- 4 VIEW
f_view:
        lda     geom_ok
        and     map_ok
        bne     @go
        jmp     e_state
@go:    tsx
        stx     savesp
        lda     P0
        sta     ap
        lda     P0+1
        sta     ap+1
        lda     #0
        ldx     dvg_vw
@clr:   sta     cover,x         ; einschließlich Platz VW (Sentinel von allcov)
        sta     bcov,x
        dex
        bpl     @clr
        ldx     #vz_end-vz_start-1
@z:     sta     vz_start,x
        dex
        bpl     @z
        lda     #1
        sta     nv
        sec                     ; BL = B1 - B0
        lda     buf_b1
        sbc     buf_b0
        sta     bl
        lda     buf_b1+1
        sbc     buf_b0+1
        sta     bl+1
        lda     #$FF
        sta     sp_n            ; Spannen ungültig
        ; Blickrichtung: Flächen, Achsen, Schritte
        lda     vdir
        tax
        clc
        adc     #2
        and     #3
        sta     facef
        txa
        adc     #1              ; C = 0
        and     #3
        sta     facel
        txa
        adc     #3
        and     #3
        sta     facer
        lda     fnegtab,x
        sta     fneg
        lda     anegtab,x
        sta     aneg
        lda     #0
        sta     fc+1
        txa
        lsr
        bcs     @odd
        lda     py              ; N/S: feste Achse y, Seitenachse x
        sta     fc
        lda     map_h
        sta     flim
        lda     px
        sta     a0
        lda     map_w
        sta     alim
        lda     map_w           ; F = -+W
        sta     fstep
        lda     #0
        sta     fstep+1
        sta     rmw
        beq     @neg
@odd:   lda     px              ; O/W: feste Achse x, Seitenachse y
        sta     fc
        lda     map_w
        sta     flim
        lda     py
        sta     a0
        lda     map_h
        sta     alim
        lda     #1              ; F = +-1, R = +-W
        sta     fstep
        sta     rmw
        lda     #0
        sta     fstep+1
@neg:   lda     fneg
        beq     @fs
        sec
        lda     #0
        sbc     fstep
        sta     fstep
        lda     #0
        sbc     fstep+1
        sta     fstep+1
@fs:    lda     pos
        sta     idxd
        lda     pos+1
        sta     idxd+1
        lda     dbg_ok          ; Tapete: o_v mod P
        beq     @nobg
        jsr     bgoffs
@nobg:
; ---- Tiefen 0 ... D
@dl:    jsr     vdepth
        lda     ncov
        cmp     dvg_vw
        beq     vout
        lda     cd
        cmp     dvg_d
        bcs     vout
        inc     cd
        lda     fneg            ; fc += fsign (16 Bit)
        beq     @fp
        lda     fc
        bne     @fd
        dec     fc+1
@fd:    dec     fc
        jmp     @fi
@fp:    inc     fc
        bne     @fi
        inc     fc+1
@fi:    clc                     ; idxd += F
        lda     idxd
        adc     fstep
        sta     idxd
        lda     idxd+1
        adc     fstep+1
        sta     idxd+1
        jmp     @dl

; STOP (5.10): Sichtliste voll oder Puffer überschritten -> Ausgabe des Bisherigen
vstop:  ldx     savesp
        txs
; ---------------------------------------------------------------- Ausgabe (5.11)
vout:   lda     buf_b0
        sta     ZP0
        clc
        adc     nv
        sta     vmsp
        lda     buf_b0+1
        sta     ZP0+1
        adc     nv+1
        sta     vmsp+1
        lda     #WM_W
        sta     wmode
        ldx     nitems
@l:     dex
        cpx     #$FF
        beq     @end
        stx     oi
        lda     it_t,x          ; Bit 7 Rand weggelassen, Bits 4-5 Art, Bits 0-3 Typ
        sta     g_type
        lsr
        lsr
        lsr
        lsr
        and     #3
        sta     g_kind
        lda     it_pl,x
        sta     g_p
        lda     it_ph,x
        sta     g_p+1
        lda     it_a,x
        sta     g_a
        lda     it_b,x
        sta     g_b
        lda     it_c0,x
        sta     g_c0
        lda     it_c1,x
        sta     g_c1
        jsr     gen
        ldx     oi
        jmp     @l
@end:   ldy     #0              ; Ende-Byte
        tya
        sta     (ZP0),y
        sta     OBJVIS
        sta     OBJVIS+1
        lda     buf_b0
        sta     VCLADR
        sta     P0
        lda     buf_b0+1
        sta     VCLADR+1
        sta     P0+1
        lda     nv
        sta     VCLLEN
        lda     nv+1
        sta     VCLLEN+1
        lda     nm
        sta     VMSLEN
        lda     nm+1
        sta     VMSLEN+1
        ldx     nent
        lda     verr            ; A = 2 vor 3
        bne     @a
        lda     vpart
        beq     @a
        lda     #E_PARTIAL
@a:     rts                     ; Y = 0

fnegtab: .byte  1, 0, 0, 1      ; F zeigt nach -y (N) bzw. -x (W)
anegtab: .byte  0, 0, 1, 1      ; R zeigt nach -x (S) bzw. -y (W)

; o_v mod P (16 Bit, Rest der Division); BGSET garantiert P >= 1
bgoffs: lda     vdir
        asl
        clc
        adc     #12
        tay
        lda     dbg_base
        sta     ZP1
        lda     dbg_base+1
        sta     ZP1+1
        lda     (ZP1),y
        sta     mw
        iny
        lda     (ZP1),y
        sta     mw+1
        lda     #0
        sta     bgom
        sta     bgom+1
        ldx     #16
@d:     asl     mw
        rol     mw+1
        rol     bgom
        rol     bgom+1
        lda     bgom
        cmp     dbg_p
        lda     bgom+1
        sbc     dbg_p+1
        bcc     @n
        sta     bgom+1
        lda     bgom
        sbc     dbg_p
        sta     bgom
@n:     dex
        bne     @d
        rts

; ---------------------------------------------------------------- eine Tiefe (5.2)
vdepth: lda     cd
        asl
        asl
        asl
        clc
        adc     dvg_depth
        sta     ZP1
        lda     dvg_depth+1
        adc     #0
        sta     ZP1+1
        ldy     #5
@r:     lda     (ZP1),y         ; cy0, cy1, fy0, fy1, first, n
        sta     dcy0,y
        dey
        bpl     @r
        lda     #0
        sta     lue+1
        sta     lue+2
        sta     npend
        sta     bmulti
        ldx     #1              ; dout: feste Koordinate außerhalb der Karte
        lda     fc+1
        bne     @o
        lda     fc
        cmp     flim
        bcs     @o
        dex
@o:     stx     dout
        jsr     vcells
        lda     #1
        jsr     vband           ; Boden
        lda     #2
        jsr     vband           ; Decke
        jsr     vtap
        ldx     #0              ; Wartebereich eintragen
@p:     cpx     npend
        bcs     @pe
        stx     pi
        lda     pd_c1,x
        pha
        lda     pd_c0,x
        tax
        pla
        jsr     mark_b
        ldx     pi
        lda     pd_both,x
        beq     @pn
        lda     pd_c1,x
        pha
        lda     pd_c0,x
        tax
        pla
        jsr     mark_c
        ldx     pi
@pn:    inx
        bne     @p
@pe:    rts

; ---------------------------------------------------------------- Zellen einer Tiefe
vcells: lda     dfirst          ; ZP0 = Elementtabelle + 16 * first
        sta     ecur
        jsr     elp
        lda     ZP1
        sta     ZP0
        lda     ZP1+1
        sta     ZP0+1
        lda     dn
        sta     erem
        lda     #0
        sta     ngrp
@g:     lda     erem
        bne     @g1
        rts
@g1:    ldy     #2              ; Gruppe gleicher s: Länge gcnt
        lda     (ZP0),y
        sta     gs
        lda     ZP0
        sta     gp
        sta     ZP1
        lda     ZP0+1
        sta     gp+1
        sta     ZP1+1
        lda     ecur
        sta     gi
        ldx     ngrp            ; Boden-/Deckenelement der Zelle merken (vband)
        cpx     #MAXGRP
        bcc     @gm
        inc     bmulti          ; zu viele Zellen: vband durchsucht alle Elemente
        bcs     @g0
@gm:    lda     #$FF
        sta     gr_fe,x
        sta     gr_cee,x
@g0:    ldx     #0
@sc:    ldy     #0
        lda     (ZP1),y
        cmp     #2
        bcc     @sn
        cmp     #4
        bcs     @sn
        sta     tmp2            ; Art 2 Boden, 3 Decke
        ldy     ngrp
        cpy     #MAXGRP
        bcs     @sn
        txa
        clc
        adc     ecur
        sta     tmp3            ; Elementindex
        lda     tmp2
        lsr
        bcs     @sce
        lda     gr_fe,y
        cmp     #$FF
        bne     @mul
        lda     tmp3
        sta     gr_fe,y
        bcs     @sn             ; C = 1 nach cmp #$FF
@sce:   lda     gr_cee,y
        cmp     #$FF
        bne     @mul
        lda     tmp3
        sta     gr_cee,y
        bcs     @sn
@mul:   lda     #1              ; zwei Elemente derselben Art in einer Zelle
        sta     bmulti
@sn:    inx
        cpx     erem
        bcs     @sd
        clc
        lda     ZP1
        adc     #16
        sta     ZP1
        bcc     @sc1
        inc     ZP1+1
@sc1:   ldy     #2
        lda     (ZP1),y
        cmp     gs
        beq     @sc
@sd:    stx     gcnt
        jsr     vcell
        ldx     #0              ; Durchläufe: 0 = alle; INHALT mit Flächen: 1 Fronten, 2 Objektplatz, 3 Seiten
        lda     gfaces
        beq     @ps
        lda     tflags
        and     #TF_INH
        beq     @ps
        inx
@ps:    stx     pass
@pl:    lda     gp
        sta     ZP0
        lda     gp+1
        sta     ZP0+1
        lda     gi
        sta     ecur
        lda     gcnt
        sta     ecnt
@el:    ldx     pass
        beq     @do
        ldy     #0
        lda     (ZP0),y
        cmp     passart-1,x
        bne     @nx
@do:    jsr     velem
@nx:    clc
        lda     ZP0
        adc     #16
        sta     ZP0
        bcc     @nx1
        inc     ZP0+1
@nx1:   inc     ecur
        dec     ecnt
        bne     @el
        ldx     pass
        beq     @gd
        inx
        stx     pass
        cpx     #4
        bcc     @pl
@gd:    sec
        lda     erem
        sbc     gcnt
        sta     erem
        inc     ngrp
        jmp     @g

passart: .byte  0, 4, 1         ; Durchlauf 1 Fronten, 2 Objektplatz, 3 Seiten (5.2a)

; Zelle der Gruppe (cd, gs): Kachel nach tw/tflags, gfaces; Gruppentabelle gr_* [ngrp]; cidx, cout (für P6e)
vcell:  lda     dout
        jne     @out
        lda     gs              ; as = Seitenschritt in Richtung der Seitenachse
        ldx     aneg
        beq     @p
        eor     #$FF
        clc
        adc     #1
@p:     sta     as
        clc
        adc     a0
        tax
        lda     as
        bmi     @m
        jcs     @out            ; >= 256
        bcc     @c
@m:     bcc     @out            ; < 0
@c:     cpx     alim
        bcs     @out
        lda     rmw
        bne     @w
        ldx     #0              ; Zelle = idxd + as (R = +-1)
        lda     as
        bpl     @w1
        dex
@w1:    clc
        adc     idxd
        sta     cidx
        txa
        adc     idxd+1
        sta     cidx+1
        jmp     @in
@w:     lda     idxd            ; Zelle = idxd + as * W (R = +-W)
        sta     cidx
        lda     idxd+1
        sta     cidx+1
        lda     as
        beq     @in
        bmi     @wn
        tax
@wp:    clc
        lda     cidx
        adc     map_w
        sta     cidx
        bcc     @wp1
        inc     cidx+1
@wp1:   dex
        bne     @wp
        beq     @in
@wn:    eor     #$FF
        tax
        inx
@wm:    sec
        lda     cidx
        sbc     map_w
        sta     cidx
        bcs     @wm1
        dec     cidx+1
@wm1:   dex
        bne     @wm
@in:    clc
        lda     map_cells
        adc     cidx
        sta     ZP1
        lda     map_cells+1
        adc     cidx+1
        sta     ZP1+1
        ldy     #0
        sty     cout
        lda     (ZP1),y
        jmp     @t
@out:   lda     #1
        sta     cout
        lda     map_out
@t:     ldx     #0              ; ZP1 = Kacheltabelle + 8 * t
        stx     ZP1+1
        asl
        rol     ZP1+1
        asl
        rol     ZP1+1
        asl
        rol     ZP1+1
        adc     map_tiles       ; C = 0
        sta     ZP1
        lda     ZP1+1
        adc     map_tiles+1
        sta     ZP1+1
        ldy     #6
@cp:    lda     (ZP1),y         ; walls[4], floor, ceil, flags
        sta     tw,y
        dey
        bpl     @cp
        ldx     ngrp
        cpx     #MAXGRP
        bcs     @nog
        lda     tfloor
        sta     gr_fl,x
        lda     tceil
        sta     gr_ce,x
@nog:   lda     tw
        ora     tw+1
        ora     tw+2
        ora     tw+3
        sta     gfaces
        ldy     #0              ; blocked = DECKEND und alle vier Wände
        lda     tflags
        and     #TF_DECK
        beq     @b
        lda     tw
        beq     @b
        lda     tw+1
        beq     @b
        lda     tw+2
        beq     @b
        lda     tw+3
        beq     @b
        iny
@b:     cpx     #MAXGRP
        bcs     @r
        tya
        sta     gr_blk,x
@r:     rts

; Element bei ZP0 (Art 0, 1, 4) im Sichtdurchlauf
velem:  ldy     #0
        lda     (ZP0),y
        cmp     #2
        bcc     @wall
        cmp     #4
        bne     @r
        lda     cd              ; Objektplatz: d >= 1 und (keine Flächen oder INHALT)
        beq     @r
        lda     gfaces
        beq     @obj
        lda     tflags
        and     #TF_INH
        beq     @r
@obj:   jmp     objekte
@r:     rts
@wall:  ldx     gfaces
        beq     @r
        tax
        bne     @side
        lda     facef
        jmp     @f
@side:  ldy     #2
        lda     (ZP0),y
        bmi     @left
        lda     facer
        bpl     @f
@left:  lda     facel
@f:     tax
        lda     recs+10         ; Slotkarte Wand
        sta     ZP1
        lda     recs+11
        sta     ZP1+1
        lda     tw,x
        ldx     #0
        ldy     ecur
        jsr     resolve
        bcs     @r
        ldy     #4              ; allcov(cover, x, x + w)
        lda     (ZP0),y
        tax
        ldy     #6
        clc
        adc     (ZP0),y
        jsr     allcov_c
        beq     @r
        lda     #IT_WALL
        sta     g_type
        sta     g_kind
        lda     ecur
        sta     g_a
        lda     rent
        sta     g_p
        sta     ZP1
        lda     rent+1
        sta     g_p+1
        sta     ZP1+1
        ldy     #0              ; deck(e, t, ent) vor dem Anhängen bestimmen (gen zerstört ZP1)
        lda     (ZP1),y
        and     #EF_DECK
        beq     @nd
        lda     tflags
        and     #TF_DECK
        beq     @nd
        ldy     #3
        lda     (ZP0),y
        and     #1
@nd:    sta     wdeck
        jsr     itemadd         ; STOP möglich; abgelehnt ändert nichts an der Abdeckung
        lda     wdeck
        jeq     @r
        ldy     #13
        lda     (ZP0),y
        sta     wc1
        dey
        lda     (ZP0),y
        sta     wc0
        ldy     #0
        lda     (ZP0),y
        bne     @ps             ; Seite: Wartebereich, beide Masken
        ldx     wc0             ; Front: cover sofort
        lda     wc1
        jsr     mark_c
        ldy     #3
        lda     (ZP0),y
        and     #8
        beq     @pb
        ldx     wc0             ; DVG-Bit 3: bcov sofort
        lda     wc1
        jmp     mark_b
@pb:    lda     #0
        beq     @pa
@ps:    lda     #1
@pa:    ldx     npend
        cpx     #MAXPEND
        bcc     @pk
        lda     #E_TOOMANY      ; Wartebereich voll (Tabellen voll, 3.1)
        sta     verr
        jmp     vstop
@pk:    sta     pd_both,x
        lda     wc0
        sta     pd_c0,x
        lda     wc1
        sta     pd_c1,x
        inc     npend
        rts

; Objekte einer Zelle (5.8): P6e
objekte:
        rts

; ---------------------------------------------------------------- Bänder und Kacheln (5.6), A = 1 Boden, 2 Decke
vband:  sta     bk
        tax
        inx
        stx     bart            ; Art FLOOR 2 bzw. CEIL 3
        asl
        asl
        asl
        asl
        sta     bkx             ; Satz in recs
        tax
        lda     bk
        lsr
        bcc     @ce
        lda     dfy0
        ldy     dfy1
        bcs     @rw
@ce:    lda     dcy0
        ldy     dcy1
@rw:    sta     by0
        sty     tmp
        cpy     by0
        beq     @r0
        bcs     @rk
@r0:    rts
@rk:    lda     tmp
        sec
        sbc     by0
        sta     brows
        lda     recs,x          ; DTS gültig, NST
        sta     bval
        lda     recs+4,x
        sta     bnst
        lda     bk              ; Bandslot: Decke NE + d, Boden NE + D + 1 + d
        lsr
        lda     cd
        bcc     @bs
        sec
        adc     dvg_d
@bs:    sta     bsy
        lda     #0
        sta     blive
        sta     bgap
        sta     bmix
        sta     bpass
        lda     #$FF
        sta     bst1
        sta     bst0
@pass:  jsr     bit0
@el:    jsr     bitn
        bcc     @e1
        jmp     @pend
@e1:
        ; Einordnung: $FF egal, $FE Lücke, sonst Stil
        ldx     bgi
        cpx     #MAXGRP
        bcc     @gx
        ldx     #MAXGRP-1
@gx:    lda     gr_blk,x
        bne     @egal
        lda     bk
        lsr
        lda     gr_fl,x
        bcs     @n
        lda     gr_ce,x
@n:     beq     @gap
        ldx     bval
        beq     @gap
        sec
        sbc     #1
        cmp     bnst
        bcc     @sty
@gap:   lda     #$FE
        bne     @cls
@egal:  lda     #$FF
        bne     @cls
@sty:
@cls:   ldx     bpass
        bne     @p2
        ; Durchlauf 1: Entscheidung
        cmp     #$FF
        jeq     @nx
        ldx     #1
        stx     blive
        cmp     #$FE
        bne     @s1
        stx     bgap
        jne     @nx
@s1:    ldx     bst1
        cpx     #$FF
        bne     @s2
        sta     bst1
@s2:    cmp     bst1
        beq     @s3
        ldx     #1
        stx     bmix
@s3:    ldx     bgap            ; st0 = erster Stil mit auflösbarem Bandbild (nur ohne Lücke von Belang)
        jne     @nx
        ldx     bst0
        cpx     #$FF
        jne     @nx
        sta     bstt
        jsr     bslot
        lda     bstt
        clc
        adc     #1
        ldx     bkx
        ldy     bsy
        jsr     resolve
        bcs     @nx
        lda     bstt
        sta     bst0
        lda     rent
        sta     gent
        lda     rent+1
        sta     gent+1
        jmp     @nx
@p2:    ; Durchlauf 2: Kacheln
        cmp     #$FE
        bcs     @nx
        ldx     bgm
        beq     @t1
        cmp     bst0
        beq     @nx
@t1:    clc
        adc     #1
        pha
        ldx     bkx
        lda     recs+10,x
        sta     ZP1
        lda     recs+11,x
        sta     ZP1+1
        pla
        ldy     ecur
        jsr     resolve
        bcs     @nx
        lda     ecur
        jsr     elp
        ldy     #4
        lda     (ZP1),y
        tax
        ldy     #6
        clc
        adc     (ZP1),y
        jsr     allcov_b
        beq     @nx
        lda     #IT_WALL
        sta     g_type
        lda     bk
        sta     g_kind
        lda     ecur
        sta     g_a
        lda     rent
        sta     g_p
        lda     rent+1
        sta     g_p+1
        jsr     itemadd
@nx:    jmp     @el
@pend:  lda     bpass
        bne     @grnd
        lda     blive
        beq     @rts
        lda     #0
        sta     bgm
        lda     bgap
        beq     @ng
        ldx     bk              ; Lücke: Grund = Tapete
        lda     #1
        sta     lue,x
        bne     @p2go
@ng:    lda     bst0
        cmp     #$FF
        beq     @p2go
        inc     bgm             ; Grund = Band(st0)
        lda     bmix
        beq     @grnd           ; ein Stil: keine Kacheln
@p2go:  inc     bpass
        jmp     @pass
@grnd:  lda     bgm
        beq     @rts
        jsr     spans           ; Folgen von rechts nach links
        ldx     sp_n
@gl:    dex
        bmi     @rts
        stx     bsi
        lda     #IT_BAND
        sta     g_type
        lda     bk
        sta     g_kind
        lda     gent
        sta     g_p
        lda     gent+1
        sta     g_p+1
        lda     by0
        sta     g_a
        lda     brows
        sta     g_b
        lda     sp_c0,x
        sta     g_c0
        lda     sp_c1,x
        sta     g_c1
        jsr     itemadd
        ldx     bsi
        jmp     @gl
@rts:   rts

; Elemente der Art bart in der Tiefe: ecur, bgi (Zelle); C = 1 am Ende. Ohne bmulti über die in vcells
; gemerkten Boden-/Deckenelemente je Zelle, sonst über alle Elemente der Tiefe (Zellen wie in vcells gezählt)
bit0:   lda     #$FF
        sta     bgi
        lda     bmulti
        beq     @r
        lda     dfirst
        sta     bnx
        jsr     elp
        lda     ZP1
        sta     ZP0
        lda     ZP1+1
        sta     ZP0+1
        lda     dn
        sta     erem
        lda     #$80
        sta     blast
@r:     rts
bitn:   lda     bmulti
        bne     @scan
@g:     inc     bgi
        ldx     bgi
        cpx     ngrp
        bcs     @r
        lda     bk
        lsr
        lda     gr_fe,x
        bcs     @f
        lda     gr_cee,x
@f:     cmp     #$FF
        beq     @g
        sta     ecur
        clc
@r:     rts
@end:   sec
        rts
@scan:  lda     erem
        beq     @end
        ldy     #2
        lda     (ZP0),y
        cmp     blast
        beq     @s1
        sta     blast
        inc     bgi
@s1:    lda     bnx
        sta     ecur
        ldy     #0
        lda     (ZP0),y
        tax
        clc
        lda     ZP0
        adc     #16
        sta     ZP0
        bcc     @s2
        inc     ZP0+1
@s2:    inc     bnx
        dec     erem
        cpx     bart
        bne     @scan
        clc
        rts

; ZP1 = Slotkarte der Art bkx + NE (Bandslots)
bslot:  ldx     bkx
        clc
        lda     recs+10,x
        adc     dvg_ne
        sta     ZP1
        lda     recs+11,x
        adc     #0
        sta     ZP1+1
        rts

; ---------------------------------------------------------------- Tapete (5.7)
vtap:   lda     #0
        sta     nr
        lda     lue+2
        beq     @t1
        lda     dcy0
        ldx     dcy1
        jsr     addrng
@t1:    lda     cd
        cmp     dvg_d
        bne     @t2
        lda     dvg_y0
        ldx     dvg_y1
        jsr     addrng
@t2:    lda     lue+1
        beq     @t3
        lda     dfy0
        ldx     dfy1
        jsr     addrng
@t3:    lda     nr
        beq     @r
        jsr     spans
@rl:    dec     nr              ; Bereiche von unten nach oben
        bmi     @r
        ldx     sp_n
@sl:    dex                     ; Folgen von rechts nach links
        bmi     @rl
        stx     bsi
        ldy     nr
        lda     #IT_BG
        sta     g_type
        lda     rr0,y
        sta     g_a
        lda     rr1,y
        sta     g_b
        lda     sp_c0,x
        sta     g_c0
        lda     sp_c1,x
        sta     g_c1
        jsr     itemadd
        ldx     bsi
        jmp     @sl
@r:     rts

; Zeilenbereich [A, X) anhängen, leere weglassen, an den vorigen angrenzende verbinden
addrng: stx     tmp
        cmp     tmp
        bcs     @r
        ldy     nr
        beq     @new
        cmp     rr1-1,y
        bne     @new
        txa
        sta     rr1-1,y
@r:     rts
@new:   sta     rr0,y
        txa
        sta     rr1,y
        inc     nr
        rts

; ---------------------------------------------------------------- Masken
; allcov: X = c0, A = c1 (exklusiv, <= VW): Z = 1, wenn alle Spalten belegt sind (auch bei c0 >= c1)
allcov_c:
        tay
        lda     cover,y
        pha
        lda     #0
        sta     cover,y         ; Sentinel
@l:     lda     cover,x
        beq     @s
        inx
        bne     @l
@s:     pla
        sta     cover,y
        stx     tmp
        cpy     tmp
        rts
allcov_b:
        tay
        lda     bcov,y
        pha
        lda     #0
        sta     bcov,y
@l:     lda     bcov,x
        beq     @s
        inx
        bne     @l
@s:     pla
        sta     bcov,y
        stx     tmp
        cpy     tmp
        rts

; mark: X = c0, A = c1 (exklusiv)
mark_c: sta     tmp
@l:     cpx     tmp
        bcs     @r
        lda     cover,x
        bne     @n
        inc     cover,x
        inc     ncov
@n:     inx
        bne     @l
@r:     rts
mark_b: sta     tmp
        lda     #$FF
        sta     sp_n            ; Spannen neu berechnen
        lda     #1
@l:     cpx     tmp
        bcs     @r
        sta     bcov,x
        inx
        bne     @l
@r:     rts

; spans(bcov) nach sp_c0/sp_c1, sp_n Folgen (> 4 -> eine Folge von der ersten bis zur letzten freien Spalte)
spans:  lda     sp_n
        bpl     @ok
        ldx     #0
        stx     tmp             ; Anzahl
@a:     cpx     dvg_vw
        bcs     @end
        lda     bcov,x
        beq     @fs
        inx
        bne     @a
@fs:    stx     tmp2            ; Anfang
@b:     inx
        cpx     dvg_vw
        bcs     @e
        lda     bcov,x
        beq     @b
@e:     ldy     tmp
        cpy     #5
        bcs     @sk
        lda     tmp2
        sta     sp_c0,y
        txa
        sta     sp_c1,y
@sk:    inc     tmp
        stx     tmp3            ; Ende der letzten Folge
        bne     @a
@end:   lda     tmp
        cmp     #5
        bcc     @st
        lda     tmp3
        sta     sp_c1
        lda     #1
@st:    sta     sp_n
@ok:    rts

; ---------------------------------------------------------------- Hilfen
; ZP1 = Elementtabelle + 16 * A
elp:    ldx     #0
        stx     ZP1+1
        asl
        rol     ZP1+1
        asl
        rol     ZP1+1
        asl
        rol     ZP1+1
        asl
        rol     ZP1+1
        adc     dvg_elem        ; C = 0
        sta     ZP1
        lda     ZP1+1
        adc     dvg_elem+1
        sta     ZP1+1
        rts

; resolve (5.1): A = n, X = Satz (Art * 16), Y = Slotindex, ZP1 = Slotkarte (bzw. + NE).
; C = 0: rent = Verzeichniseintrag; C = 1: kein Bild. Zerstört A, X, Y, ZP1.
resolve:
        cmp     #1
        bcc     @no             ; n = 0
        sbc     #1
        cmp     recs+4,x        ; st >= NST
        bcs     @no
        sta     rst
        lda     recs,x
        beq     @no             ; DTS fehlt
        lda     (ZP1),y         ; k
        cmp     #$FF
        beq     @no
        tay
        stx     rkx
        txa
        asl
        ora     rst
        tax
        lda     sty_lo,x        ; Stilzeile (TEXSET)
        sta     ZP1
        lda     sty_hi,x
        sta     ZP1+1
        lda     (ZP1),y
        cmp     #$FF
        bne     @b
        lda     rkx             ; Rückgriff auf Stil 0
        asl
        tax
        lda     sty_lo,x
        sta     ZP1
        lda     sty_hi,x
        sta     ZP1+1
        lda     (ZP1),y
@b:     cmp     #$FE
        bcs     @no
        ldx     rkx             ; rent = Verzeichnis + 16 * b
        sta     tmp
        lsr
        lsr
        lsr
        lsr
        sta     rent+1
        lda     tmp
        asl
        asl
        asl
        asl
        clc
        adc     recs+14,x
        sta     rent
        lda     rent+1
        adc     recs+15,x
        sta     rent+1
        clc
        rts
@no:    sec
        rts

; iv += A
addiv:  clc
        adc     iv
        sta     iv
        bcc     @r
        inc     iv+1
@r:     rts

; mr = A * mw (8 x 16 Bit)
mul8:   sta     mt
        lda     #0
        sta     mr
        sta     mr+1
        lda     mw
        sta     ms
        lda     mw+1
        sta     ms+1
@l:     lsr     mt
        bcc     @n
        clc
        lda     mr
        adc     ms
        sta     mr
        lda     mr+1
        adc     ms+1
        sta     mr+1
@n:     asl     ms
        rol     ms+1
        lda     mt
        bne     @l
        rts

; e_dst = AP + row[A] + X
dstxy:  stx     tmp
        asl
        tay
        clc
        lda     rows,y
        adc     ap
        sta     e_dst
        lda     rows+1,y
        adc     ap+1
        sta     e_dst+1
        clc
        lda     e_dst
        adc     tmp
        sta     e_dst
        bcc     @r
        inc     e_dst+1
@r:     rts

; ---------------------------------------------------------------- Sichtliste: add (5.10)
; g_* = Eintrag; zählt Größen mit gen (wmode = 0) und nimmt an, kürzt, verwirft oder bricht ab (vstop)
itemadd:
        lda     nitems
        cmp     #MAXITEM
        bne     @g
        lda     #E_TOOMANY
        sta     verr
        jmp     vstop
@g:     lda     #0
        sta     iv
        sta     iv+1
        sta     im
        sta     im+1
        sta     wmode
        jsr     gen
        clc                     ; s1 = nv + v + nm
        lda     nv
        adc     iv
        sta     s1
        lda     nv+1
        adc     iv+1
        sta     s1+1
        clc
        lda     s1
        adc     nm
        sta     s1
        lda     s1+1
        adc     nm+1
        sta     s1+1
        clc                     ; s1 + m <= BL: annehmen
        lda     s1
        adc     im
        sta     s3
        lda     s1+1
        adc     im+1
        sta     s3+1
        lda     bl
        cmp     s3
        lda     bl+1
        sbc     s3+1
        bcs     @ok
        lda     im              ; Rand vorhanden?
        ora     im+1
        beq     @stop
        lda     iv+1
        bne     @strip
        lda     iv
        cmp     #7
        beq     @drop
        bcc     @stop
@strip: sec                     ; s1 - 7 <= BL: ohne Rand annehmen
        lda     s1
        sbc     #7
        sta     s3
        lda     s1+1
        sbc     #0
        sta     s3+1
        lda     bl
        cmp     s3
        lda     bl+1
        sbc     s3+1
        bcc     @stop
        lda     g_type
        ora     #IT_STRIP
        sta     g_type
        sec
        lda     iv
        sbc     #7
        sta     iv
        bcs     @s2
        dec     iv+1
@s2:    lda     #0
        sta     im
        sta     im+1
        lda     #1
        sta     vpart
        bne     @ok
@drop:  lda     #1
        sta     vpart
        rts
@stop:  lda     #E_TOOMANY
        sta     verr
        jmp     vstop
@ok:    ldx     nitems
        lda     g_kind
        asl
        asl
        asl
        asl
        ora     g_type
        sta     it_t,x
        lda     g_p
        sta     it_pl,x
        lda     g_p+1
        sta     it_ph,x
        lda     g_a
        sta     it_a,x
        lda     g_b
        sta     it_b,x
        lda     g_c0
        sta     it_c0,x
        lda     g_c1
        sta     it_c1,x
        inc     nitems
        clc
        lda     nv
        adc     iv
        sta     nv
        lda     nv+1
        adc     iv+1
        sta     nv+1
        clc
        lda     nm
        adc     im
        sta     nm
        lda     nm+1
        adc     im+1
        sta     nm+1
        rts

; ---------------------------------------------------------------- Erzeuger (zählen bzw. schreiben)
gen:    lda     g_type
        and     #$0F
        beq     gwall
        cmp     #IT_BAND
        bne     @bg
        jmp     gband
@bg:    jmp     gbg

; gemeinsamer Anfang Wand/Band: Satz, VRAM-Basis, Inhaltsanfang, Felder des Verzeichniseintrags
gent0:  lda     g_kind
        asl
        asl
        asl
        asl
        tax
        lda     recs+1,x
        sta     gvb
        lda     recs+2,x
        sta     gvb+1
        lda     recs+8,x
        sta     gcont
        lda     recs+9,x
        sta     gcont+1
        lda     g_p
        sta     ZP1
        lda     g_p+1
        sta     ZP1+1
        ldy     #13
@c:     lda     (ZP1),y         ; Flags, Slot, nk, h, kofs, rand_ofs, rand_len, vofs, vlen
        sta     ef,y
        dey
        bpl     @c
        clc                     ; ZP1 = Kerne bzw. Füllbytes
        lda     gcont
        adc     ekofs
        sta     ZP1
        sta     fsrc
        lda     gcont+1
        adc     ekofs+1
        sta     ZP1+1
        sta     fsrc+1
        lda     enk
        sta     kc
        lda     eh
        sta     fn
        rts

; WALL(e, ent) (5.3)
gwall:  jsr     gent0
        bit     wmode
        bpl     @k0
        lda     g_a             ; Element: x, y, w
        jsr     elp
        ldy     #4
        lda     (ZP1),y
        sta     ex
        iny
        lda     (ZP1),y
        sta     ey
        iny
        lda     (ZP1),y
        sta     ew
        lda     fsrc
        sta     ZP1
        lda     fsrc+1
        sta     ZP1+1
@k0:    lda     ef
        and     #EF_ZEIL
        beq     @kern
        lda     ey              ; ZEILEN: Füllbytes je Zeile
        sta     frow
        lda     ex
        sta     fx
        lda     ew
        sta     fw
        jmp     fillrows
@kern:  lda     kc
        beq     @rand
@kl:    ldy     #6
        lda     (ZP1),y
        sta     e_ss
        iny
        lda     (ZP1),y
        sta     e_ss+1
        bit     wmode
        bpl     @ke
        ldy     #0              ; src = VB + Kern-Offset
        clc
        lda     (ZP1),y
        adc     gvb
        sta     e_src
        iny
        lda     (ZP1),y
        adc     gvb+1
        sta     e_src+1
        iny                     ; dst = AP + row[y + dy] + x + dx
        lda     (ZP1),y
        clc
        adc     ex
        tax
        iny
        lda     (ZP1),y
        clc
        adc     ey
        jsr     dstxy
        ldy     #4
        lda     (ZP1),y
        sta     e_cnt
        iny
        lda     (ZP1),y
        sta     e_reps
@ke:    jsr     emit_vmc
        clc
        lda     ZP1
        adc     #8
        sta     ZP1
        bcc     @kn
        inc     ZP1+1
@kn:    dec     kc
        bne     @kl
@rand:  lda     ef
        and     #EF_RAND
        beq     @r
        bit     wmode
        bmi     @rw
        lda     #7              ; zählen: VMS-Eintrag + Liste
        jsr     addiv
        lda     evlen
        sta     im
        lda     evlen+1
        sta     im+1
@r:     rts
@rw:    lda     g_type
        bmi     @r              ; Rand weggelassen
        lda     ey
        ldx     ex
        jsr     dstxy
        jmp     vmsverb

; Rand unbeschnitten: VMS-Eintrag (src = VB + rand_ofs, dst = e_dst) und Liste wörtlich kopieren
vmsverb:
        clc
        lda     gvb
        adc     erofs
        sta     e_src
        lda     gvb+1
        adc     erofs+1
        sta     e_src+1
        lda     vmsp
        sta     e_lst
        lda     vmsp+1
        sta     e_lst+1
        jsr     emit_vms
        clc
        lda     gcont
        adc     evofs
        sta     csrc
        lda     gcont+1
        adc     evofs+1
        sta     csrc+1
        lda     evlen
        sta     clen
        lda     evlen+1
        sta     clen+1
        ; vcopy: clen Byte von csrc nach vmsp, vmsp += clen (selbstmodifizierend)
vcopy:  lda     csrc
        sta     @s1+1
        sta     @s2+1
        lda     csrc+1
        sta     @s1+2
        sta     @s2+2
        lda     vmsp
        sta     @d1+1
        sta     @d2+1
        lda     vmsp+1
        sta     @d1+2
        sta     @d2+2
        ldy     #0
        ldx     clen+1
        beq     @r0
@s1:    lda     $FFFF,y
@d1:    sta     $FFFF,y
        iny
        bne     @s1
        inc     @s1+2
        inc     @d1+2
        inc     @s2+2
        inc     @d2+2
        dex
        bne     @s1
@r0:    ldx     clen
        beq     @e
@s2:    lda     $FFFF,y
@d2:    sta     $FFFF,y
        iny
        dex
        bne     @s2
@e:     clc
        lda     vmsp
        adc     clen
        sta     vmsp
        lda     vmsp+1
        adc     clen+1
        sta     vmsp+1
        rts

; Füllzeilen: fn Bytes ab fsrc (Zeile frow ...), Spalte fx, Breite fw; gleiche Bytes gruppiert (Typ 4/5)
fillrows:
        lda     fn
        beq     @r
        lda     fsrc
        sta     ZP1
        lda     fsrc+1
        sta     ZP1+1
        lda     fw
        sta     e_cnt
        ldy     #0
@g:     sty     fr
        lda     (ZP1),y
        sta     e_b
@n:     iny
        cpy     fn
        bcs     @e
        lda     (ZP1),y
        cmp     e_b
        beq     @n
@e:     sty     fy
        tya
        sec
        sbc     fr
        sta     e_reps
        bit     wmode
        bpl     @c
        lda     frow
        clc
        adc     fr
        ldx     fx
        jsr     dstxy
@c:     jsr     emit_vmf
        ldy     fy
        cpy     fn
        bcc     @g
@r:     rts

; BAND(ent, y0, c0, c1) (5.6): ZEILEN oder Bandbild mit clip_image im Ausschnitt [c0, c1) x [y0, y0 + Zeilen)
gband:  jsr     gent0
        lda     ef
        and     #EF_ZEIL
        beq     @img
        lda     g_a
        sta     frow
        lda     g_c0
        sta     fx
        sec
        lda     g_c1
        sbc     g_c0
        sta     fw
        jmp     fillrows
@img:   lda     #0
        sta     cl_x0
        sta     cl_x0+1
        sta     cl_y0+1
        sta     cl_t
        lda     g_a
        sta     cl_y0
        lda     g_c0
        sta     cl_l
        lda     g_c1
        sta     cl_r
        lda     g_b
        sta     cl_b
        jsr     clipkerns
        lda     ef
        and     #EF_RAND
        beq     @r
        lda     evlen
        ora     evlen+1
        beq     @r
        lda     g_c0            ; volle Breite: unbeschnitten
        bne     @clip
        lda     g_c1
        cmp     dvg_vw
        bne     @clip
        bit     wmode
        bmi     @vw
        lda     #7
        jsr     addiv
        lda     evlen
        sta     im
        lda     evlen+1
        sta     im+1
@r:     rts
@vw:    lda     g_type
        bmi     @r
        lda     g_a
        ldx     #0
        jsr     dstxy
        jmp     vmsverb
@clip:  bit     wmode
        bpl     @cc
        lda     g_type
        bmi     @r
@cc:    clc
        lda     gcont
        adc     evofs
        sta     ZP1
        lda     gcont+1
        adc     evofs+1
        sta     ZP1+1
        lda     #0
        sta     cl_rt
        sta     cl_rt+1
        jmp     clipvms_e

; BG(r0, r1, c0, c1) (5.7)
gbg:    sec
        lda     g_c1
        sbc     g_c0
        sta     e_cnt
        sta     bgn
        lda     dbg_ok
        bne     @dbg
        lda     bgfill          ; ohne DBG: ein Typ 4/5
        sta     e_b
        sec
        lda     g_b
        sbc     g_a
        sta     e_reps
        bit     wmode
        bpl     @c
        lda     g_a
        ldx     g_c0
        jsr     dstxy
@c:     jmp     emit_vmf
@dbg:   lda     g_c0
        sta     fx
        lda     e_cnt
        sta     fw
        ; Zeilen über dem Panorama [r0, min(r1, y0))
        lda     g_b
        cmp     dbg_y0
        bcc     @m1
        lda     dbg_y0
@m1:    jsr     bgfill_rows_to
        ; Panorama [max(r0, y0), min(r1, y0 + h))
        lda     g_a
        cmp     dbg_y0
        bcs     @m2
        lda     dbg_y0
@m2:    sta     bga
        clc
        lda     dbg_y0
        adc     dbg_h
        sta     bgy1
        lda     g_b
        cmp     bgy1
        bcc     @m3
        lda     bgy1
@m3:    sta     bgb
        cmp     bga
        jeq     @low
        jcc     @low
        sec
        sbc     bga
        sta     e_reps
        lda     dbg_p
        sta     e_ss
        lda     dbg_p+1
        sta     e_ss+1
        bit     wmode
        bmi     @pw
        jsr     emit_vmc        ; zählen: ein oder zwei Typ 3
        jsr     bgq
        bcc     @low
        jsr     emit_vmc
        jmp     @low
@pw:    lda     dbg_p           ; src = VB + (a - y0) * P
        sta     mw
        lda     dbg_p+1
        sta     mw+1
        sec
        lda     bga
        sbc     dbg_y0
        jsr     mul8
        clc
        lda     mr
        adc     dbg_vram
        sta     bgsrc
        lda     mr+1
        adc     dbg_vram+1
        sta     bgsrc+1
        lda     bga
        ldx     g_c0
        jsr     dstxy
        jsr     bgq             ; C = 1: zwei Teile, e_cnt = n1
        php
        clc
        lda     bgsrc
        adc     bgqv
        sta     e_src
        lda     bgsrc+1
        adc     bgqv+1
        sta     e_src+1
        jsr     emit_vmc
        plp
        bcc     @low
        clc                     ; Teil 2: ab Quellspalte 0 an Zielspalte c0 + n1
        lda     e_dst
        adc     e_cnt
        sta     e_dst
        bcc     @p2
        inc     e_dst+1
@p2:    sec
        lda     bgn
        sbc     e_cnt
        sta     e_cnt
        lda     bgsrc
        sta     e_src
        lda     bgsrc+1
        sta     e_src+1
        jsr     emit_vmc
@low:   ; Zeilen unter dem Panorama [max(r0, y0 + h), r1)
        lda     g_a
        cmp     bgy1
        bcs     @m4
        lda     bgy1
@m4:    sta     frow
        lda     g_b
        sec
        sbc     frow
        beq     @r
        bcc     @r
        sta     fn
        jmp     bgfr
@r:     rts

; Füllzeilen der DBG [g_a, A) (leer, wenn A <= g_a)
bgfill_rows_to:
        sec
        sbc     g_a
        beq     bgret
        bcc     bgret
        sta     fn
        lda     g_a
        sta     frow
bgfr:   clc                     ; fsrc = DBG + 24 + frow
        lda     dbg_base
        adc     #24
        sta     fsrc
        lda     dbg_base+1
        adc     #0
        sta     fsrc+1
        clc
        lda     fsrc
        adc     frow
        sta     fsrc
        bcc     @f
        inc     fsrc+1
@f:     jmp     fillrows
bgret:  rts

; q = (o_v + c0) mod P -> bgqv; C = 1, wenn q + n > P (dann e_cnt = n1 = P - q), sonst e_cnt = n
bgq:    clc
        lda     bgom
        adc     g_c0
        sta     bgqv
        lda     bgom+1
        adc     #0
        sta     bgqv+1
@m:     lda     bgqv            ; while q >= P: q -= P
        cmp     dbg_p
        lda     bgqv+1
        sbc     dbg_p+1
        bcc     @d
        sta     bgqv+1
        lda     bgqv
        sbc     dbg_p
        sta     bgqv
        jmp     @m
@d:     sec                     ; n1 = P - q
        lda     dbg_p
        sbc     bgqv
        tax
        lda     dbg_p+1
        sbc     bgqv+1
        bne     @one            ; P - q >= 256 > n
        cpx     bgn
        bcs     @one            ; n <= P - q
        stx     e_cnt
        sec
        rts
@one:   lda     bgn
        sta     e_cnt
        clc
        rts

; ---------------------------------------------------------------- clip_image (P5b 6)
; Kerne: ZP1 = Kerntabelle, kc = Anzahl; Bildlage cl_x0/cl_y0 (16 Bit), Ausschnitt relativ zum Bild
; [cl_l, cl_r) x [cl_t, cl_b). Je sichtbarem Kern ein Typ 2/3 (zählen bzw. schreiben).
clipkerns:
        lda     kc
        bne     @k
        rts
@k:     ldy     #2
        lda     (ZP1),y
        sta     kdx
        iny
        lda     (ZP1),y
        sta     kdy
        iny
        lda     (ZP1),y
        sta     kw
        iny
        lda     (ZP1),y
        sta     kh
        iny
        lda     (ZP1),y
        sta     kss
        iny
        lda     (ZP1),y
        sta     kss+1
        lda     kdx             ; a = max(dx, L)
        cmp     cl_l
        bcs     @a
        lda     cl_l
@a:     sta     ka
        clc                     ; b = min(dx + w, R)
        lda     kdx
        adc     kw
        sta     kxe
        cmp     cl_r
        bcc     @b
        lda     cl_r
@b:     sta     kb
        cmp     ka
        beq     @nx
        bcc     @nx
        lda     kdy             ; c = max(dy, T)
        cmp     cl_t
        bcs     @c
        lda     cl_t
@c:     sta     kc_
        clc                     ; e = min(dy + h, B)
        lda     kdy
        adc     kh
        cmp     cl_b
        bcc     @e
        lda     cl_b
@e:     sta     ke
        cmp     kc_
        beq     @nx
        bcc     @nx
        lda     kss             ; st = srcstep oder w
        sta     kst
        lda     kss+1
        sta     kst+1
        ora     kss
        bne     @st
        lda     kw
        sta     kst
@st:    lda     kss             ; volle Breite: srcstep bleibt, sonst st
        sta     e_ss
        lda     kss+1
        sta     e_ss+1
        lda     ka
        cmp     kdx
        bne     @nf
        lda     kb
        cmp     kxe
        beq     @f
@nf:    lda     kst
        sta     e_ss
        lda     kst+1
        sta     e_ss+1
@f:     bit     wmode
        bpl     @em
        jsr     ckwrite
@em:    jsr     emit_vmc
@nx:    clc
        lda     ZP1
        adc     #8
        sta     ZP1
        bcc     @n1
        inc     ZP1+1
@n1:    dec     kc
        jne     @k
        rts

; Schreibwerte eines beschnittenen Kerns: src = VB + src + (c - dy) * st + (a - dx), dst = AP + row[y0 + c] + x0 + a
ckwrite:
        ldy     #0
        clc
        lda     (ZP1),y
        adc     gvb
        sta     e_src
        iny
        lda     (ZP1),y
        adc     gvb+1
        sta     e_src+1
        sec
        lda     ka
        sbc     kdx
        clc
        adc     e_src
        sta     e_src
        bcc     @s
        inc     e_src+1
@s:     sec
        lda     kc_
        sbc     kdy
        beq     @d
        ldx     kst
        stx     mw
        ldx     kst+1
        stx     mw+1
        jsr     mul8
        clc
        lda     e_src
        adc     mr
        sta     e_src
        lda     e_src+1
        adc     mr+1
        sta     e_src+1
@d:     clc
        lda     cl_x0
        adc     ka
        tax
        clc
        lda     cl_y0
        adc     kc_
        jsr     dstxy
        sec
        lda     kb
        sbc     ka
        sta     e_cnt
        sec
        lda     ke
        sbc     kc_
        sta     e_reps
        rts

; VMS-Liste beschneiden (P5b 6.2): ZP1 = Liste, Ausschnitt cl_l/cl_r/cl_t/cl_b, cl_rt = T * stride.
; Bezugspunkt der Ausgabe: (x0 + L, y0 + T) im Fenster. Zählen: iv += 7 und im = 3 + Bytes, falls ein Befehl
; sichtbar ist; schreiben: Liste nach vmsp und VMS-Eintrag (src = VB + rand_ofs, dst = AP + row[y0+T] + x0+L).
clipvms_e:
        bit     wmode
        bpl     @go
        lda     ZP0             ; VCL-Zeiger retten, ZP0 = Ausgabe der Liste
        sta     vclsv
        lda     ZP0+1
        sta     vclsv+1
        clc
        lda     vmsp
        adc     #3
        sta     ZP0
        lda     vmsp+1
        adc     #0
        sta     ZP0+1
@go:    ldy     #0
        lda     (ZP1),y
        sta     calpha
        iny
        lda     (ZP1),y
        sta     ccnt
        iny
        lda     (ZP1),y
        sta     ccnt+1
        lda     #0
        sta     cr
        sta     crs
        sta     crs+1
        sta     ck
        sta     ck+1
        sta     cn
        sta     cn+1
        sta     cb
        sta     cb+1
        lda     dvg_stride
        sta     crn
        lda     dvg_stride+1
        sta     crn+1
        ldy     #3
@cmd:   lda     ccnt
        bne     @c1
        lda     ccnt+1
        bne     @c0
        jmp     @done
@c0:    dec     ccnt+1
@c1:    dec     ccnt
        tya                     ; ZP1 += Y
        clc
        adc     ZP1
        sta     ZP1
        bcc     @c2
        inc     ZP1+1
@c2:    ldy     #1
        lda     (ZP1),y
        sta     cofs
        iny
        lda     (ZP1),y
        sta     cofs+1
@rw:    lda     cofs            ; while ofs >= rs + stride: nächste Zeile
        cmp     crn
        lda     cofs+1
        sbc     crn+1
        bcc     @rd
        lda     crn
        sta     crs
        lda     crn+1
        sta     crs+1
        clc
        lda     crn
        adc     dvg_stride
        sta     crn
        lda     crn+1
        adc     dvg_stride+1
        sta     crn+1
        inc     cr
        bne     @rw
@rd:    lda     cr              ; r >= B: Ende
        cmp     cl_b
        bcc     @r1
        jmp     @done
@r1:    sec                     ; col = ofs - rs
        lda     cofs
        sbc     crs
        sta     ccol
        lda     cofs+1
        sbc     crs+1
        sta     ccolh
        ldy     #0
        lda     (ZP1),y
        cmp     #1
        beq     @t1
        ; Typ 8
        lda     cr
        cmp     cl_t
        bcc     @i8
        lda     ccolh
        bne     @i8
        lda     ccol
        cmp     cl_l
        bcc     @i8
        cmp     cl_r
        bcs     @i8
        jsr     cflush
        sec                     ; o = rs - rT + col - L
        lda     ccol
        sbc     cl_l
        jsr     cofs_o
        lda     #8
        jsr     cput3
        ldy     #3
        jmp     @cmd
@i8:    inc     ck
        bne     @i8a
        inc     ck+1
@i8a:   ldy     #3
        jmp     @cmd
@t1:    ldy     #3              ; Typ 1
        lda     (ZP1),y
        sta     cln
        lda     cr
        cmp     cl_t
        jcc     @i1
        lda     ccolh
        jne     @i1
        lda     ccol
        cmp     cl_r
        jcs     @i1
        clc                     ; col + ln (9 Bit)
        adc     cln
        sta     cend
        lda     #0
        rol
        sta     cendh
        bne     @v1             ; >= 256 > L
        lda     cend
        cmp     cl_l
        beq     @i1
        bcc     @i1
@v1:    lda     ccol            ; a = max(col, L)
        cmp     cl_l
        bcs     @a1
        lda     cl_l
@a1:    sta     ca
        lda     cendh           ; b = min(col + ln, R)
        bne     @b0
        lda     cend
        cmp     cl_r
        bcc     @b1
@b0:    lda     cl_r
@b1:    sta     cbb
        sec                     ; k += a - col
        lda     ca
        sbc     ccol
        jsr     ckadd
        jsr     cflush
        sec
        lda     ca
        sbc     cl_l
        jsr     cofs_o
        lda     #1
        jsr     cput3
        sec                     ; Länge b - a
        lda     cbb
        sbc     ca
        bit     wmode
        bpl     @l0
        ldy     #0
        sta     (ZP0),y
        inc     ZP0
        bne     @l0
        inc     ZP0+1
@l0:    inc     cb
        bne     @l1
        inc     cb+1
@l1:    sec                     ; k += col + ln - b
        lda     cend
        sbc     cbb
        tax
        lda     cendh
        sbc     #0
        tay
        txa
        clc
        adc     ck
        sta     ck
        tya
        adc     ck+1
        sta     ck+1
        ldy     #4
        jmp     @cmd
@i1:    lda     cln
        jsr     ckadd
        ldy     #4
        jmp     @cmd
@done:  lda     cn
        ora     cn+1
        bne     @vis
        bit     wmode           ; nichts sichtbar: keine Liste
        bpl     @r
        lda     vclsv
        sta     ZP0
        lda     vclsv+1
        sta     ZP0+1
@r:     rts
@vis:   bit     wmode
        bmi     @wr
        lda     #7
        jsr     addiv
        clc
        lda     cb
        adc     #3
        sta     im
        lda     cb+1
        adc     #0
        sta     im+1
        rts
@wr:    lda     vmsp            ; Kopf: Alpha, Anzahl
        sta     ZP1
        lda     vmsp+1
        sta     ZP1+1
        ldy     #0
        lda     calpha
        sta     (ZP1),y
        iny
        lda     cn
        sta     (ZP1),y
        iny
        lda     cn+1
        sta     (ZP1),y
        lda     vmsp
        sta     e_lst
        lda     vmsp+1
        sta     e_lst+1
        lda     ZP0             ; vmsp = Ende der Liste
        sta     vmsp
        lda     ZP0+1
        sta     vmsp+1
        lda     vclsv
        sta     ZP0
        lda     vclsv+1
        sta     ZP0+1
        clc                     ; src = VB + rand_ofs, dst = AP + row[y0 + T] + x0 + L
        lda     gvb
        adc     erofs
        sta     e_src
        lda     gvb+1
        adc     erofs+1
        sta     e_src+1
        clc
        lda     cl_x0
        adc     cl_l
        tax
        clc
        lda     cl_y0
        adc     cl_t
        jsr     dstxy
        jmp     emit_vms

; ck += A
ckadd:  clc
        adc     ck
        sta     ck
        bcc     @r
        inc     ck+1
@r:     rts

; k > 0: Befehl 3 (source skip) ausgeben
cflush: lda     ck
        ora     ck+1
        beq     @r
        lda     ck
        sta     cot
        lda     ck+1
        sta     cot+1
        lda     #0
        sta     ck
        sta     ck+1
        lda     #3
        jmp     cput3
@r:     rts

; cot = rs - rT + A
cofs_o: clc
        adc     crs
        sta     cot
        lda     crs+1
        adc     #0
        sta     cot+1
        sec
        lda     cot
        sbc     cl_rt
        sta     cot
        lda     cot+1
        sbc     cl_rt+1
        sta     cot+1
        rts

; Befehl A mit Wort cot ausgeben (zählen: cb += 3, cn += 1)
cput3:  inc     cn
        bne     @n
        inc     cn+1
@n:     bit     wmode
        bpl     @c
        ldy     #0
        sta     (ZP0),y
        iny
        lda     cot
        sta     (ZP0),y
        iny
        lda     cot+1
        sta     (ZP0),y
        clc
        lda     ZP0
        adc     #3
        sta     ZP0
        bcc     @c
        inc     ZP0+1
@c:     clc
        lda     cb
        adc     #3
        sta     cb
        bcc     @r
        inc     cb+1
@r:     rts

; ---------------------------------------------------------------- VCL-Einträge (6)
; zählen: iv += Länge; schreiben: Eintrag bei ZP0, ZP0 += Länge, nent += 1 (höchstens 255)
emit_vmc:
        lda     e_ss
        ora     e_ss+1
        bit     wmode
        bmi     @w
        cmp     #1
        lda     #11
        bcc     @a
        lda     #13
@a:     jmp     addiv
@w:     cmp     #1              ; C = 1: Typ 3
        lda     #2
        adc     #0
        ldy     #0
        sta     (ZP0),y
        iny
        lda     e_src
        sta     (ZP0),y
        iny
        lda     e_src+1
        sta     (ZP0),y
        iny
        jsr     put_dst
        lda     e_cnt
        jsr     putb0
        lda     e_reps
        jsr     putb0
        lda     dvg_stride
        sta     (ZP0),y
        iny
        lda     dvg_stride+1
        sta     (ZP0),y
        iny
        lda     e_ss
        ora     e_ss+1
        jeq     ent_end
        lda     e_ss
        sta     (ZP0),y
        iny
        lda     e_ss+1
        sta     (ZP0),y
        iny
        bne     ent_end

emit_vmf:
        bit     wmode
        bmi     @w
        lda     e_reps
        cmp     #2
        lda     #7
        bcc     @a
        lda     #11
@a:     jmp     addiv
@w:     ldy     #0
        lda     e_reps
        cmp     #2
        lda     #4
        adc     #0              ; 5 bei reps > 1
        sta     (ZP0),y
        iny
        jsr     put_dst
        lda     e_b
        jsr     putb0
        lda     e_cnt
        jsr     putb0
        lda     e_reps
        cmp     #2
        bcc     ent_end
        jsr     putb0
        lda     dvg_stride
        sta     (ZP0),y
        iny
        lda     dvg_stride+1
        sta     (ZP0),y
        iny
        bne     ent_end

emit_vms:
        bit     wmode
        bmi     @w
        lda     #7
        jmp     addiv
@w:     ldy     #0
        lda     #12
        sta     (ZP0),y
        iny
        lda     e_src
        sta     (ZP0),y
        iny
        lda     e_src+1
        sta     (ZP0),y
        iny
        jsr     put_dst
        lda     e_lst
        sta     (ZP0),y
        iny
        lda     e_lst+1
        sta     (ZP0),y
        iny
ent_end:
        tya
        clc
        adc     ZP0
        sta     ZP0
        bcc     @n
        inc     ZP0+1
@n:     inc     nent
        bne     @r
        dec     nent
@r:     rts

put_dst:
        lda     e_dst
        sta     (ZP0),y
        iny
        lda     e_dst+1
        sta     (ZP0),y
        iny
        rts
putb0:  sta     (ZP0),y
        iny
        lda     #0
        sta     (ZP0),y
        iny
        rts

; ---------------------------------------------------------------- Variablen VIEW
        .segment "LIBBSS"
savesp: .res 1
ap:     .res 2
bl:     .res 2
fc:     .res 2                  ; feste Koordinate der Tiefe (16 Bit vorzeichenbehaftet)
idxd:   .res 2                  ; pos + d * F
fstep:  .res 2
flim:   .res 1
a0:     .res 1
alim:   .res 1
rmw:    .res 1                  ; 1: R = +-W
fneg:   .res 1
aneg:   .res 1
facef:  .res 1
facel:  .res 1
facer:  .res 1
bgom:   .res 2                  ; o_v mod P
sp_n:   .res 1                  ; Anzahl Spannen, $FF = neu berechnen
sp_c0:  .res 5
sp_c1:  .res 5
vz_start:                       ; ab hier löscht VIEW
nv:     .res 2
nm:     .res 2
nitems: .res 1
verr:   .res 1
vpart:  .res 1
ncov:   .res 1
nent:   .res 1
cd:     .res 1
vz_end:
cover:  .res 81
bcov:   .res 81
; Tiefe (Reihenfolge = Tiefeneintrag 0-5)
dcy0:   .res 1
dcy1:   .res 1
dfy0:   .res 1
dfy1:   .res 1
dfirst: .res 1
dn:     .res 1
dout:   .res 1
lue:    .res 3                  ; Index 1 Boden, 2 Decke
npend:  .res 1
pi:     .res 1
pd_c0:  .res MAXPEND
pd_c1:  .res MAXPEND
pd_both:.res MAXPEND
; Zellen
ngrp:   .res 1
gr_blk: .res MAXGRP
gr_fl:  .res MAXGRP
gr_ce:  .res MAXGRP
gr_fe:  .res MAXGRP             ; Boden-/Deckenelement der Zelle ($FF keins)
gr_cee: .res MAXGRP
bmulti: .res 1
bnx:    .res 1
ecur:   .res 1
erem:   .res 1
ecnt:   .res 1
gs:     .res 1
gp:     .res 2
gi:     .res 1
gcnt:   .res 1
pass:   .res 1
as:     .res 1
cidx:   .res 2
cout:   .res 1
tw:     .res 4                  ; Kachel der Zelle: walls, floor, ceil, flags
tfloor: .res 1
tceil:  .res 1
tflags: .res 1
gfaces: .res 1
wdeck:  .res 1
wc0:    .res 1
wc1:    .res 1
; Bänder
bk:     .res 1
bkx:    .res 1
bart:   .res 1
by0:    .res 1
brows:  .res 1
bval:   .res 1
bnst:   .res 1
bsy:    .res 1
blive:  .res 1
bgap:   .res 1
bmix:   .res 1
bpass:  .res 1
bst1:   .res 1
bst0:   .res 1
bstt:   .res 1
bgm:    .res 1
bgi:    .res 1
blast:  .res 1
bsi:    .res 1
gent:   .res 2
nr:     .res 1
rr0:    .res 3
rr1:    .res 3
; resolve, Hilfen
rst:    .res 1
rkx:    .res 1
rent:   .res 2
tmp:    .res 1
tmp2:   .res 1
tmp3:   .res 1
mt:     .res 1
mw:     .res 2
ms:     .res 2
mr:     .res 2
; Sichtliste
it_t:   .res MAXITEM
it_pl:  .res MAXITEM
it_ph:  .res MAXITEM
it_a:   .res MAXITEM
it_b:   .res MAXITEM
it_c0:  .res MAXITEM
it_c1:  .res MAXITEM
s1:     .res 2
s3:     .res 2
iv:     .res 2
im:     .res 2
; Erzeuger
wmode:  .res 1
oi:     .res 1
g_type: .res 1
g_kind: .res 1
g_p:    .res 2
g_a:    .res 1
g_b:    .res 1
g_c0:   .res 1
g_c1:   .res 1
gvb:    .res 2
gcont:  .res 2
ef:     .res 1                  ; Verzeichniseintrag (Bytes 0-13)
        .res 1
enk:    .res 1
eh:     .res 1
ekofs:  .res 2
erofs:  .res 2
        .res 2
evofs:  .res 2
evlen:  .res 2
ex:     .res 1
ey:     .res 1
ew:     .res 1
kc:     .res 1
fsrc:   .res 2
fn:     .res 1
frow:   .res 1
fx:     .res 1
fw:     .res 1
fr:     .res 1
fy:     .res 1
e_src:  .res 2
e_dst:  .res 2
e_cnt:  .res 1
e_reps: .res 1
e_ss:   .res 2
e_b:    .res 1
e_lst:  .res 2
vmsp:   .res 2
csrc:   .res 2
clen:   .res 2
bgn:    .res 1
bga:    .res 1
bgb:    .res 1
bgy1:   .res 1
bgsrc:  .res 2
bgqv:   .res 2
; clip_image
cl_x0:  .res 2
cl_y0:  .res 2
cl_l:   .res 1
cl_r:   .res 1
cl_t:   .res 1
cl_b:   .res 1
cl_rt:  .res 2
kdx:    .res 1
kdy:    .res 1
kw:     .res 1
kh:     .res 1
kss:    .res 2
kst:    .res 2
ka:     .res 1
kb:     .res 1
kc_:    .res 1
ke:     .res 1
kxe:    .res 1
calpha: .res 1
ccnt:   .res 2
cr:     .res 1
crs:    .res 2
crn:    .res 2
ck:     .res 2
cn:     .res 2
cb:     .res 2
cofs:   .res 2
ccol:   .res 1
ccolh:  .res 1
cln:    .res 1
cend:   .res 1
cendh:  .res 1
ca:     .res 1
cbb:    .res 1
cot:    .res 2
vclsv:  .res 2
        .segment "CODE"
