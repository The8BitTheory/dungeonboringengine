; dungeonboringengine 0.2 – VIEW (P6d: ohne Objekte; P6d-opt: Einpass; P6e: Objekte), eingebunden von lib.s
;
; docs/specs/P6-engine.md Abschnitt 5 (5.1-5.7, 5.9 Bänder mit Rand, 5.10, 5.11); die Liste ist bytegleich mit
; tools/dbeview.py view(). Ablauf (P6d-opt):
;   Sichtdurchlauf vorne -> hinten über die Zellentabelle aus GEOMSET (vdepth je Tiefe: Zellen mit Wänden und
;   Einordnung von Boden/Decke, Bänder, Tapete, Wartebereich). Jeder angenommene Eintrag wird sofort geschrieben
;   (itemadd/gen): VCL-Einträge abwärts von B1, VMS-Listen aufwärts ab B0; reicht der Platz nicht, wird er
;   zurückgenommen (iovf), im Zählmodus gemessen und nach 5.10 entschieden.
;   Spaltenmasken cover/bcov als Intervalllisten. Unbeschnittene VMS-Listen als VCL-Typ 9 (Bank 1); Build-Schalter VMS_COPY: Kopie in den Puffer (Typ 12).
; Zeropage: ZP0 = erstes Element der Zelle, ZP1 = Hilfszeiger (Slotkarte, Kerne, Listen); Block ZPB (lib.s):
; vp, mp, tp, dp, op und kk, kj, eo, wmode, kwi, kwn (clipvms_e: kwi/kwn als cyl/cq, dp gerettet als k).
; Bank 0 $0B00-$0BFF (Reserve der Engine): Abfall der Zählprobe von clipvms_e.

.ifdef MAXITEM_T
MAXITEM  = MAXITEM_T    ; nur Test (run_sim.py: Grenze klein, um den Abbruch zu prüfen)
.else
MAXITEM  = 96           ; Einträge je VIEW (7)
.endif
; heiße Einzelwerte im Zeropage-Block (zt, lib.s)
kk       = zt+0         ; Zelle (Zellentabelle)
kj       = zt+1         ; Zelle in der Tiefe
eo       = zt+2         ; 16 * Platz der Wand in der Zelle
wmode    = zt+3         ; Erzeuger: Bit 7 schreiben, Bit 6 Größe bekannt
kwi      = zt+4         ; Wand in wl
kwn      = zt+5
MAXGRP   = 31           ; Zellen je Tiefe (|s| <= S <= 15, GEOMSET prüft)
WM_W     = $80          ; wmode: schreiben
WM_X     = $40          ; wmode: Größe bekannt (nach iovf), keine Platzprüfung für beschnittene VMS-Listen
IT_STRIP = $80          ; Eintragstyp Bit 7: Rand weggelassen (5.10)
IT_WALL  = 0            ; Wand- oder Kachelbild: g_kind, ex/ey/ew = Element, dp = Verzeichniseintrag
IT_BAND  = 1            ; Bandbild: g_kind, dp, g_a = y0, g_b = Zeilen, g_c0/g_c1 = Spalten
IT_BG    = 2            ; Tapete: g_a = r0, g_b = r1, g_c0/g_c1
IT_SPR   = 3            ; Sprite (5.8): orx = Satz in recs, dp = Bildeintrag, cl_* = Lage und Ausschnitt, ofull, g_oi
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
        ldx     #vz_end-vz_start-1
@z:     sta     vz_start,x
        dex
        bpl     @z
        sec                     ; Ende-Byte bei B1 - 1; VCL abwärts davor, VMS aufwärts ab B0
        lda     buf_b1
        sbc     #1
        sta     vp
        lda     buf_b1+1
        sbc     #0
        sta     vp+1
        lda     #0
        tay
        sta     (vp),y
        lda     buf_b0
        sta     mp
        lda     buf_b0+1
        sta     mp+1
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
        jsr     rtab
        lda     recs+16         ; Boden/Decke: NST, falls DTS gültig (sonst 0)
        beq     @n1
        lda     recs+16+4
@n1:    sta     bnstk+1
        lda     recs+32
        beq     @n2
        lda     recs+32+4
@n2:    sta     bnstk+2
        lda     vdir            ; Tapete: o_v mod P (BGSET)
        asl
        tax
        lda     bgomt,x
        sta     bgom
        lda     bgomt+1,x
        sta     bgom+1
        ; Objektliste (5.8): sichtbare Objekte (Bit 6 = 0) der ersten min(OBJN, 16) mit Zellindex, Index, Offset;
        ; obm = Bitfeld der Low-Bytes ihrer Zellindizes (Vorfilter je Zelle; erst die Bits des vorigen VIEW löschen)
        ldy     nol
        beq     @oc
@oz:    lda     ol_lo-1,y
        lsr
        lsr
        lsr
        tax
        lda     #0
        sta     obm,x
        dey
        bne     @oz
@oc:    lda     OBJN
        cmp     #MAXOBJ+1
        bcc     @on
        lda     #MAXOBJ
@on:    sta     tmp
        ldy     #0
        ldx     #0
        stx     tmp2
        tax
        beq     @oe
        ldx     #0
@ol:    lda     OBJL+5,x
        and     #$40
        bne     @onx
        lda     OBJL,x
        sta     ol_lo,y
        stx     tmp3
        pha
        and     #7
        tax
        lda     bittab,x
        sta     mt
        pla
        lsr
        lsr
        lsr
        tax
        lda     obm,x
        ora     mt
        sta     obm,x
        ldx     tmp3
        lda     OBJL+1,x
        sta     ol_hi,y
        txa
        sta     ol_o,y
        lda     tmp2
        sta     ol_i,y
        iny
@onx:   txa
        clc
        adc     #OBJLEN
        tax
        inc     tmp2
        dec     tmp
        bne     @ol
@oe:    sty     nol
        tya                     ; objon: 0 keine Objekte und Gegenstände, Bit 7 Gegenstände möglich, sonst 1
        beq     @o1
        lda     #1
@o1:    ldx     itemn
        beq     @o2
        ora     #$80
@o2:    sta     objon
        lda     vdir            ; SUBPOS[v] (P4 2.6): Tabellenanfang 5 v
        asl
        asl
        adc     vdir            ; C = 0
        sta     spbase
; ---- Tiefen 0 ... D
@dl:    jsr     vdepth
        lda     cv_n            ; cover ganz belegt: ein Intervall [0, VW)
        cmp     #1
        bne     @cn
        lda     cv_s
        bne     @cn
        lda     cv_e
        cmp     dvg_vw
        bcs     vfin
@cn:
        lda     cd
        cmp     dvg_d
        bcs     vfin
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

; STOP (5.10): Sichtliste voll oder Puffer überschritten; alles bisher Angenommene steht schon im Puffer
vstop:  ldx     savesp
        txs
; ---------------------------------------------------------------- Ende (5.11, Einpass)
vfin:   lda     objv
        sta     OBJVIS
        lda     objv+1
        sta     OBJVIS+1
        lda     vp
        sta     VCLADR
        sta     P0
        lda     vp+1
        sta     VCLADR+1
        sta     P0+1
        sec                     ; VCLLEN = B1 - VCLADR
        lda     buf_b1
        sbc     vp
        sta     VCLLEN
        lda     buf_b1+1
        sbc     vp+1
        sta     VCLLEN+1
        sec                     ; VMSLEN = mp - B0
        lda     mp
        sbc     buf_b0
        sta     VMSLEN
        lda     mp+1
        sbc     buf_b0+1
        sta     VMSLEN+1
        ldx     nent
        ldy     #0
        lda     verr            ; A = 2 vor 3
        bne     @a
        lda     vpart
        beq     @a
        lda     #E_PARTIAL
@a:     rts

fnegtab: .byte  1, 0, 0, 1      ; F zeigt nach -y (N) bzw. -x (W)
anegtab: .byte  0, 0, 1, 1      ; R zeigt nach -x (S) bzw. -y (W)

; BGSET: bgomt[2 v] = o_v mod P für alle vier Richtungen (16 Bit, Rest der Division; P >= 1 geprüft)
bgoffs: ldx     #6
@v:     txa
        clc
        adc     #12
        tay
        lda     (ZP0),y
        sta     mw
        iny
        lda     (ZP0),y
        sta     mw+1
        lda     #0
        sta     mr
        sta     mr+1
        ldy     #16
@d:     asl     mw
        rol     mw+1
        rol     mr
        rol     mr+1
        lda     mr
        cmp     dbg_p
        lda     mr+1
        sbc     dbg_p+1
        bcc     @n
        sta     mr+1
        lda     mr
        sbc     dbg_p
        sta     mr
@n:     dey
        bne     @d
        lda     mr
        sta     bgomt,x
        lda     mr+1
        sta     bgomt+1,x
        dex
        dex
        bpl     @v
        rts

; Zellversatz je s (Index s + 15, |s| <= S): r_lo/r_hi = s * R (16 Bit), r_ok = Seitenkoordinate in der Karte
rtab:   lda     #1              ; du = +-1 bzw. +-W (in Richtung von s)
        ldx     rmw
        beq     @u
        lda     map_w
@u:     sta     du
        ldx     #0
        stx     du+1
        lda     aneg
        beq     @p
        sec
        txa
        sbc     du
        sta     du
        txa
        sbc     du+1
        sta     du+1
@p:     lda     #0
        sta     r_lo+15
        sta     r_hi+15
        ldx     #15
        ldy     dvg_s           ; s = 1 ... S
        beq     @ok
@up:    clc
        lda     r_lo,x
        adc     du
        sta     r_lo+1,x
        lda     r_hi,x
        adc     du+1
        sta     r_hi+1,x
        inx
        dey
        bne     @up
        ldx     #15
        ldy     dvg_s           ; s = -1 ... -S
@dl:    sec
        lda     r_lo,x
        sbc     du
        sta     r_lo-1,x
        lda     r_hi,x
        sbc     du+1
        sta     r_hi-1,x
        dex
        dey
        bne     @dl
@ok:    lda     aneg            ; gültige s + 15 in [rlo, rhi): 0 <= a0 +- s < alim
        bne     @n
        lda     #15             ; aneg = 0: [15 - a0, 15 + alim - a0)
        jsr     @sub
        sta     rlo
        lda     #15
        clc
        adc     alim
        jsr     @sub2
        sta     rhi
        rts
@n:     lda     #16             ; aneg = 1: [16 + a0 - alim, 16 + a0)
        clc
        adc     a0
        tax
        lda     #0
        adc     #0
        tay
        txa
        sec
        sbc     alim
        tax
        tya
        sbc     #0
        jsr     @clamp
        sta     rlo
        lda     #16
        clc
        adc     a0
        tax
        lda     #0
        adc     #0
        jsr     @clamp
        sta     rhi
        rts
@sub:   ldy     #0              ; (A - a0) als 16 Bit, begrenzt auf 0 ... 31
@sub1:  sec
        sbc     a0
        tax
        tya
        sbc     #0
        jmp     @clamp
@sub2:  ldy     #0              ; A = 15 + alim (Übertrag in C)
        bcc     @sub1
        iny
        bcs     @sub1
@clamp: bmi     @c0             ; A:X = Wert (Hi, Lo)
        bne     @c31
        txa
        cmp     #32
        bcc     @cr
@c31:   lda     #31
@cr:    rts
@c0:    lda     #0
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
        ldx     #1              ; dout: feste Koordinate außerhalb der Karte
        lda     fc+1
        bne     @o
        lda     fc
        cmp     flim
        bcs     @o
        dex
@o:     stx     dout
        clc                     ; cbase = Kachelebene + pos + d * F
        lda     map_cells
        adc     idxd
        sta     cbase
        lda     map_cells+1
        adc     idxd+1
        sta     cbase+1
        ldx     #2              ; Bänder der Tiefe: aktiv (Zeilen nicht leer), NST (0 ohne DTS), Bandslot
@bi:    lda     #0
        sta     blive,x
        sta     bgap,x
        sta     bmix,x
        sta     bact,x
        lda     #$FF
        sta     bst1,x
        sta     bst0,x
        sta     bst0f,x
        dex
        bne     @bi
        lda     dfy0
        cmp     dfy1
        bcs     @bf
        inc     bact+1
@bf:    lda     dcy0
        cmp     dcy1
        bcs     @bc
        inc     bact+2
@bc:    sec                     ; Bandslot: Boden NE + D + 1 + d, Decke NE + d
        lda     cd
        adc     dvg_d
        sta     bsyk+1
        lda     cd
        sta     bsyk+2
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

; ---------------------------------------------------------------- Zellen einer Tiefe (Zellentabelle aus GEOMSET)
; je Zelle: Kachel (tp), Boden/Decke/blocked für vband (gr_*), Wände in DVG-Reihenfolge bzw. bei INHALT mit Flächen
; erst die Fronten, dann die Seiten (5.2a; Objektplätze: P6e)
vcells: ldx     cd
        lda     d_kn,x
        bne     @go
        rts
@go:    sta     kn
        lda     #0              ; objd: Objekte in dieser Tiefe möglich (d >= 1)
        cpx     #0
        beq     @od
        lda     objon
@od:    sta     objd
        lda     d_k0,x
        sta     kk
        lda     #0
        sta     kj
        beq     @cell
@out:   ldy     map_out         ; Zelle außerhalb der Karte: Außenkachel
        jmp     @t
@cell:  ldx     kk
        lda     k_elo,x         ; ZP0 = erstes Element der Zelle
        sta     ZP0
        lda     k_ehi,x
        sta     ZP0+1
        ldy     k_si,x
        sty     ksi
        lda     dout
        bne     @out
        cpy     rlo
        bcc     @out
        cpy     rhi
        bcs     @out
        clc                     ; Zelle = cbase + s * R
        lda     cbase
        adc     r_lo,y
        sta     ZP1
        lda     cbase+1
        adc     r_hi,y
        sta     ZP1+1
        ldy     #0
        lda     (ZP1),y
        tay
@t:     lda     tpl,y           ; tp, tsum (Bit 7 Flächen, Bit 6 blocked, Kachel-Flags)
        sta     tp
        lda     tph,y
        sta     tp+1
        lda     tsm,y
        sta     tsum
        ldy     kj              ; Boden/Decke einordnen (5.6 Schritt 1): $FF egal/kein Element, $FE Lücke, sonst Stil
        lda     #$FF
        sta     gr_fc,y
        sta     gr_cc,y
        bit     tsum            ; blocked: egal
        bvs     @cls
        ldx     kk
        lda     k_fl,x
        cmp     #$FF
        beq     @nf
        lda     bact+1
        beq     @nf
        ldy     #4
        lda     (tp),y
        ldx     #1
        jsr     bclass
        ldy     kj
        sta     gr_fc,y
        ldx     kk
@nf:    lda     k_ce,x
        cmp     #$FF
        beq     @cls
        lda     bact+2
        beq     @cls
        ldy     #5
        lda     (tp),y
        ldx     #2
        jsr     bclass
        ldy     kj
        sta     gr_cc,y
@cls:   bit     tsum            ; Flächen: Wände; keine Flächen: Objekte (5.2)
        bpl     @obj
        lda     tsum            ; Durchlauf 0: alle Wände in DVG-Reihenfolge; INHALT (5.2a): Durchlauf 1 Fronten,
        and     #TF_INH         ; Objekte, Durchlauf 2 Seiten
        beq     @p0
        lda     #1
@p0:    sta     pass
        ldx     kk
        lda     k_wn,x
        beq     @pe
        sta     kwn
        lda     k_wo,x
        sta     kwi
@wl:    ldx     kwi
        lda     wl,x
        sta     eo
        jsr     vwall
        inc     kwi
        dec     kwn
        bne     @wl
@pe:    lda     pass            ; nach Durchlauf 1: Objekte, Durchlauf 2
        lsr
        bcs     @i1
@nx:    inc     kk
        inc     kj
        dec     kn
        jne     @cell
        rts
@i1:    lda     objd
        beq     @i2
        jsr     vobjc
@i2:    lda     #2
        bne     @p0
@obj:   lda     objd            ; Objekte oder Gegenstände möglich (und d >= 1)
        beq     @nx
        bmi     @oc             ; Gegenstände möglich: jede Zelle prüfen
        ldy     ksi             ; sonst Zellmarke: Low-Byte des Zellindex in obm (Zellen außerhalb der Karte
        clc                     ; verwirft vobjc)
        lda     idxd
        adc     r_lo,y
        tax
        and     #7
        tay
        txa
        lsr
        lsr
        lsr
        tax
        lda     obm,x
        and     bittab,y
        beq     @nx
@oc:    jsr     vobjc
        jmp     @nx

; Wand eo der Zelle (ZP0, tp, ksi) im Sichtdurchlauf: allcov vor resolve
vwall:  ldy     eo
        lda     (ZP0),y         ; Art 0 Front, 1 Seite
        ldx     pass
        beq     @all
        cmp     passart-1,x
        jne     @r
@all:   sta     eart
        tya                     ; allcov(cover, x, x + w)
        ora     #4
        tay
        lda     (ZP0),y
        tax
        iny
        iny
        clc
        adc     (ZP0),y
        jsr     allcov_c
        jcs     @r
        lda     eart
        bne     @side
        lda     facef
        bpl     @f
@side:  lda     ksi             ; s < 0 (ksi < 15): links
        cmp     #15
        lda     facel
        bcc     @f
        lda     facer
@f:     tay
        lda     (tp),y          ; n = walls[Fläche]
        pha
        lda     recs+10         ; Slotkarte Wand
        sta     ZP1
        lda     recs+11
        sta     ZP1+1
        lda     eo              ; Slot = erster Elementindex der Zelle + Platz
        lsr
        lsr
        lsr
        lsr
        ldx     kk
        clc
        adc     k_ei,x
        sta     ecur
        tay
        ldx     #0
        pla
        jsr     resolve
        bcs     @r
        lda     #IT_WALL
        sta     g_type
        sta     g_kind
        ldy     eo              ; ex, ey, ew = Element
        iny
        iny
        iny
        iny
        lda     (ZP0),y
        sta     ex
        iny
        lda     (ZP0),y
        sta     ey
        iny
        lda     (ZP0),y
        sta     ew
        ldy     #0              ; deck(e, t, ent)
        lda     (dp),y
        and     #EF_DECK
        beq     @nd
        lda     tsum
        and     #TF_DECK
        beq     @nd
        lda     eo
        ora     #3
        tay
        lda     (ZP0),y
        and     #1
@nd:    sta     wdeck
        jsr     itemadd         ; STOP möglich; auch ein verworfener Eintrag (nur Rand) deckt danach ab (Referenz)
        lda     wdeck
        beq     @r
        lda     eo
        ora     #13
        tay
        lda     (ZP0),y
        sta     wc1
        dey
        lda     (ZP0),y
        sta     wc0
        lda     eart
        bne     @ps             ; Seite: Wartebereich, beide Masken
        ldx     wc0             ; Front: cover sofort
        lda     wc1
        jsr     mark_c
        lda     eo
        ora     #3
        tay
        lda     (ZP0),y
        and     #8
        beq     @pb
        ldx     wc0             ; DVG-Bit 3: bcov sofort
        lda     wc1
        jmp     mark_b
@r:     rts
@pb:    lda     #0
        beq     @pa
@ps:    lda     #1
@pa:    ldx     npend           ; GEOMSET garantiert npend < MAXPEND
        sta     pd_both,x
        lda     wc0
        sta     pd_c0,x
        lda     wc1
        sta     pd_c1,x
        inc     npend
        rts

passart: .byte  0, 1            ; Durchlauf 1 Fronten, 2 Seiten (5.2a)

;---------------------------------------------------------------- Objekte (5.8)
; Objekte der Zelle kk (ZP0 = erstes Element, ksi): Kandidaten (Gegenstand der Inhaltsebene, Objekte der Liste),
; dann je Objektplatz der Zelle in umgekehrter Malreihenfolge (p = 4 ... 0, bei gleichem p Objekte mit
; absteigendem i, zuletzt der Gegenstand) je ein Sprite-Eintrag. Nur d >= 1 und Zellen in der Karte.
vobjc:  ldx     kk              ; (vcells: nur mit objd, d. h. d >= 1 und Objekte/Gegenstände möglich)
        lda     k_ob,x
        cmp     #$FF
        bne     @go
@rt:    rts
@go:
        sta     eo
        lda     dout
        bne     @rt
        ldy     ksi
        cpy     rlo
        bcc     @rt
        cpy     rhi
        bcs     @rt
        clc                     ; c = pos + d F + s R
        lda     idxd
        adc     r_lo,y
        sta     oclo
        lda     idxd+1
        adc     r_hi,y
        sta     ochi
        ldy     #0
        sty     nc
        lda     itemn
        beq     @ob
        clc                     ; Gegenstand g = Inhalt(c) AND 63 mit itemtab[g] <> 0: p = 2, Richtung $FF, ITEMPH
        lda     map_cont
        adc     oclo
        sta     ZP1
        lda     map_cont+1
        adc     ochi
        sta     ZP1+1
        lda     (ZP1),y
        and     #63
        beq     @ob
        tax
        lda     itemtab,x
        beq     @ob
        sec
        sbc     #1
        sta     cset
        lda     #2
        sta     cp
        lda     #$FF
        sta     cdir
        sta     coi
        lda     ITEMPH
        sta     cph
        inc     nc
@ob:    lda     oclo            ; Vorfilter: Low-Byte im Bitfeld obm?
        and     #7
        tay
        lda     oclo
        lsr
        lsr
        lsr
        tax
        lda     obm,x
        and     bittab,y
        beq     @ce
        ldx     #0              ; Objekte der Liste in i-Reihenfolge
@ol:    cpx     nol
        bcs     @ce
        lda     ol_lo,x
        cmp     oclo
        bne     @on
        lda     ol_hi,x
        cmp     ochi
        bne     @on
        stx     tmp
        ldy     nc
        lda     ol_i,x
        sta     coi,y
        lda     ol_o,x
        tax
        lda     OBJL+2,x
        sta     cset,y
        lda     OBJL+3,x
        sta     cdir,y
        lda     OBJL+4,x
        sta     cph,y
        lda     OBJL+5,x        ; p = SUBPOS[v][min(q, 4)]
        and     #7
        cmp     #5
        bcc     @q
        lda     #4
        clc
@q:     adc     spbase          ; C = 0
        tax
        lda     subpos,x
        sta     cp,y
        inc     nc
        ldx     tmp
@on:    inx
        bne     @ol
@ce:    lda     nc
        beq     @r
@el:    ldy     eo              ; Objektplätze der Zelle (DVG-Reihenfolge)
        lda     (ZP0),y
        cmp     #4
        bne     @en
        lda     #4
        sta     ocp
@pl:    ldx     nc
@cl:    dex
        bmi     @pn
        lda     cp,x
        cmp     ocp
        bne     @cl
        stx     ocj
        jsr     vspr            ; STOP möglich
        ldx     ocj
        jmp     @cl
@pn:    dec     ocp
        bpl     @pl
@en:    ldx     kk
        lda     eo
        cmp     k_oe,x
        bcs     @r
        adc     #16             ; C = 0
        sta     eo
        bne     @el
@r:     rts

; Kandidat ocj an Platz ocp des Objektplatzes eo (5.8 Schritte 3-6)
vspr:   lda     cset,x
        cmp     #8
        bcs     @r0
        asl
        asl
        asl
        asl
        adc     #48             ; C = 0: Satz in recs
        tay
        lda     recs,y
        beq     @r0
        sty     orx
        lda     cdir,x          ; a = 0 bei $FF, sonst (2 + v - o) AND 3
        cmp     #$FF
        beq     @a0
        eor     #$FF
        sec
        adc     vdir
        clc
        adc     #2
        and     #3
        tay
        bpl     @a
@a0:    ldy     #0
@a:     lda     cph,x           ; f >= NP: f = 0
        ldx     orx
        cmp     recs+4,x
        bcc     @p
        lda     #0
@p:     sta     oph
        lda     recs+8,x        ; ai = angle_map[a] (Kopf 12-15)
        sta     ZP1
        lda     recs+9,x
        sta     ZP1+1
        tya
        clc
        adc     #12
        tay
        lda     (ZP1),y
        tay
        lda     cd              ; Index ai * D + d - 1
        sec
        sbc     #1
@m:     dey
        bmi     @md
        clc
        adc     dvg_d
        bcc     @m
@r0:    rts
@md:    sta     obase
        lda     recs+10,x       ; Indextabelle
        sta     ZP1
        lda     recs+11,x
        sta     ZP1+1
        ldy     oph             ; + f * NA * D (f < NP <= 32, meist klein: Addition statt mul8)
        beq     @f0
@ph:    clc
        lda     ZP1
        adc     recs+14,x
        sta     ZP1
        bcc     @p2
        inc     ZP1+1
@p2:    dey
        bne     @ph
        ldy     obase
        lda     (ZP1),y
        cmp     #$FF
        bne     @b
        ldx     orx             ; $FF: Phase 0
        lda     recs+10,x
        sta     ZP1
        lda     recs+11,x
        sta     ZP1+1
@f0:    ldy     obase
        lda     (ZP1),y
@b:     cmp     #$FE
        bcs     @r0
        ldx     orx             ; dp = Verzeichnis + 16 b
        sta     tmp
        lsr
        lsr
        lsr
        lsr
        sta     dp+1
        lda     tmp
        asl
        asl
        asl
        asl
        clc
        adc     recs+12,x
        sta     dp
        lda     dp+1
        adc     recs+13,x
        sta     dp+1
        ldy     #1              ; w, h, fx, fy
        lda     (dp),y
        sta     ow
        iny
        lda     (dp),y
        sta     oh
        lda     ocp             ; Anker p: Spalte (vorzeichenbehaftet), Zeile
        asl
        adc     eo              ; C = 0
        adc     #4
        tay
        ldx     #0
        lda     (ZP0),y
        bpl     @ax
        dex
@ax:    stx     tmp
        sec                     ; x0 = ax - fx (16 Bit)
        ldy     #3
        sbc     (dp),y
        sta     cl_x0
        lda     tmp
        sbc     #0
        sta     cl_x0+1
        bmi     @x0n            ; cx0 = max(x0, 0)
        lda     cl_x0
        bcs     @x0             ; C = 1 (kein Borgen)
@x0n:   lda     #0
@x0:    sta     ocx0
        clc                     ; cx1 = min(x0 + w, VW)
        lda     cl_x0
        adc     ow
        tax
        lda     cl_x0+1
        adc     #0
        bmi     @rr
        bne     @x1v
        cpx     dvg_vw
        bcc     @x1
@x1v:   ldx     dvg_vw
@x1:    stx     ocx1
        cpx     ocx0
        beq     @rr
        bcc     @rr
        lda     ocp             ; y0 = ay - fy (16 Bit)
        asl
        adc     eo              ; C = 0
        adc     #5
        tay
        lda     (ZP0),y
        sec
        ldy     #4
        sbc     (dp),y
        sta     cl_y0
        lda     #0
        sbc     #0
        sta     cl_y0+1
        bmi     @y0n            ; cy0 = max(y0, 0)
        lda     cl_y0
        bcs     @y0
@y0n:   lda     #0
@y0:    sta     ocy0
        clc                     ; cy1 = min(y0 + h, VH)
        lda     cl_y0
        adc     oh
        tax
        lda     cl_y0+1
        adc     #0
        bmi     @rr
        bne     @y1v
        cpx     dvg_vh
        bcc     @y1
@y1v:   ldx     dvg_vh
@y1:    stx     ocy1
        cpx     ocy0
        beq     @rr
        bcc     @rr
        ldx     ocx0            ; erste/letzte freie Spalte in cover
        lda     ocx1
        jsr     ffree
        bcc     @vis
@rr:    rts
@vis:   sec                     ; Ausschnitt im Bild: L, R, T, B
        sbc     cl_x0
        sta     cl_r
        txa
        sec
        sbc     cl_x0
        sta     cl_l
        sec
        lda     ocy1
        sbc     cl_y0
        sta     cl_b
        sec
        lda     ocy0
        sbc     cl_y0
        sta     cl_t
        ldx     #0              ; ofull: 1 unbeschnitten (L = 0, R = w, T = 0, B = h), 2 nur Zeilen (L = 0, R = w)
        lda     cl_l
        bne     @cut
        lda     cl_r
        cmp     ow
        bne     @cut
        ldx     #2
        lda     cl_t
        bne     @cut
        lda     cl_b
        cmp     oh
        bne     @cut
        dex
@cut:   stx     ofull
        lda     ow
        sta     cl_w
        ldx     ocj
        lda     coi,x
        sta     g_oi
        lda     #IT_SPR
        sta     g_type
        jmp     itemadd

; erste freie Spalte >= X und letzte freie < A in cover: C = 0, X = erste, A = letzte + 1; C = 1 keine
ffree:  stx     ia
        sta     ib
        ldy     #0
@f:     cpy     cv_n
        bcs     @l
        lda     ia
        cmp     cv_e,y
        bcs     @fn             ; E <= c0: weiter
        cmp     cv_s,y
        bcc     @l              ; S > c0: c0 frei
        lda     cv_e,y          ; c0 im Intervall: erste freie = E (berührende Intervalle sind verbunden)
        sta     ia
        bcs     @l
@fn:    iny
        bne     @f
@l:     ldy     cv_n
@g:     dey
        bmi     @e
        lda     cv_s,y
        cmp     ib
        bcs     @g              ; S >= c1: weiter
        lda     cv_e,y
        cmp     ib
        bcc     @e              ; E < c1: c1 - 1 frei
        lda     cv_s,y
        sta     ib
@e:     lda     ia
        cmp     ib
        ldx     ia
        lda     ib
        rts

subpos: .byte   0, 1, 3, 4, 2,  3, 0, 4, 1, 2,  4, 3, 1, 0, 2,  1, 4, 0, 3, 2   ; SUBPOS[v][q] (P4 2.6)

; ---------------------------------------------------------------- Bänder und Kacheln (5.6)
; Einordnung im Zellendurchlauf (5.6 Schritt 1): X = Art (1 Boden, 2 Decke), A = n; Rückgabe A = $FE Lücke oder Stil.
; Führt je Art und Tiefe live/gap/mix, st1 (erster Stil) und st0 (erster Stil mit auflösbarem Bandbild, nur
; ohne Lücke von Belang; bst0f = zuletzt erfolglos versuchter Stil); gent[Art] = Bandbild von st0.
bclass: cmp     #1
        jcc     @gap            ; n = 0
        sbc     #1
        cmp     bnstk,x         ; st >= NST (bzw. DTS fehlt: NST = 0)
        bcs     @gap
        sta     bstt
        lda     #1
        sta     blive,x
        lda     bst1,x
        cmp     #$FF
        bne     @s1
        lda     bstt
        sta     bst1,x
        bcs     @s3             ; C = 1 nach cmp #$FF
@s1:    cmp     bstt
        beq     @s3
        lda     #1
        sta     bmix,x
@s3:    lda     bgap,x
        bne     @ret
        lda     bst0,x
        cmp     #$FF
        bne     @ret
        lda     bstt
        cmp     bst0f,x
        beq     @ret
        stx     bk
        txa                     ; ZP1 = Slotkarte der Art + NE (Bandslots)
        asl
        asl
        asl
        asl
        tax
        clc
        lda     recs+10,x
        adc     dvg_ne
        sta     ZP1
        lda     recs+11,x
        adc     #0
        sta     ZP1+1
        ldy     bk
        lda     bsyk,y
        tay
        lda     bstt
        clc
        adc     #1
        jsr     resolve
        ldx     bk
        lda     bstt
        bcs     @fail
        sta     bst0,x
        lda     dp
        sta     gentl,x
        lda     dp+1
        sta     genth,x
        lda     bstt
        rts
@fail:  sta     bst0f,x
@ret:   lda     bstt
        rts
@gap:   lda     #1
        sta     blive,x
        sta     bgap,x
        lda     #$FE
        rts

; Bänder der Tiefe, A = 1 Boden, 2 Decke (5.6 Schritte 2-5): Entscheidung aus bclass, Kacheln, Grund
vband:  sta     bk
        tax
        lda     bact,x
        beq     @r0
        lda     blive,x
        bne     @go
@r0:    rts
@go:    lda     bk
        asl
        asl
        asl
        asl
        sta     bkx             ; Satz in recs
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
        sec
        lda     tmp
        sbc     by0
        sta     brows
        ldx     bk
        lda     #0
        sta     bgm
        lda     bgap,x
        beq     @ng
        lda     #1              ; Lücke: Grund = Tapete, Kacheln für alle Stile
        sta     lue,x
        bne     @tiles
@ng:    lda     bst0,x
        cmp     #$FF
        beq     @tiles          ; kein auflösbares Bandbild: Kacheln für alle, kein Grund
        inc     bgm             ; Grund = Band(st0)
        lda     bmix,x
        jeq     @grnd           ; ein Stil: keine Kacheln
@tiles: ldx     cd              ; Kacheln in DVG-Reihenfolge (= Zellreihenfolge)
        lda     d_k0,x
        sta     bkk
        lda     d_kn,x
        sta     bkn
        lda     #0
        sta     bgi
@tl:    ldy     bgi
        ldx     bk
        lda     bk
        lsr
        lda     gr_fc,y
        bcs     @t0
        lda     gr_cc,y
@t0:    cmp     #$FE
        bcs     @tn
        ldy     bgm
        beq     @t1
        cmp     bst0,x
        beq     @tn
@t1:    sta     bstt
        ldx     bkk
        lda     k_elo,x         ; ZP0 = erstes Element der Zelle, beo = Platz des Boden-/Deckenelements
        sta     ZP0
        lda     k_ehi,x
        sta     ZP0+1
        lda     bk
        lsr
        lda     k_fl,x
        bcs     @t2
        lda     k_ce,x
@t2:    sta     beo
        lsr
        lsr
        lsr
        lsr
        clc
        adc     k_ei,x
        sta     ecur
        ldy     beo             ; allcov(bcov, x, x + w) vor resolve; ex, ey, ew
        iny
        iny
        iny
        iny
        lda     (ZP0),y
        sta     ex
        tax
        iny
        lda     (ZP0),y
        sta     ey
        iny
        lda     (ZP0),y
        sta     ew
        clc
        adc     ex
        jsr     allcov_b
        bcs     @tn
        ldx     bkx
        lda     recs+10,x
        sta     ZP1
        lda     recs+11,x
        sta     ZP1+1
        lda     bstt
        clc
        adc     #1
        ldy     ecur
        jsr     resolve
        bcs     @tn
        lda     #IT_WALL
        sta     g_type
        lda     bk
        sta     g_kind
        jsr     itemadd
@tn:    inc     bkk
        inc     bgi
        dec     bkn
        jne     @tl
@grnd:  lda     bgm
        beq     @rts
        jsr     spans           ; Folgen von rechts nach links
        ldx     sp_n
@gl:    dex
        bmi     @rts
        stx     bsi
        lda     #IT_BAND
        sta     g_type
        ldy     bk
        sty     g_kind
        lda     gentl,y
        sta     dp
        lda     genth,y
        sta     dp+1
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
; cover und bcov als sortierte Listen belegter Spalten-Intervalle [S, E) (disjunkt, sich berührende verbunden),
; höchstens MAXIV; VIEW beginnt mit leeren Listen. Kosten je Aufruf proportional zur Zahl der Intervalle.
MAXIV    = 41

; allcov: X = c0, A = c1 (exklusiv): C = 1, wenn alle Spalten belegt sind (auch bei c0 >= c1)
.macro IV_ALL PS, PE, PN
        .local ivl, ivf, ivno, ivyes
        sta     ib
        cpx     ib
        bcs     ivyes
        stx     ia
        ldy     #0
ivl:      cpy     PN
        bcs     ivno
        txa
        cmp     PE,y             ; c0 < E[y]: Intervall gefunden
        bcc     ivf
        iny
        bne     ivl
ivf:      cmp     PS,y             ; c0 >= S[y] und E[y] >= c1
        bcc     ivno
        lda     PE,y
        cmp     ib
        rts
ivno:     clc
ivyes:    rts
.endmacro

; mark: X = c0, A = c1 (exklusiv) belegen
.macro IV_MARK PS, PE, PN
        .local ivf1, ivg, ivms, ivmj, ivme, ivme2, ivcp, ivcd, ivins, ivsh, ivput, ivr
        sta     ib
        cpx     ib
        bcs     ivr
        stx     ia
        ldy     #0
ivf1:     cpy     PN               ; i = erstes Intervall mit E >= c0
        bcs     ivins
        lda     PE,y
        cmp     ia
        bcs     ivg
        iny
        bne     ivf1
ivg:      lda     ib              ; S[i] > c1: neues Intervall vor i
        cmp     PS,y
        bcc     ivins
        lda     ia              ; S[i] = min(S[i], c0)
        cmp     PS,y
        bcs     ivms
        sta     PS,y
ivms:     tya                     ; j = letztes Intervall mit S <= c1
        tax
ivmj:     inx
        cpx     PN
        bcs     ivme
        lda     ib
        cmp     PS,x
        bcs     ivmj
ivme:     dex
        lda     PE,x             ; E[i] = max(E[j], c1)
        cmp     ib
        bcs     ivme2
        lda     ib
ivme2:    sta     PE,y
        stx     ij
        cpy     ij
        beq     ivr
        iny                     ; i+1 ... j entfernen
        inx
ivcp:     cpx     PN
        bcs     ivcd
        lda     PS,x
        sta     PS,y
        lda     PE,x
        sta     PE,y
        inx
        iny
        bne     ivcp
ivcd:     sty     PN
ivr:      rts
ivins:    sty     ii              ; [c0, c1) bei i einfügen
        ldx     PN
ivsh:     cpx     ii
        beq     ivput
        lda     PS-1,x
        sta     PS,x
        lda     PE-1,x
        sta     PE,x
        dex
        bne     ivsh
ivput:    lda     ia
        sta     PS,x
        lda     ib
        sta     PE,x
        inc     PN
        rts
.endmacro

allcov_c:
        IV_ALL  cv_s, cv_e, cv_n
allcov_b:
        IV_ALL  bc_s, bc_e, bc_n
mark_c:
        IV_MARK cv_s, cv_e, cv_n
mark_b: ldy     #$FF
        sty     sp_n            ; Spannen neu berechnen
        IV_MARK bc_s, bc_e, bc_n

; spans(bcov) nach sp_c0/sp_c1, sp_n Folgen (> 4 -> eine Folge von der ersten bis zur letzten freien Spalte)
spans:  lda     sp_n
        bpl     @ok
        lda     #0
        sta     ia              ; Ende des vorigen Intervalls
        tax                     ; Anzahl Folgen
        tay
@l:     cpy     bc_n
        bcs     @la
        lda     bc_s,y
        cmp     ia
        beq     @nx
        jsr     @add            ; Folge [ia, S[y])
@nx:    lda     bc_e,y
        sta     ia
        iny
        bne     @l
@la:    lda     ia
        cmp     dvg_vw
        bcs     @end
        lda     dvg_vw
        jsr     @add
@end:   cpx     #5
        bcc     @st
        lda     ib
        sta     sp_c1
        ldx     #1
@st:    stx     sp_n
@ok:    rts
@add:   sta     ib              ; letzte Folge endet bei ib
        cpx     #5
        bcs     @a1
        sta     sp_c1,x
        lda     ia
        sta     sp_c0,x
@a1:    inx
        rts

; ---------------------------------------------------------------- Hilfen
; resolve (5.1): A = n, X = Satz (Art * 16), Y = Slotindex, ZP1 = Slotkarte (bzw. + NE).
; C = 0: dp = Verzeichniseintrag; C = 1: kein Bild (dp unverändert). Zerstört A, X, Y, ZP1.
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
        ldx     rkx             ; dp = Verzeichnis + 16 * b
        sta     tmp
        lsr
        lsr
        lsr
        lsr
        sta     dp+1
        lda     tmp
        asl
        asl
        asl
        asl
        clc
        adc     recs+14,x
        sta     dp
        lda     dp+1
        adc     recs+15,x
        sta     dp+1
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

; mr = A * mw (8 x 16 Bit); zerstört X, Y
mul8:   tax                     ; X = Rest des Multiplikators, Y = Ergebnis lo
        lda     #0
        sta     mr+1
        tay
        lda     mw
        sta     ms
        lda     mw+1
        sta     ms+1
        txa
        beq     @e
@l:     lsr
        tax
        bcc     @n
        tya
        clc
        adc     ms
        tay
        lda     mr+1
        adc     ms+1
        sta     mr+1
@n:     asl     ms
        rol     ms+1
        txa
        bne     @l
@e:     sty     mr
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

; ---------------------------------------------------------------- Einträge: add (5.10), Einpass
; Parameter: g_type (Bits 0-3 Typ, Bit 7 Rand weglassen), g_kind (Art 0-2), dp = Verzeichniseintrag (Wand, Band),
; ex/ey/ew (Wand), g_a/g_b/g_c0/g_c1 (Band: y0, Zeilen, Spalten; Tapete: r0, r1, Spalten).
; Der Eintrag wird sofort geschrieben: VCL-Einträge abwärts ab vp, VMS-Listen aufwärts ab mp. Reicht der Platz
; nicht (vneed/vmsneed springen nach iovf), wird zurückgerollt, im Zählmodus gemessen und nach 5.10 entschieden.
itemadd:
        lda     nitems
        cmp     #MAXITEM
        bne     @g
        lda     g_type          ; leerer Sprite-Eintrag ist kein Eintrag (Referenz: add nur bei v > 0)
        cmp     #IT_SPR
        bne     @full
        jsr     gcnt
        bne     @full
        rts
@full:  lda     #E_TOOMANY
        sta     verr
        jmp     vstop
@g:     lda     vp
        sta     svp
        lda     vp+1
        sta     svp+1
        lda     mp
        sta     smp
        lda     mp+1
        sta     smp+1
        lda     nent
        sta     snent
        tsx
        stx     isp
        lda     #WM_W
        sta     wmode
        jsr     gen
        lda     g_type
        cmp     #IT_SPR
        beq     @spr
        inc     nitems
        rts
@spr:   lda     vp              ; Sprite ohne geschriebenen Eintrag: leer
        cmp     svp
        bne     @acc
        lda     vp+1
        cmp     svp+1
        bne     @acc
        rts
@acc:   inc     nitems
        jmp     objmark
; Platz reicht nicht (Sprung aus vneed/vmsneed, beliebig tief): zurückrollen, zählen, entscheiden (5.10)
iovf:   ldx     isp
        txs
        lda     svp
        sta     vp
        lda     svp+1
        sta     vp+1
        lda     smp
        sta     mp
        lda     smp+1
        sta     mp+1
        lda     snent
        sta     nent
        jsr     gcnt
        bne     @ne
        rts
@ne:    sec                     ; frei = vp - mp = BL - nv - nm
        lda     vp
        sbc     mp
        sta     s1
        lda     vp+1
        sbc     mp+1
        sta     s1+1
        clc                     ; v + m <= frei: annehmen
        lda     iv
        adc     im
        sta     s3
        lda     iv+1
        adc     im+1
        sta     s3+1
        lda     s1
        cmp     s3
        lda     s1+1
        sbc     s3+1
        bcs     @wr
        lda     im              ; Rand im Puffer?
        ora     im+1
        beq     @stop
        lda     iv+1
        bne     @strip
        lda     iv
        cmp     #7
        beq     @drop
        bcc     @stop
@strip: sec                     ; v - 7 <= frei: ohne Rand annehmen
        lda     iv
        sbc     #7
        sta     s3
        lda     iv+1
        sbc     #0
        sta     s3+1
        lda     s1
        cmp     s3
        lda     s1+1
        sbc     s3+1
        bcc     @stop
        lda     g_type
        ora     #IT_STRIP
        sta     g_type
        lda     #1
        sta     vpart
@wr:    lda     #WM_W+WM_X      ; Größe bekannt: ohne Platzprüfung schreiben
        sta     wmode
        jsr     gen
        inc     nitems
        jmp     objmark
@drop:  lda     #1
        sta     vpart
        rts
@stop:  lda     #E_TOOMANY
        sta     verr
        jmp     vstop

; Zählprobe: iv/im = Größe des Eintrags (VCL/VMS); Z = 1: leerer Sprite-Eintrag (nur Sprites können leer sein)
gcnt:   lda     #0
        sta     wmode
        sta     iv
        sta     iv+1
        sta     im
        sta     im+1
        jsr     gen
        lda     iv
        ora     iv+1
        bne     @r
        lda     g_type
        cmp     #IT_SPR
@r:     rts

; angenommener Sprite-Eintrag eines Listenobjekts: OBJVIS-Bit i (auch ohne Rand)
objmark:
        lda     g_type
        and     #$0F
        cmp     #IT_SPR
        bne     @r
        ldx     g_oi
        cpx     #8
        bcs     @h
        lda     bittab,x
        ora     objv
        sta     objv
        rts
@h:     cpx     #16
        bcs     @r
        lda     bittab-8,x
        ora     objv+1
        sta     objv+1
@r:     rts

; vp -= A (Länge eines VCL-Eintrags); vp < mp: zu wenig Platz -> iovf
vneed:  eor     #$FF
        sec
        adc     vp
        sta     vp
        bcs     @n
        dec     vp+1
@n:     lda     vp+1
        cmp     mp+1
        bne     @c
        lda     vp
        cmp     mp
@c:     bcc     @o
        rts
@o:     jmp     iovf

; mp + (s3) <= vp, sonst iovf (Platz für s3 VMS-Bytes)
vmsneed:
        clc
        lda     s3
        adc     mp
        sta     s3
        lda     s3+1
        adc     mp+1
        sta     s3+1
        bcs     @o
        lda     vp
        cmp     s3
        lda     vp+1
        sbc     s3+1
        bcc     @o
        rts
@o:     jmp     iovf

; ---------------------------------------------------------------- Erzeuger (zählen bzw. schreiben)
gen:    lda     g_type
        and     #$0F
        bne     @nw
        jmp     gwall
@nw:    cmp     #IT_BAND
        bne     @bg
        jmp     gband
@bg:    cmp     #IT_SPR
        bne     @g
        jmp     gspr
@g:     jmp     gbg

; SPRITE (5.8, 5.9): Satz orx, Bildeintrag dp (S2), Lage cl_x0/cl_y0, Ausschnitt cl_l ... cl_b, ofull = unbeschnitten.
; Kerne mit clipkerns; Rand unbeschnitten als Bank-1-Verweis (Typ 9; Build VMS_COPY: Kopie in den Puffer, Typ 12),
; sonst mit clipvms_e
gspr:   ldx     orx             ; VRAM-Basis, Inhaltsanfang (fsrc, fn, kc aus gsetx sind hier bedeutungslos)
        jsr     gsetx
        ldy     #5              ; nk, Kerntabelle
        lda     (dp),y
        sta     kc
        iny
        jsr     grl
        jsr     clipkerns
        ldy     #8              ; Quelle = VB + rand_ofs, ZP1 = Liste, g_vlen
        jsr     grand
        lda     g_vlen
        ora     g_vlen+1
        beq     @r
        bit     wmode
        bmi     @w
        lda     ofull           ; 1 = unbeschnitten
        lsr
        bcc     @cc
        lda     #7              ; zählen: Eintrag (Typ 9), mit VMS_COPY auch die Liste
        jsr     addiv
.ifdef VMS_COPY
        lda     g_vlen
        sta     im
        lda     g_vlen+1
        sta     im+1
.endif
@r:     rts
@w:     lda     g_type
        bmi     @r              ; Rand weggelassen
        lda     ofull
        lsr
        bcc     @cc
        lda     cl_y0
        ldx     cl_x0
        jsr     dstxy
.ifdef VMS_COPY
        jmp     vmscopy
.else
        jmp     vms9
.endif
@cc:    jmp     clipvms_e

; gemeinsamer Anfang Wand/Band: VRAM-Basis, Inhaltsanfang; ZP1 = fsrc = Kerne bzw. Füllbytes, kc = nk, fn = h
gsetup: lda     g_kind
        asl
        asl
        asl
        asl
        tax
gsetx:  lda     recs+1,x        ; X = Satz in recs (gspr: S2-Satz)

        sta     gvb
        lda     recs+2,x
        sta     gvb+1
        lda     recs+8,x
        sta     gcont
        lda     recs+9,x
        sta     gcont+1
        ldy     #4
        clc
        lda     (dp),y
        adc     gcont
        sta     ZP1
        sta     fsrc
        iny
        lda     (dp),y
        adc     gcont+1
        sta     ZP1+1
        sta     fsrc+1
        ldy     #2
        lda     (dp),y
        sta     kc
        iny
        lda     (dp),y
        sta     fn
        rts

; Y = Feld rand_ofs des Verzeichniseintrags (DTS 6, S2 8): g_rsrc = VB + rand_ofs, ZP1 = Inhalt + Liste (Y + 4),
; g_vlen = Länge (Y + 6). Einstieg grl: ZP1 = Inhalt + Wort (dp),y; g_vlen = Wort (dp),y+2
grand:  clc
        lda     (dp),y
        adc     gvb
        sta     g_rsrc
        iny
        lda     (dp),y
        adc     gvb+1
        sta     g_rsrc+1
        iny
        iny
        iny
grl:    clc
        lda     (dp),y
        adc     gcont
        sta     ZP1
        iny
        lda     (dp),y
        adc     gcont+1
        sta     ZP1+1
        iny
        lda     (dp),y
        sta     g_vlen
        iny
        lda     (dp),y
        sta     g_vlen+1
        rts

; WALL(e, ent) (5.3): ex, ey, ew = Element
gwall:  jsr     gsetup
        ldy     #0
        lda     (dp),y
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
        jeq     @rand
        bit     wmode
        bmi     @kw
@kl:    ldy     #6              ; zählen
        lda     (ZP1),y
        sta     e_ss
        iny
        lda     (ZP1),y
        sta     e_ss+1
        jsr     emit_vmc
        clc
        lda     ZP1
        adc     #8
        sta     ZP1
        bcc     @kn
        inc     ZP1+1
@kn:    dec     kc
        bne     @kl
        jeq     @rand
; schreiben: Kern (src, dx, dy, w, h, srcstep) direkt als Typ 2/3 (src = VB + src, dst = AP + row[y + dy] + x + dx)
@kw:    ldy     #7
        lda     (ZP1),y
        dey
        ora     (ZP1),y
        bne     @k3
        lda     #11
        jsr     vneed
        ldy     #0
        lda     #2
        sta     (vp),y
        bne     @kc
@k3:    lda     #13
        jsr     vneed
        ldy     #6              ; srcstep
        lda     (ZP1),y
        ldy     #11
        sta     (vp),y
        ldy     #7
        lda     (ZP1),y
        ldy     #12
        sta     (vp),y
        ldy     #0
        lda     #3
        sta     (vp),y
@kc:    clc                     ; src (Y = 0)
        lda     (ZP1),y
        adc     gvb
        iny
        sta     (vp),y
        lda     (ZP1),y
        adc     gvb+1
        iny
        sta     (vp),y
        ldy     #3              ; dst
        lda     (ZP1),y
        clc
        adc     ey
        asl
        tax
        dey
        lda     (ZP1),y
        clc
        adc     ex
        clc
        adc     rows,x
        sta     tlo
        lda     rows+1,x
        adc     #0
        tax
        clc
        lda     tlo
        adc     ap
        ldy     #3
        sta     (vp),y
        txa
        adc     ap+1
        iny
        sta     (vp),y
        lda     (ZP1),y         ; Y = 4: count
        iny
        sta     (vp),y
        ldy     #5              ; reps
        lda     (ZP1),y
        ldy     #7
        sta     (vp),y
        lda     #0
        dey
        sta     (vp),y
        ldy     #8
        sta     (vp),y
        iny
        lda     dvg_stride
        sta     (vp),y
        iny
        lda     dvg_stride+1
        sta     (vp),y
        inc     nent
        bne     @k4
        dec     nent
@k4:    clc
        lda     ZP1
        adc     #8
        sta     ZP1
        bcc     @k5
        inc     ZP1+1
@k5:    dec     kc
        jne     @kw
@rand:  ldy     #0
        lda     (dp),y
        and     #EF_RAND
        beq     @r
        bit     wmode
        bmi     @rw
        lda     #7              ; zählen: VMS-Eintrag (Typ 9), mit VMS_COPY auch die Liste im Puffer
        jsr     addiv
.ifdef VMS_COPY
        ldy     #12
        lda     (dp),y
        sta     im
        iny
        lda     (dp),y
        sta     im+1
.endif
@r:     rts
@rw:    lda     g_type
        bmi     @r              ; Rand weggelassen
        lda     ey
        ldx     ex
        jsr     dstxy
        ; weiter in vmsverb

; Rand unbeschnitten (e_dst gesetzt): VMS-Eintrag mit src = VB + rand_ofs; die Liste wird als Bank-1-Adresse
; eingetragen (Typ 9, 6a) bzw. im Build VMS_COPY in den Puffer kopiert (Typ 12)
vmsverb:
        ldy     #6
.ifndef VMS_COPY
        clc                     ; (Hauptpfad: ohne grand)
        lda     (dp),y
        adc     gvb
        sta     g_rsrc
        iny
        lda     (dp),y
        adc     gvb+1
        sta     g_rsrc+1
        ldy     #10
        clc
        lda     (dp),y
        adc     gcont
        sta     ZP1
        iny
        lda     (dp),y
        adc     gcont+1
        sta     ZP1+1
; ZP1 = Liste (Bank 1), g_rsrc/e_dst gesetzt: Typ 9
vms9:   lda     ZP1
        sta     e_lst
        lda     ZP1+1
        sta     e_lst+1
        lda     #9
        jmp     emit_vms
.else
        jsr     grand
; unbeschnittene Liste kopieren: ZP1 = Liste, g_vlen = Länge, g_rsrc/e_dst gesetzt; Typ 12
vmscopy:
        lda     g_vlen
        sta     s3
        lda     g_vlen+1
        sta     s3+1
        jsr     vmsneed
        lda     mp
        sta     e_lst
        lda     mp+1
        sta     e_lst+1
        ; vcopy: g_vlen Byte von (ZP1) nach (mp), mp += g_vlen
        ldy     #0              ; vierfach entrollt (14 Zyklen je Byte)
        ldx     g_vlen+1
        beq     @r0
@pg:    lda     (ZP1),y
        sta     (mp),y
        iny
        lda     (ZP1),y
        sta     (mp),y
        iny
        lda     (ZP1),y
        sta     (mp),y
        iny
        lda     (ZP1),y
        sta     (mp),y
        iny
        bne     @pg
        inc     ZP1+1
        inc     mp+1
        dex
        bne     @pg
@r0:    lda     g_vlen
        and     #3
        beq     @q
        tax
@b1:    lda     (ZP1),y
        sta     (mp),y
        iny
        dex
        bne     @b1
@q:     lda     g_vlen
        lsr
        lsr
        beq     @e2
        tax
@b4:    lda     (ZP1),y
        sta     (mp),y
        iny
        lda     (ZP1),y
        sta     (mp),y
        iny
        lda     (ZP1),y
        sta     (mp),y
        iny
        lda     (ZP1),y
        sta     (mp),y
        iny
        dex
        bne     @b4
@e2:    clc
        tya
        adc     mp
        sta     mp
        bcc     @e
        inc     mp+1
@e:     lda     #12
        jmp     emit_vms
.endif

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
        bit     wmode
        bmi     @w
        ldy     #0              ; zählen
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
        jsr     emit_vmf
        ldy     fy
        cpy     fn
        bcc     @g
@r:     rts
@w:     ldy     #0              ; schreiben: Gruppe [fr, fy) als Typ 4 (eine Zeile) bzw. 5
@wg:    sty     fr
        tya
        eor     #$FF
        sec
        adc     fn
        tax                     ; X = fn - fr
        lda     (ZP1),y
        sta     e_b
@wn:    iny
        dex
        beq     @we
        cmp     (ZP1),y
        beq     @wn
@we:    sty     fy
        tya
        sec
        sbc     fr
        sta     e_reps
        cmp     #2
        bcs     @w5
        lda     #7
        jsr     vneed
        lda     #4
        bne     @wt
@w5:    lda     #11
        jsr     vneed
        ldy     #7              ; reps, step
        lda     e_reps
        sta     (vp),y
        iny
        lda     #0
        sta     (vp),y
        iny
        lda     dvg_stride
        sta     (vp),y
        iny
        lda     dvg_stride+1
        sta     (vp),y
        lda     #5
@wt:    ldy     #0
        sta     (vp),y
        lda     frow            ; dst = AP + row[frow + fr] + fx
        clc
        adc     fr
        asl
        tax
        lda     fx
        clc
        adc     rows,x
        sta     tlo
        lda     rows+1,x
        adc     #0
        tax
        clc
        lda     tlo
        adc     ap
        iny
        sta     (vp),y
        txa
        adc     ap+1
        iny
        sta     (vp),y
        iny
        lda     e_b
        sta     (vp),y
        iny
        lda     #0
        sta     (vp),y
        iny
        lda     e_cnt
        sta     (vp),y
        iny
        lda     #0
        sta     (vp),y
        inc     nent
        bne     @wx
        dec     nent
@wx:    ldy     fy
        cpy     fn
        jcc     @wg
        rts

; BAND(ent, y0, c0, c1) (5.6): ZEILEN oder Bandbild mit clip_image im Ausschnitt [c0, c1) x [y0, y0 + Zeilen)
gband:  jsr     gsetup
        ldy     #0
        lda     (dp),y
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
        ldy     #0
        lda     (dp),y
        and     #EF_RAND
        beq     @r
        ldy     #12             ; vlen
        lda     (dp),y
        iny
        ora     (dp),y
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
.ifdef VMS_COPY
        ldy     #12
        lda     (dp),y
        sta     im
        iny
        lda     (dp),y
        sta     im+1
.endif
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
@cc:    ldy     #6              ; Quelle = VB + rand_ofs, ZP1 = Liste, g_vlen
        jsr     grand
        lda     #0
        sta     ofull           ; allgemeiner Ausschnitt
        lda     #$FF            ; Bildbreite unbekannt: Lauf rechts beschneiden möglich
        sta     cl_w
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
        lda     bgn             ; e_cnt = n (fillrows hat es nicht verändert: fw)
        sta     e_cnt
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

; VMS-Liste beschneiden (P5b 6.2): ZP1 = Liste, Ausschnitt cl_l/cl_r/cl_t/cl_b (im Bild), cl_w = Bildbreite (R < w: ein
; Lauf kann rechts beschnitten sein; $FF = unbekannt), ofull = 2: nur Zeilen beschnitten (L = 0, R = w).
; Bezugspunkt der Ausgabe (x0 + L, y0 + T). Zählen: iv += 7 und im = 3 + Bytes, falls ein Befehl sichtbar ist;
; schreiben: Liste ab mp und VMS-Eintrag Typ 12 (src = g_rsrc, dst = AP + row[y0 + T] + x0 + L).
; Voraussetzung (Formatregel P5b 4.6): ofs = Zeile * stride + Spalte, Spalte + len <= w <= stride; damit ist Zeile r in
; ofs ausgedrückt sichtbar in [tL, tR) = [r * stride + L, r * stride + R), und ein sichtbarer Befehl mit Spalte >= L
; bekommt ofs' = ofs - cfix, cfix = T * stride + L. Ablauf je Zeile: Befehle mit ofs < tL überspringen (k += Länge),
; Rückblick auf den zuletzt übersprungenen Typ 1 (links beschnittener Lauf), dann die sichtbaren Befehle als Block
; kopieren: op ist so versetzt, dass (op),y die Ausgabestelle zum Eingabeindex y ist; davor bleiben 3 Byte für den
; Typ 3 frei (k > 0), der erst geschrieben wird, wenn der Block nicht leer ist. Ein Befehl mit ofs' >= lim' (= tR - cfix)
; beendet den Block, ein rechts beschnittener Lauf ebenso. Nur Zeilen: ein Block über alle Zeilen (lim' = (B - T) *
; stride, kein Rückblick). Y = laufender Eingabeindex (ab $FC wird ZP1 nachgezogen), X/ccnth = restliche Befehle.
; Zählmodus: der Block schreibt nach CSCR (Bank 0 $0B00-$0BFF, Reserve der Engine, 2.2), die Einzelbefehle nichts.
CSCR     = $0B00
cyl      = zt+4         ; clipvms_e: Index des Längenbytes des zuletzt übersprungenen Typ 1
cq       = zt+5         ; clipvms_e: ofs' lo
ck       = dp           ; clipvms_e: ausstehender Sprung k (dp wird gerettet: iovf erzeugt den Eintrag neu)
clipvms_e:
        bit     wmode
        bpl     @cnt
        bvs     @k              ; Größe bekannt (iovf)
        lda     g_vlen          ; Platz für höchstens 2 * vlen + 4 Byte (je Befehl höchstens ein Typ 3 dazu, dazu
        asl                     ; der zuletzt zur Probe kopierte Befehl)
        sta     s3
        lda     g_vlen+1
        rol
        sta     s3+1
        bcs     @ov
        lda     s3
        adc     #4
        sta     s3
        bcc     @s
        inc     s3+1
        bne     @s
@ov:    jmp     iovf
@k:     lda     im              ; iovf ohne Platzprüfung: Liste leer (Zählprobe) -> nichts; sonst schriebe der Block
        ora     im+1            ; bis zu 9 Byte Abfall hinter mp, wo bei genau passendem Platz schon die VCL-Einträge
        bne     @x              ; der Kerne stehen (mit Liste: höchstens 6 Byte hinter ihrem Ende, dort ist der
        rts                     ; 7-Byte-Eintrag Typ 12 noch frei)
@s:     jsr     vmsneed
@x:     clc                     ; Ausgabe hinter dem Kopf
        lda     mp
        adc     #3
        sta     copos
        lda     mp+1
        adc     #0
        bcc     @p              ; (C = 0: mp + 3 < $10000)
@cnt:   lda     #3              ; zählen: copos = 3 + Bytes
        sta     copos
        lda     #0
@p:     sta     copos+1
        lda     dp
        sta     csdp
        lda     dp+1
        sta     csdp+1
        lda     #0
        sta     ck
        sta     ck+1
        sta     cn
        sta     cn+1
        lda     #$FF
        sta     cyl
        lda     cl_t            ; cfix = T * stride + L, -cfix
        jsr     mulst
        clc
        lda     mr
        adc     cl_l
        sta     ccf
        sta     ctl
        lda     mr+1
        adc     #0
        sta     ccf+1
        sta     ctl+1
        sec
        lda     #0
        sbc     ccf
        sta     cncf
        lda     #0
        sbc     ccf+1
        sta     cncf+1
        lda     ofull
        cmp     #2
        bne     @gen
        sec                     ; nur Zeilen: ein Block, lim' = (B - T) * stride
        lda     cl_b
        sbc     cl_t
        jsr     mulst
        lda     mr
        sta     clim
        lda     mr+1
        sta     clim+1
        lda     #1
        sta     cnr
        lda     #0
        beq     @fl
@gen:   sec                     ; Zeile T: lim' = R - L
        lda     cl_r
        sbc     cl_l
        sta     clim
        sta     cwid
        lda     #0
        sta     clim+1
        sec
        lda     cl_b
        sbc     cl_t
        sta     cnr
        lda     cl_l            ; Bit 7: L > 0 (Rückblick), Bit 6: R < w (Lauf rechts beschneiden)
        cmp     #1
        lda     #0
        ror
        ldx     cl_r
        cpx     cl_w
        beq     @fl
        ora     #$40
@fl:    sta     cflg
        ldy     #0
        lda     (ZP1),y
        sta     calpha
        iny
        lda     (ZP1),y
        tax                     ; X = Anzahl lo
        iny
        lda     (ZP1),y
        cpx     #1              ; ccnth = hi + (lo <> 0): Schleife dex/beq, dec ccnth/bne
        adc     #0
        sta     ccnth
        bne     @y3
        jmp     @end            ; keine Befehle
@y3:    iny
; ---- überspringen: Befehle mit ofs < tL (k += Länge); Y = Befehl
@sk:    lda     (ZP1),y
        lsr                     ; C = 1: Typ 1
        iny
        lda     (ZP1),y
        bcc     @s8
        cmp     ctl
        iny
        lda     (ZP1),y
        sbc     ctl+1
        bcs     @fd             ; ofs >= tL (Y = Befehl + 2)
        iny
        sty     cyl
        lda     (ZP1),y         ; C = 0
        adc     ck
        sta     ck
        bcc     @s1
        inc     ck+1
@s1:    iny
        dex
        beq     @sx
@sc:    cpy     #$FC
        bcc     @sk
        jsr     cnorm
        jmp     @sk
@s8:    cmp     ctl             ; Typ 8
        iny
        lda     (ZP1),y
        sbc     ctl+1
        bcs     @fd
        iny
        inc     ck
        bne     @s2
        inc     ck+1
@s2:    dex
        bne     @sc
@sx:    dec     ccnth
        bne     @sc
        bit     cflg            ; Liste zu Ende: Rückblick auf den letzten Befehl
        bpl     @se
        jsr     cleft
@se:    jmp     @end
; ---- Befehl bei Y - 2 hat ofs >= tL
@fd:    dey
        dey
        bit     cflg
        bpl     @vis
        tya                     ; Rückblick (L > 0): unmittelbar davor ein übersprungener Typ 1? (C = 1)
        sbc     #1
        cmp     cyl
        bne     @vis
        jsr     cleft2
; ---- sichtbare Befehle ab Y als Block
@vis:   sty     cys             ; Block ab Y: Lücke für den Typ 3 bei k > 0, op = Ausgabe + Lücke - Y
        stx     cxs             ; (zählen: CSCR + Lücke - Y)
        ldx     #0
        lda     ck
        ora     ck+1
        beq     @g
        ldx     #3
@g:     stx     cgap
        txa
        bit     wmode
        bpl     @vc
        clc
        adc     copos
        tax
        lda     copos+1
        adc     #0
        bcc     @vb             ; (C = 0)
@vc:    clc
        adc     #<CSCR
        tax
        lda     #>CSCR
@vb:    sta     op+1
        txa
        sec
        sbc     cys
        sta     op
        bcs     @vd
        dec     op+1
@vd:    ldx     cxs
@cp:    lda     (ZP1),y         ; Typ
        sta     (op),y
        lsr
        iny
        lda     (ZP1),y         ; ofs lo
        bcs     @c1
        adc     cncf            ; Typ 8: ofs' = ofs - cfix (C = 0)
        sta     (op),y
        sta     cq
        iny
        lda     (ZP1),y
        adc     cncf+1
        sta     (op),y
        cmp     clim+1          ; ofs' < lim'?
        bcc     @v8
        bne     @ce
        lda     cq
        cmp     clim
        bcs     @ce
@v8:    iny
@cn:    dex
        beq     @cx
@cy:    cpy     #$FC
        bcc     @cp
        jsr     ccommit         ; Y >= $FC: Block abschließen, ZP1 nachziehen, neuer Block
        jsr     cnorm
        jmp     @vis
@cx:    dec     ccnth
        bne     @cy
        jsr     ccommit         ; Liste zu Ende
        jmp     @end
@c1:    sbc     ccf             ; Typ 1 (C = 1)
        sta     (op),y
        sta     cq
        iny
        lda     (ZP1),y
        sbc     ccf+1
        sta     (op),y
        cmp     clim+1
        bcc     @v1
        bne     @ce
        lda     cq
        cmp     clim
        bcs     @ce
@v1:    iny
        lda     (ZP1),y         ; Länge
        sta     (op),y
        bit     cflg
        bvc     @v2
        lda     clim            ; R < w: d = lim' - ofs' (1 ... R - L, ofs' >= Zeilenanfang)
        sec
        sbc     cq
        cmp     (ZP1),y
        bcc     @pr             ; d < len: rechts beschnitten
@v2:    iny
        jmp     @cn
@ce:    dey                     ; Befehl bei Y - 2 nicht sichtbar: Block abschließen, nächste Zeile
        dey
        jsr     ccommit
        jmp     @nr
@pr:    sta     (op),y          ; Länge d; k = len - d nach dem Block; Zeile fertig
        sta     cln
        lda     (ZP1),y
        sec
        sbc     cln
        sta     ckr
        iny
        dex
        bne     @p1
        dec     ccnth
@p1:    jsr     ccommit
        lda     ckr
        sta     ck
        lda     #0
        sta     ck+1
        txa
        bne     @pn
        lda     ccnth
        beq     @end
@pn:    cpy     #$FC            ; Y bis $FF möglich (Lauf ab Y >= $F8): vor @sk nachziehen
        bcc     @nr
        jsr     cnorm
; ---- nächste Zeile: tL += stride, lim' += stride; r >= B: Ende (Rest entfällt)
@nr:    dec     cnr
        beq     @end
        clc
        lda     ctl
        adc     dvg_stride
        sta     ctl
        lda     ctl+1
        adc     dvg_stride+1
        sta     ctl+1
        clc
        lda     clim
        adc     dvg_stride
        sta     clim
        lda     clim+1
        adc     dvg_stride+1
        sta     clim+1
        jmp     @sk
@end:   lda     csdp
        sta     dp
        lda     csdp+1
        sta     dp+1
        lda     cn
        ora     cn+1
        bne     @vs
        rts                     ; nichts sichtbar: keine Liste
@vs:    bit     wmode
        bmi     @wr
        lda     #7
        jsr     addiv
        lda     copos
        sta     im
        lda     copos+1
        sta     im+1
        rts
@wr:    ldy     #0              ; Kopf: Alpha, Anzahl
        lda     calpha
        sta     (mp),y
        iny
        lda     cn
        sta     (mp),y
        iny
        lda     cn+1
        sta     (mp),y
        lda     mp
        sta     e_lst
        lda     mp+1
        sta     e_lst+1
        lda     copos           ; mp = Ende der Liste
        sta     mp
        lda     copos+1
        sta     mp+1
        clc                     ; dst = AP + row[y0 + T] + x0 + L (src = g_rsrc)
        lda     cl_x0
        adc     cl_l
        tax
        clc
        lda     cl_y0
        adc     cl_t
        jsr     dstxy
        lda     #12
        jmp     emit_vms

; Rückblick (L > 0) vor dem Befehl bei Y bzw. am Listenende: war der unmittelbar vorige Befehl ein übersprungener
; Typ 1 (cyl = Index seiner Länge) mit e = ofs + len - tL > 0 (links beschnitten; der Lauf bleibt in seiner Zeile),
; dann k -= e, Typ 3 (k), Typ 1 (ofs' = tL - cfix, n = min(e, R - L)), k = e - n. X, Y bleiben.
cleft:  sec
        tya                     ; Rückblick: unmittelbar davor ein übersprungener Typ 1 (cyl = Index seiner Länge)?
        sbc     #1              ; (C = 1; cyl = $FF: keiner, Y >= 3)
        cmp     cyl
        beq     cleft2
        rts
cleft2: sty     cq
        ldy     cyl             ; e = ofs + len - tL > 0: links beschnitten (der Lauf bleibt in seiner Zeile)
        lda     (ZP1),y
        sta     cln
        dey
        dey
        clc
        adc     (ZP1),y
        sta     cle
        iny
        lda     (ZP1),y
        adc     #0
        tay
        sec
        lda     cle
        sbc     ctl
        sta     cle
        tya
        sbc     ctl+1
        ldy     cq
        bcc     @r            ; e < 0 (e < 256: ofs < tL)
        lda     cle
        beq     @r
        sec                     ; k -= e (k hatte schon len); Typ 3 (k)
        lda     ck
        sbc     cle
        sta     ck
        bcs     @l1
        dec     ck+1
@l1:    jsr     cflush
        lda     cwid            ; n = min(e, R - L), k = e - n; Typ 1 (ofs' = tL - cfix, n)
        cmp     cle
        bcc     @l2
        lda     cle
@l2:    sta     cln
        eor     #$FF
        sec
        adc     cle
        sta     ck
        sec
        lda     ctl
        sbc     ccf
        sta     cot
        lda     ctl+1
        sbc     ccf+1
        sta     cot+1
        lda     #1
        jsr     cputw
        lda     cln
        jmp     cputb
@r:     rts

; Block bis vor Y abschließen: n = Y - cys Byte; n > 0: copos += Lücke + n, cn += Befehle (cxs - X, < 256), Typ 3 (k)
; in die Lücke vor dem Block (zählen: nach CSCR). X, Y bleiben.
ccommit:
        tya
        sec
        sbc     cys
        beq     @r              ; leer: Lücke verfällt
        clc
        adc     cgap
        adc     copos           ; (C = 0: n + Lücke < 256)
        sta     copos
        bcc     @a
        inc     copos+1
@a:     txa
        eor     #$FF
        sec
        adc     cxs
        clc
        adc     cn
        sta     cn
        bcc     @b
        inc     cn+1
@b:     lda     cgap
        beq     @r
        sty     cq
        ldy     cys
        dey
        dey
        dey
        lda     #3
        sta     (op),y
        iny
        lda     ck
        sta     (op),y
        iny
        lda     ck+1
        sta     (op),y
        inc     cn
        bne     @c
        inc     cn+1
@c:     lda     #0
        sta     ck
        sta     ck+1
        ldy     cq
@r:     rts

; Y >= $FC: ZP1 += Y - 4, Y = 4 (der vorige Befehl bleibt für den Rückblick erreichbar); cyl nachziehen bzw. $FF
cnorm:  tya
        sec
        sbc     #4
        sta     cq
        clc
        adc     ZP1
        sta     ZP1
        bcc     @a
        inc     ZP1+1
@a:     sec
        lda     cyl
        sbc     cq
        bcs     @b
        lda     #$FF
@b:     sta     cyl
        ldy     #4
        rts

; k > 0: Typ 3 (k) ausgeben, k = 0. X, Y bleiben.
cflush: lda     ck
        ora     ck+1
        beq     cpr
        lda     ck
        sta     cot
        lda     ck+1
        sta     cot+1
        lda     #0
        sta     ck
        sta     ck+1
        lda     #3
; Befehl A mit Wort cot bei copos ausgeben (zählen: nur copos), cn += 1. X, Y bleiben.
cputw:  sty     cq
        bit     wmode
        bpl     @c
        pha
        lda     copos
        sta     op
        lda     copos+1
        sta     op+1
        pla
        ldy     #0
        sta     (op),y
        iny
        lda     cot
        sta     (op),y
        iny
        lda     cot+1
        sta     (op),y
@c:     inc     cn
        bne     @n
        inc     cn+1
@n:     lda     #3
cadv:   clc                     ; copos += A; Y = cq
        adc     copos
        sta     copos
        bcc     @r
        inc     copos+1
@r:     ldy     cq
cpr:    rts
; Byte A bei copos ausgeben (Länge eines Typ 1). X, Y bleiben.
cputb:  sty     cq
        bit     wmode
        bpl     @c
        pha
        lda     copos
        sta     op
        lda     copos+1
        sta     op+1
        pla
        ldy     #0
        sta     (op),y
@c:     lda     #1
        bne     cadv

; mr = A * stride
mulst:  pha
        lda     dvg_stride
        sta     mw
        lda     dvg_stride+1
        sta     mw+1
        pla
        jmp     mul8

; ---------------------------------------------------------------- VCL-Einträge (6)
; zählen: iv += Länge; schreiben: vp -= Länge (vneed), Eintrag bei vp, nent += 1 (höchstens 255)
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
@w:     ldx     #2              ; Typ 2 (11 Byte) bzw. 3 (13 Byte, srcstep e_ss)
        cmp     #1
        lda     #11
        bcc     @l
        inx
        lda     #13
@l:     jsr     vneed           ; (X bleibt)
        cpx     #3
        bne     @h
        ldy     #11
        lda     e_ss
        sta     (vp),y
        iny
        lda     e_ss+1
        sta     (vp),y
@h:     ldy     #0
        txa
        sta     (vp),y
        iny
        lda     e_src
        sta     (vp),y
        iny
        lda     e_src+1
        sta     (vp),y
        iny
        lda     e_dst
        sta     (vp),y
        iny
        lda     e_dst+1
        sta     (vp),y
; Endstück ab Feld 5 (Y = 4, X = Typ): count, 0; außer bei Typ 4: reps, 0, step = stride
vt5:    iny
        lda     e_cnt
        sta     (vp),y
        iny
        lda     #0
        sta     (vp),y
        cpx     #4
        beq     ent_end
        iny
        lda     e_reps
        sta     (vp),y
        iny
        lda     #0
        sta     (vp),y
        iny
        lda     dvg_stride
        sta     (vp),y
        iny
        lda     dvg_stride+1
        sta     (vp),y
ent_end:
        inc     nent
        bne     @r
        dec     nent
@r:     rts

emit_vmf:
        bit     wmode
        bmi     @w
        lda     e_reps
        cmp     #2
        lda     #7
        bcc     @a
        lda     #11
@a:     jmp     addiv
@w:     ldx     #4              ; Typ 4 (7 Byte) bzw. 5 (11 Byte, reps > 1)
        lda     e_reps
        cmp     #2
        lda     #7
        bcc     @l
        inx
        lda     #11
@l:     jsr     vneed
        ldy     #0
        txa
        sta     (vp),y
        iny
        lda     e_dst
        sta     (vp),y
        iny
        lda     e_dst+1
        sta     (vp),y
        iny
        lda     e_b
        sta     (vp),y
        iny
        lda     #0
        sta     (vp),y
        jmp     vt5

; A = Typ (12: Liste im Puffer, 9: Liste in Bank 1); src = g_rsrc, dst = e_dst, Liste = e_lst
emit_vms:
        bit     wmode
        bmi     @w
        lda     #7
        jmp     addiv
@w:     tax
        lda     #7
        jsr     vneed           ; (X bleibt)
        ldy     #0
        txa
        sta     (vp),y
        iny
        lda     g_rsrc
        sta     (vp),y
        iny
        lda     g_rsrc+1
        sta     (vp),y
        iny
        lda     e_dst
        sta     (vp),y
        iny
        lda     e_dst+1
        sta     (vp),y
        iny
        lda     e_lst
        sta     (vp),y
        iny
        lda     e_lst+1
        sta     (vp),y
        jmp     ent_end

; ---------------------------------------------------------------- Variablen VIEW
        .segment "LIBBSS"
savesp: .res 1
ap:     .res 2
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
nitems: .res 1
verr:   .res 1
vpart:  .res 1
cv_n:   .res 1                  ; Intervalle in cover, bcov (Masken)
bc_n:   .res 1
nent:   .res 1
cd:     .res 1
objv:   .res 2                  ; OBJVIS
vz_end:
cv_s:   .res MAXIV
cv_e:   .res MAXIV
bc_s:   .res MAXIV
bc_e:   .res MAXIV
ia:     .res 1
ib:     .res 1
ii:     .res 1
ij:     .res 1
cbase:  .res 2                  ; Kachelebene + pos + d * F
du:     .res 2                  ; rtab
r_lo:   .res 31                 ; s * R je s + 15
r_hi:   .res 31
rlo:    .res 1                  ; s + 15 in [rlo, rhi): Zelle in der Karte (Seitenachse)
rhi:    .res 1
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
kn:     .res 1
ksi:    .res 1                  ; s + 15
eart:   .res 1
gr_fc:  .res MAXGRP             ; Einordnung Boden/Decke je Zelle der Tiefe ($FF egal/kein Element, $FE Lücke, Stil)
gr_cc:  .res MAXGRP
ecur:   .res 1
pass:   .res 1
tsum:   .res 1
tlo:    .res 1
wdeck:  .res 1
wc0:    .res 1
wc1:    .res 1
; Bänder (Index 1 Boden, 2 Decke)
bk:     .res 1
bkx:    .res 1
by0:    .res 1
brows:  .res 1
bact:   .res 3                  ; Zeilen der Tiefe nicht leer
bnstk:  .res 3                  ; NST, 0 ohne DTS
bsyk:   .res 3                  ; Bandslot
blive:  .res 3
bgap:   .res 3
bmix:   .res 3
bst1:   .res 3
bst0:   .res 3
bst0f:  .res 3
gentl:  .res 3                  ; Bandbild von st0
genth:  .res 3
bstt:   .res 1
bgm:    .res 1
bgi:    .res 1
bkk:    .res 1
bkn:    .res 1
beo:    .res 1
bsi:    .res 1
nr:     .res 1
rr0:    .res 3
rr1:    .res 3
; resolve, Hilfen
rst:    .res 1
rkx:    .res 1
tmp:    .res 1
tmp2:   .res 1
tmp3:   .res 1
mt:     .res 1
mw:     .res 2
ms:     .res 2
mr:     .res 2
; Einträge
svp:    .res 2                  ; Zustand vor dem Eintrag (iovf)
smp:    .res 2
snent:  .res 1
isp:    .res 1
s1:     .res 2
s3:     .res 2
iv:     .res 2
im:     .res 2
; Erzeuger
g_type: .res 1
g_kind: .res 1
g_a:    .res 1
g_b:    .res 1
g_c0:   .res 1
g_c1:   .res 1
gvb:    .res 2
gcont:  .res 2
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
calpha: .res 1                  ; clipvms_e
ccnth:  .res 1
csdp:   .res 2                  ; dp während clipvms_e
cxs:    .res 1                  ; X am Blockanfang
ckr:    .res 1                  ; Rest eines rechts beschnittenen Laufs
cn:     .res 2                  ; ausgegebene Befehle
copos:  .res 2                  ; Ausgabestelle (zählen: 3 + Bytes)
cot:    .res 2
cln:    .res 1
cle:    .res 1
ccf:    .res 2                  ; cfix = T * stride + L
cncf:   .res 2                  ; -cfix
ctl:    .res 2                  ; tL der Zeile
clim:   .res 2                  ; lim' der Zeile
cwid:   .res 1                  ; R - L
cnr:    .res 1                  ; restliche Zeilen
cflg:   .res 1
cys:    .res 1                  ; Blockanfang (Y)
cgap:   .res 1
g_vlen: .res 2                  ; Länge der VMS-Liste (clipvms_e)
g_rsrc: .res 2                  ; VB + rand_ofs
; Objekte (5.8)
obm:    .res 32                 ; Bitfeld: Low-Byte eines Objekt-Zellindex (bleibt bis zum nächsten VIEW)
objd:   .res 1
objon:  .res 1                  ; 0: keine Objekte und Gegenstände möglich; Bit 7: Gegenstände (itemn > 0), sonst 1
nol:    .res 1                  ; sichtbare Objekte der Liste: Zellindex, Index i, Offset 6 i
ol_lo:  .res MAXOBJ
ol_hi:  .res MAXOBJ
ol_i:   .res MAXOBJ
ol_o:   .res MAXOBJ
spbase: .res 1                  ; 5 v
oclo:   .res 1                  ; Zellindex der Zelle
ochi:   .res 1
nc:     .res 1                  ; Anzahl Kandidaten (Tabellen cp ... coi in LIBTAB)
ocp:    .res 1                  ; aktuelles p
ocj:    .res 1                  ; aktueller Kandidat
orx:    .res 1                  ; Satz in recs
oph:    .res 1
obase:  .res 1
ow:     .res 1
oh:     .res 1
ocx0:   .res 1
ocx1:   .res 1
ocy0:   .res 1
ocy1:   .res 1
ofull:  .res 1                  ; 1 = unbeschnitten, 2 = nur Zeilen beschnitten
cl_w:   .res 1                  ; Bildbreite (clipvms_e)
g_oi:   .res 1
        .segment "LIBTAB"       ; Arbeitstabellen von VIEW (INIT löscht sie nicht)
cp:     .res MAXOBJ+1           ; Kandidaten: p, Satz, Richtung, Phase, Objektindex ($FF Gegenstand)
cset:   .res MAXOBJ+1
cdir:   .res MAXOBJ+1
cph:    .res MAXOBJ+1
coi:    .res MAXOBJ+1
        .segment LIBSEG
