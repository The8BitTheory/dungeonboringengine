; dungeonboringengine 0.2 – VIEW (P6d: without objects; P6d-opt: fit pass; P6e: objects), included by lib.s
;
; docs/specs/P6-engine.md section 5 (5.1-5.7, 5.9 bands with border, 5.10, 5.11); the list is byte-identical to
; tools/dbeview.py view(). Flow (P6d-opt):
;   Visibility pass front -> back over the cell table from GEOMSET (vdepth per depth: cells with walls and
;   classification of floor/ceiling, bands, wallpaper, waiting area). Each accepted entry is written immediately
;   (itemadd/gen): VCL entries downward from B1, VMS lists upward from B0; if there is not enough space, it is
;   rolled back (iovf), measured in count mode and decided according to 5.10.
;   Column masks cover/bcov as interval lists. Uncropped VMS lists as VCL type 9 (bank 1); build switch VMS_COPY: copy into the buffer (type 12).
; Zero page: ZP0 = first element of the cell, ZP1 = helper pointer (slot map, cores, lists); block ZPB (lib.s):
; vp, mp, tp, dp, op and kk, kj, eo, wmode, kwi, kwn (clipvms_e: kwi/kwn as cyl/cq, dp saved as k).
; Bank 0 $0B00-$0BFF (engine reserve): scratch output of the count probe of clipvms_e.

.ifdef MAXITEM_T
MAXITEM  = MAXITEM_T    ; test only (run_sim.py: small limit, to check the abort)
.else
MAXITEM  = 96           ; entries per VIEW (7)
.endif
; hot single values in the zero-page block (zt, lib.s)
kk       = zt+0         ; cell (cell table)
kj       = zt+1         ; cell at the depth
eo       = zt+2         ; 16 * slot of the wall in the cell
wmode    = zt+3         ; generator: bit 7 write, bit 6 size known
kwi      = zt+4         ; wall in wl
kwn      = zt+5
MAXGRP   = 31           ; cells per depth (|s| <= S <= 15, checked by GEOMSET)
WM_W     = $80          ; wmode: write
WM_X     = $40          ; wmode: size known (after iovf), no space check for cropped VMS lists
IT_STRIP = $80          ; entry type bit 7: border omitted (5.10)
IT_WALL  = 0            ; wall or tile image: g_kind, ex/ey/ew = element, dp = directory entry
IT_BAND  = 1            ; band image: g_kind, dp, g_a = y0, g_b = rows, g_c0/g_c1 = columns
IT_BG    = 2            ; wallpaper: g_a = r0, g_b = r1, g_c0/g_c1
IT_SPR   = 3            ; sprite (5.8): orx = set in recs, dp = image entry, cl_* = position and clip window, ofull, g_oi
TF_OCCL  = $04          ; tile flags (DMP)
TF_CONT   = $20
EF_OCCL  = $01          ; image flags (DTS)
EF_ROWS  = $04
EF_EDGE  = $08

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
        sec                     ; end byte at B1 - 1; VCL downward before it, VMS upward from B0
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
        bit     buf_fix         ; P6j: fixed list address: at B0 VCL type 10 (jump, address at the end), VMS from B0 + 3
        bpl     @nfix
        lda     #10
        sta     (mp),y
        lda     mp
        clc
        adc     #3
        sta     mp
        bcc     @nfix
        inc     mp+1
@nfix:  lda     #$FF
        sta     sp_n            ; spans invalid
        ; viewing direction: faces, axes, steps
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
        lda     py              ; N/S: fixed axis y, side axis x
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
@odd:   lda     px              ; E/W: fixed axis x, side axis y
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
        lda     recs+16         ; floor/ceiling: NST, if DTS valid (else 0)
        beq     @n1
        lda     recs+16+4
@n1:    sta     bnstk+1
        lda     recs+32
        beq     @n2
        lda     recs+32+4
@n2:    sta     bnstk+2
        lda     vdir            ; wallpaper: o_v mod P (BGSET)
        asl
        tax
        lda     bgomt,x
        sta     bgom
        lda     bgomt+1,x
        sta     bgom+1
        ; object list (5.8): visible objects (bit 6 = 0) of the first min(OBJN, 16) with cell index, index, offset;
        ; obm = bit field of the low bytes of their cell indices (pre-filter per cell; first clear the bits of the previous VIEW)
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
        tya                     ; objon: 0 no objects and items, bit 7 items possible, else 1
        beq     @o1
        lda     #1
@o1:    ldx     itemn
        beq     @o2
        ora     #$80
@o2:    sta     objon
        lda     vdir            ; SUBPOS[v] (P4 2.6): table start 5 v
        asl
        asl
        adc     vdir            ; C = 0
        sta     spbase
; ---- depths 0 ... D
@dl:    jsr     vdepth
        lda     cv_n            ; cover completely occupied: one interval [0, VW)
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

; STOP (5.10): view list full or buffer exceeded; everything accepted so far is already in the buffer
vstop:  ldx     savesp
        txs
; ---------------------------------------------------------------- end (5.11, fit pass)
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
        bit     buf_fix         ; P6j: fixed list address
        bpl     @nf
        jsr     vjump
@nf:    ldx     nent
        ldy     #0
        lda     verr            ; A = 2 before 3
        bne     @a
        lda     vpart
        beq     @a
        lda     #E_PARTIAL
@a:     rts

; P6j (BUFSET X bit 0): complete the jump entry at B0 to the list start vp; VCLADR = P0 = B0;
; VMSLEN without the 3 bytes of the jump (VMS lists from B0 + 3)
vjump:  lda     buf_b0
        sta     op
        sta     VCLADR
        sta     P0
        lda     buf_b0+1
        sta     op+1
        sta     VCLADR+1
        sta     P0+1
        ldy     #1
        lda     vp
        sta     (op),y
        iny
        lda     vp+1
        sta     (op),y
        lda     VMSLEN
        sec
        sbc     #3
        sta     VMSLEN
        bcs     @r
        dec     VMSLEN+1
@r:     rts

fnegtab: .byte  1, 0, 0, 1      ; F points to -y (N) or -x (W)
anegtab: .byte  0, 0, 1, 1      ; R points to -x (S) or -y (W)

; BGSET: bgomt[2 v] = o_v mod P for all four directions (16 bit, remainder of the division; P >= 1 checked)
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

; cell offset per s (index s + 15, |s| <= S): r_lo/r_hi = s * R (16 bit), r_ok = side coordinate within the map
rtab:   lda     #1              ; du = +-1 or +-W (in the direction of s)
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
@ok:    lda     aneg            ; valid s + 15 in [rlo, rhi): 0 <= a0 +- s < alim
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
@sub:   ldy     #0              ; (A - a0) as 16 bit, clamped to 0 ... 31
@sub1:  sec
        sbc     a0
        tax
        tya
        sbc     #0
        jmp     @clamp
@sub2:  ldy     #0              ; A = 15 + alim (carry in C)
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

; ---------------------------------------------------------------- one depth (5.2)
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
        sta     gap+1
        sta     gap+2
        sta     npend
        ldx     #1              ; dout: fixed coordinate outside the map
        lda     fc+1
        bne     @o
        lda     fc
        cmp     flim
        bcs     @o
        dex
@o:     stx     dout
        clc                     ; cbase = tile plane + pos + d * F
        lda     map_cells
        adc     idxd
        sta     cbase
        lda     map_cells+1
        adc     idxd+1
        sta     cbase+1
        ldx     #2              ; bands of the depth: active (rows not empty), NST (0 without DTS), band slot
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
@bc:    sec                     ; band slot: floor NE + D + 1 + d, ceiling NE + d
        lda     cd
        adc     dvg_d
        sta     bsyk+1
        lda     cd
        sta     bsyk+2
        cmp     dvg_d           ; distant view (5.7a): decisions of the cells of depth D (vcells)
        bne     @nf
        lda     ffon
        sta     fon
@nf:    jsr     vcells
        jsr     vauto
        lda     #1
        jsr     vband           ; floor
        lda     #2
        jsr     vband           ; ceiling
        jsr     vtap
        ldx     #0              ; enter waiting area
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
; distant view (5.7a): horizon band of depth D after the waiting area (bcov thus covers everything that occludes it);
; per sequence from right to left, runs of the same decision (hs, fdec) from right to left: fill byte or wallpaper
@pe:    lda     fany
        beq     @x
        lda     dvg_y0
        cmp     dvg_y1
        bcs     @x
        sta     g_a
        lda     dvg_y1
        sta     g_b
        jsr     spans
        ldx     sp_n
@sl:    dex
        bmi     @x
        stx     bsi
        lda     sp_c0,x
        sta     fc0
        ldy     sp_c1,x
@run:   sty     g_c1            ; run [g_c0, g_c1) with the decision of column g_c1 - 1
        ldx     hs-1,y
        lda     fdec,x
        sta     bgsel
@cl:    dey
        cpy     fc0
        beq     @em
        ldx     hs-1,y          ; decision of column Y - 1
        lda     fdec,x
        cmp     bgsel
        beq     @cl
@em:    sty     g_c0
        lda     #IT_BG
        sta     g_type
        jsr     itemadd
        ldy     g_c0
        cpy     fc0
        bne     @run
        ldx     bsi
        bpl     @sl
@x:     rts

; ---------------------------------------------------------------- cells of a depth (cell table from GEOMSET)
; per cell: tile (tp), floor/ceiling/blocked for vband (gr_*), walls in DVG order or, with CONTENT, with faces
; fronts first, then the sides (5.2a; object slots: P6e)
vcells: ldx     cd
        lda     d_kn,x
        bne     @go
        rts
@go:    sta     kn
        lda     #0              ; objd: objects possible at this depth (d >= 1)
        cpx     #0
        beq     @od
        lda     objon
@od:    sta     objd
        lda     d_k0,x
        sta     kk
        lda     #0
        sta     kj
        beq     @cell
@out:   ldy     map_out         ; cell outside the map: outer tile
        jmp     @t
@cell:  ldx     kk
        lda     k_elo,x         ; ZP0 = first element of the cell
        sta     ZP0
        lda     k_ehi,x
        sta     ZP0+1
        jsr     cellptr         ; ZP1 = tile of the cell, C = 1: outside
        bcs     @out
        ldy     #0
        lda     (ZP1),y
        tay
@t:     lda     tpl,y           ; tp, tsum (bit 7 faces, bit 6 blocked, tile flags)
        sta     tp
        lda     tph,y
        sta     tp+1
        lda     tsm,y
        sta     tsum
        lda     fon             ; distant view (5.7a): ceiling style <> 0 -> fill, flag DISTANT (bit 6) inverts
        beq     @nfd
        ldy     #5
        lda     (tp),y
        beq     @fz
        lda     #$40
@fz:    ldy     #6
        eor     (tp),y
        and     #$40
        ldy     ksi
        sta     fdec,y
        ora     fany
        sta     fany
@nfd:   ldy     kj              ; classify floor/ceiling (5.6 step 1): $FF don't care/no element, $FE gap, else style
        lda     #$FF
        sta     gr_fc,y
        sta     gr_cc,y
        bit     tsum            ; blocked: don't care
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
@cls:   bit     tsum            ; faces: walls; no faces: objects (5.2)
        bpl     @obj
        lda     tsum            ; pass 0: all walls in DVG order; CONTENT (5.2a): pass 1 fronts,
        and     #TF_CONT         ; objects, pass 2 sides
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
@pe:    lda     pass            ; after pass 1: objects, pass 2
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
@obj:   lda     objd            ; objects or items possible (and d >= 1)
        beq     @nx
        bmi     @oc             ; items possible: check every cell
        ldy     ksi             ; else cell marker: low byte of the cell index in obm (cells outside the map
        clc                     ; are discarded by vobjc)
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

; cell kk of the depth: ksi = s + 15; ZP1 = cellp = cell = cbase + s * R in the tile plane, C = 1 outside the map
; (cellp + 1 = 0)
cellptr:
        ldx     kk
        ldy     k_si,x
        sty     ksi
        lda     dout
        bne     @o
        cpy     rlo
        bcc     @o
        cpy     rhi
        bcs     @o
        lda     cbase           ; C = 0
        adc     r_lo,y
        sta     ZP1
        sta     cellp
        lda     cbase+1
        adc     r_hi,y
        sta     ZP1+1
        sta     cellp+1
        clc                     ; (negative steps produce a carry)
        rts
@o:     lda     #0
        sta     cellp+1
        sec
        rts

; automap (P6f): set bit 6 of the content plane of the cell cellp (only with map_auto, not outside the map)
mark_seen:
        lda     map_auto
        beq     @r
        lda     cellp+1
        beq     @r
        clc
        lda     cellp
        adc     map_wh
        sta     ZP1
        lda     cellp+1
        adc     map_wh+1
        sta     ZP1+1
        ldy     #0
        lda     (ZP1),y
        ora     #$40
        sta     (ZP1),y
@r:     rts

; automap floor: per cell of the depth with a floor element (gr_fc <> $FF: not blocked, floor rows visible) within the
; map and an element not completely occluded (bcov, before vband), mark as seen
vauto:  lda     map_auto
        beq     @r
        ldx     cd
        lda     d_kn,x
        sta     kn
        lda     d_k0,x
        sta     kk
        lda     #0
        sta     kj
@l:     ldy     kj
        lda     gr_fc,y
        cmp     #$FF
        beq     @n
        jsr     cellptr
        bcs     @n
        ldx     kk
        lda     k_elo,x
        sta     ZP0
        lda     k_ehi,x
        sta     ZP0+1
        lda     k_fl,x          ; slot of the floor element (16 * slot): x at +4, w at +6
        ora     #4
        tay
        lda     (ZP0),y
        tax
        iny
        iny
        clc
        adc     (ZP0),y
        jsr     allcov_b
        bcs     @n
        jsr     mark_seen
@n:     inc     kk
        inc     kj
        dec     kn
        bne     @l
@r:     rts

; wall eo of the cell (ZP0, tp, ksi) in the visibility pass: allcov before resolve
vwall:  ldy     eo
        lda     (ZP0),y         ; kind 0 front, 1 side
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
@side:  lda     ksi             ; s < 0 (ksi < 15): left
        cmp     #15
        lda     facel
        bcc     @f
        lda     facer
@f:     tay
        lda     (tp),y          ; n = walls[face]
        pha
        lda     recs+10         ; slot map wall
        sta     ZP1
        lda     recs+11
        sta     ZP1+1
        lda     eo              ; slot = first element index of the cell + slot
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
        ldy     eo              ; ex, ey, ew = element
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
        ldy     #0              ; occl(e, t, ent)
        lda     (dp),y
        and     #EF_OCCL
        beq     @nd
        lda     tsum
        and     #TF_OCCL
        beq     @nd
        lda     eo
        ora     #3
        tay
        lda     (ZP0),y
        and     #1
@nd:    sta     wocc
        jsr     mark_seen
        jsr     itemadd         ; STOP possible; even a discarded entry (border only) occludes afterwards (reference)
        lda     wocc
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
        bne     @ps             ; side: waiting area, both masks
        ldx     wc0             ; front: cover immediately
        lda     wc1
        jsr     mark_c
        lda     eo
        ora     #3
        tay
        lda     (ZP0),y
        and     #8
        beq     @pb
        ldx     wc0             ; DVG bit 3: bcov immediately
        lda     wc1
        jmp     mark_b
@r:     rts
@pb:    lda     #0
        beq     @pa
@ps:    lda     #1
@pa:    ldx     npend           ; GEOMSET guarantees npend < MAXPEND
        sta     pd_both,x
        lda     wc0
        sta     pd_c0,x
        lda     wc1
        sta     pd_c1,x
        inc     npend
        rts

passart: .byte  0, 1            ; pass 1 fronts, 2 sides (5.2a)

;---------------------------------------------------------------- objects (5.8)
; objects of the cell kk (ZP0 = first element, ksi): candidates (item of the content plane, objects of the list),
; then one sprite entry per object slot of the cell in reverse paint order (p = 4 ... 0, for equal p objects with
; descending i, the item last). Only d >= 1 and cells within the map.
vobjc:  ldx     kk              ; (vcells: only with objd, i.e. d >= 1 and objects/items possible)
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
        clc                     ; item g = content(c) AND 63 with itemtab[g] <> 0: p = 2, direction $FF, ITEMPH
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
@ob:    lda     oclo            ; pre-filter: low byte in bit field obm?
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
        ldx     #0              ; objects of the list in i order
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
@el:    ldy     eo              ; object slots of the cell (DVG order)
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
        jsr     vspr            ; STOP possible
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

; candidate ocj at slot ocp of the object slot eo (5.8 steps 3-6)
vspr:   lda     cset,x
        cmp     #8
        bcs     @r0
        asl
        asl
        asl
        asl
        adc     #48             ; C = 0: set in recs
        tay
        lda     recs,y
        beq     @r0
        sty     orx
        lda     cdir,x          ; a = 0 for $FF, else (2 + v - o) AND 3
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
        lda     recs+8,x        ; ai = angle_map[a] (header 12-15)
        sta     ZP1
        lda     recs+9,x
        sta     ZP1+1
        tya
        clc
        adc     #12
        tay
        lda     (ZP1),y
        tay
        lda     cd              ; index ai * D + d - 1
        sec
        sbc     #1
@m:     dey
        bmi     @md
        clc
        adc     dvg_d
        bcc     @m
@r0:    rts
@md:    sta     obase
        lda     recs+10,x       ; index table
        sta     ZP1
        lda     recs+11,x
        sta     ZP1+1
        ldy     oph             ; + f * NA * D (f < NP <= 32, usually small: addition instead of mul8)
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
        ldx     orx             ; $FF: phase 0
        lda     recs+10,x
        sta     ZP1
        lda     recs+11,x
        sta     ZP1+1
@f0:    ldy     obase
        lda     (ZP1),y
@b:     cmp     #$FE
        bcs     @r0
        ldx     orx             ; dp = directory + 16 b
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
        lda     ocp             ; anchor p: column (signed), row
        asl
        adc     eo              ; C = 0
        adc     #4
        tay
        ldx     #0
        lda     (ZP0),y
        bpl     @ax
        dex
@ax:    stx     tmp
        sec                     ; x0 = ax - fx (16 bit)
        ldy     #3
        sbc     (dp),y
        sta     cl_x0
        lda     tmp
        sbc     #0
        sta     cl_x0+1
        bmi     @x0n            ; cx0 = max(x0, 0)
        lda     cl_x0
        bcs     @x0             ; C = 1 (no borrow)
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
        lda     ocp             ; y0 = ay - fy (16 bit)
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
        ldx     ocx0            ; all columns occupied in cover -> discard; otherwise complete, only clipped
        lda     ocx1            ; at the window (P6i: occlusion via the paint order)
        jsr     allcov_c        ; X stays cx0
        bcc     @vis
@rr:    rts
@vis:   lda     ocx1            ; window in the image: L, R, T, B
        sec
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
        ldx     #0              ; ofull: 1 uncropped (L = 0, R = w, T = 0, B = h), 2 rows only (L = 0, R = w)
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

subpos: .byte   0, 1, 3, 4, 2,  3, 0, 4, 1, 2,  4, 3, 1, 0, 2,  1, 4, 0, 3, 2   ; SUBPOS[v][q] (P4 2.6)

; ---------------------------------------------------------------- bands and tiles (5.6)
; classification in the cell pass (5.6 step 1): X = kind (1 floor, 2 ceiling), A = n; returns A = $FE gap or style.
; Maintains per kind and depth live/gap/mix, st1 (first style) and st0 (first style with a resolvable band image, only
; if there is no relevant gap; bst0f = last style tried without success); gent[kind] = band image of st0.
bclass: cmp     #1
        jcc     @gap            ; n = 0
        sbc     #1
        cmp     bnstk,x         ; st >= NST (or DTS missing: NST = 0)
        bcs     @gap
        sta     bstt
        lda     #1
        sta     blive,x
        lda     bst1,x
        cmp     #$FF
        bne     @s1
        lda     bstt
        sta     bst1,x
        bcs     @s3             ; C = 1 after cmp #$FF
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
        txa                     ; ZP1 = slot map of the kind + NE (band slots)
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

; bands of the depth, A = 1 floor, 2 ceiling (5.6 steps 2-5): decision from bclass, tiles, ground
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
        sta     bkx             ; set in recs
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
        lda     #1              ; gap: ground = wallpaper, tiles for all styles
        sta     gap,x
        bne     @tiles
@ng:    lda     bst0,x
        cmp     #$FF
        beq     @tiles          ; no resolvable band image: tiles for all, no ground
        inc     bgm             ; ground = band(st0)
        lda     bmix,x
        jeq     @grnd           ; one style: no tiles
@tiles: ldx     cd              ; tiles in DVG order (= cell order)
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
        lda     k_elo,x         ; ZP0 = first element of the cell, beo = slot of the floor/ceiling element
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
        ldy     beo             ; allcov(bcov, x, x + w) before resolve; ex, ey, ew
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
        jsr     spans           ; sequences from right to left
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

; ---------------------------------------------------------------- wallpaper (5.7)
vtap:   lda     #0
        sta     nr
        lda     gap+2
        beq     @t1
        lda     dcy0
        ldx     dcy1
        jsr     addrng
@t1:    lda     cd
        cmp     dvg_d
        bne     @t2
        lda     fany            ; distant view: horizon only after the waiting area (vdepth)
        bne     @t2
        lda     dvg_y0
        ldx     dvg_y1
        jsr     addrng
@t2:    lda     gap+1
        beq     @t3
        lda     dfy0
        ldx     dfy1
        jsr     addrng
@t3:    lda     nr
        beq     @r
        jsr     spans
@rl:    dec     nr              ; ranges from bottom to top
        bmi     @r
        ldx     sp_n
@sl:    dex                     ; sequences from right to left
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

; append row range [A, X), omit empty ones, merge with the previous one if adjacent
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

; ---------------------------------------------------------------- masks
; cover and bcov as sorted lists of occupied column intervals [S, E) (disjoint, touching ones merged),
; at most MAXIV; VIEW starts with empty lists. Cost per call proportional to the number of intervals.
MAXIV    = 41

; allcov: X = c0, A = c1 (exclusive): C = 1 if all columns are occupied (also for c0 >= c1)
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
        cmp     PE,y             ; c0 < E[y]: interval found
        bcc     ivf
        iny
        bne     ivl
ivf:      cmp     PS,y             ; c0 >= S[y] and E[y] >= c1
        bcc     ivno
        lda     PE,y
        cmp     ib
        rts
ivno:     clc
ivyes:    rts
.endmacro

; mark: X = c0, A = c1 (exclusive) occupy
.macro IV_MARK PS, PE, PN
        .local ivf1, ivg, ivms, ivmj, ivme, ivme2, ivcp, ivcd, ivins, ivsh, ivput, ivr
        sta     ib
        cpx     ib
        bcs     ivr
        stx     ia
        ldy     #0
ivf1:     cpy     PN               ; i = first interval with E >= c0
        bcs     ivins
        lda     PE,y
        cmp     ia
        bcs     ivg
        iny
        bne     ivf1
ivg:      lda     ib              ; S[i] > c1: new interval before i
        cmp     PS,y
        bcc     ivins
        lda     ia              ; S[i] = min(S[i], c0)
        cmp     PS,y
        bcs     ivms
        sta     PS,y
ivms:     tya                     ; j = last interval with S <= c1
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
        iny                     ; remove i+1 ... j
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
ivins:    sty     ii              ; insert [c0, c1) at i
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
        sty     sp_n            ; recompute spans
        IV_MARK bc_s, bc_e, bc_n

; spans(bcov) to sp_c0/sp_c1, sp_n sequences (> 4 -> one sequence from the first to the last free column)
spans:  lda     sp_n
        bpl     @ok
        lda     #0
        sta     ia              ; end of the previous interval
        tax                     ; number of sequences
        tay
@l:     cpy     bc_n
        bcs     @la
        lda     bc_s,y
        cmp     ia
        beq     @nx
        jsr     @add            ; sequence [ia, S[y])
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
@add:   sta     ib              ; last sequence ends at ib
        cpx     #5
        bcs     @a1
        sta     sp_c1,x
        lda     ia
        sta     sp_c0,x
@a1:    inx
        rts

; ---------------------------------------------------------------- helpers
; resolve (5.1): A = n, X = set (kind * 16), Y = slot index, ZP1 = slot map (or + NE).
; C = 0: dp = directory entry; C = 1: no image (dp unchanged). Destroys A, X, Y, ZP1.
resolve:
        cmp     #1
        bcc     @no             ; n = 0
        sbc     #1
        cmp     recs+4,x        ; st >= NST
        bcs     @no
        sta     rst
        lda     recs,x
        beq     @no             ; DTS missing
        lda     (ZP1),y         ; k
        cmp     #$FF
        beq     @no
        tay
        stx     rkx
        txa
        asl
        ora     rst
        tax
        lda     sty_lo,x        ; style row (TEXSET)
        sta     ZP1
        lda     sty_hi,x
        sta     ZP1+1
        lda     (ZP1),y
        cmp     #$FF
        bne     @b
        lda     rkx             ; fall back to style 0
        asl
        tax
        lda     sty_lo,x
        sta     ZP1
        lda     sty_hi,x
        sta     ZP1+1
        lda     (ZP1),y
@b:     cmp     #$FE
        bcs     @no
        ldx     rkx             ; dp = directory + 16 * b
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

; mr = A * mw (8 x 16 bit); destroys X, Y
mul8:   tax                     ; X = remainder of the multiplier, Y = result lo
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

; ---------------------------------------------------------------- entries: add (5.10), fit pass
; Parameters: g_type (bits 0-3 type, bit 7 omit border), g_kind (kind 0-2), dp = directory entry (wall, band),
; ex/ey/ew (wall), g_a/g_b/g_c0/g_c1 (band: y0, rows, columns; wallpaper: r0, r1, columns).
; The entry is written immediately: VCL entries downward from vp, VMS lists upward from mp. If there is not
; enough space (vneed/vmsneed jump to iovf), it is rolled back, measured in count mode and decided according to 5.10.
itemadd:
        lda     nitems
        cmp     #MAXITEM
        bne     @g
        lda     g_type          ; empty sprite entry is not an entry (reference: add only for v > 0)
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
@spr:   lda     vp              ; sprite without a written entry: empty
        cmp     svp
        bne     @acc
        lda     vp+1
        cmp     svp+1
        bne     @acc
        rts
@acc:   inc     nitems
        jmp     objmark
; not enough space (jump from vneed/vmsneed, arbitrarily deep): roll back, count, decide (5.10)
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
@ne:    sec                     ; free = vp - mp = BL - nv - nm
        lda     vp
        sbc     mp
        sta     s1
        lda     vp+1
        sbc     mp+1
        sta     s1+1
        clc                     ; v + m <= free: accept
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
        lda     im              ; border in the buffer?
        ora     im+1
        beq     @stop
        lda     iv+1
        bne     @strip
        lda     iv
        cmp     #7
        beq     @drop
        bcc     @stop
@strip: sec                     ; v - 7 <= free: accept without border
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
@wr:    lda     #WM_W+WM_X      ; size known: write without space check
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

; count probe: iv/im = size of the entry (VCL/VMS); Z = 1: empty sprite entry (only sprites can be empty)
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

; accepted sprite entry of a list object: OBJVIS bit i (even without border)
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

; vp -= A (length of a VCL entry); vp < mp: not enough space -> iovf
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

; mp + (s3) <= vp, else iovf (space for s3 VMS bytes)
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

; ---------------------------------------------------------------- generators (count or write)
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

; SPRITE (5.8, 5.9): set orx, image entry dp (S2), position cl_x0/cl_y0, window cl_l ... cl_b, ofull = uncropped.
; Cores with clipcores; border uncropped as bank 1 reference (type 9; build VMS_COPY: copy into the buffer, type 12),
; otherwise with clipvms_e
gspr:   ldx     orx             ; VRAM base, content start (fsrc, fn, kc from gsetx are meaningless here)
        jsr     gsetx
        ldy     #5              ; nk, core table
        lda     (dp),y
        sta     kc
        iny
        jsr     grl
        jsr     clipcores
        ldy     #8              ; source = VB + edge_ofs, ZP1 = list, g_vlen
        jsr     grand
        lda     g_vlen
        ora     g_vlen+1
        beq     @r
        bit     wmode
        bmi     @w
        lda     ofull           ; 1 = uncropped
        lsr
        bcc     @cc
        lda     #7              ; count: entry (type 9), with VMS_COPY also the list
        jsr     addiv
.ifdef VMS_COPY
        lda     g_vlen
        sta     im
        lda     g_vlen+1
        sta     im+1
.endif
@r:     rts
@w:     lda     g_type
        bmi     @r              ; border omitted
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

; common start of wall/band: VRAM base, content start; ZP1 = fsrc = cores or fill bytes, kc = nk, fn = h
gsetup: lda     g_kind
        asl
        asl
        asl
        asl
        tax
gsetx:  lda     recs+1,x        ; X = set in recs (gspr: S2 set)

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

; Y = field edge_ofs of the directory entry (DTS 6, S2 8): g_rsrc = VB + edge_ofs, ZP1 = content + list (Y + 4),
; g_vlen = length (Y + 6). Entry grl: ZP1 = content + word (dp),y; g_vlen = word (dp),y+2
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

; WALL(e, ent) (5.3): ex, ey, ew = element
gwall:  jsr     gsetup
        ldy     #0
        lda     (dp),y
        and     #EF_ROWS
        beq     @core
        lda     ey              ; ROWS: fill bytes per row
        sta     frow
        lda     ex
        sta     fx
        lda     ew
        sta     fw
        jmp     fillrows
@core:  lda     kc
        jeq     @edge
        bit     wmode
        bmi     @kw
@kl:    ldy     #4              ; count: e_cnt = w (srcstep = w is type 2)
        lda     (ZP1),y
        sta     e_cnt
        ldy     #6
        lda     (ZP1),y
        sta     e_ss
        iny
        lda     (ZP1),y
        sta     e_ss+1
        jsr     emit_vmcn
        clc
        lda     ZP1
        adc     #8
        sta     ZP1
        bcc     @kn
        inc     ZP1+1
@kn:    dec     kc
        bne     @kl
        jeq     @edge
; write: core (src, dx, dy, w, h, srcstep) directly as type 2/3 (src = VB + src, dst = AP + row[y + dy] + x + dx)
@kw:    ldy     #7
        lda     (ZP1),y
        bne     @k3             ; srcstep >= 256: type 3
        dey
        lda     (ZP1),y
        beq     @k2             ; srcstep 0: type 2
        ldy     #4
        cmp     (ZP1),y
        bne     @k3             ; srcstep = w (e_cnt) is also type 2
@k2:    lda     #11
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
@edge:  ldy     #0
        lda     (dp),y
        and     #EF_EDGE
        beq     @r
        bit     wmode
        bmi     @rw
        lda     #7              ; count: VMS entry (type 9), with VMS_COPY also the list in the buffer
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
        bmi     @r              ; border omitted
        lda     ey
        ldx     ex
        jsr     dstxy
        ; continue in vmsverb

; border uncropped (e_dst set): VMS entry with src = VB + edge_ofs; the list is entered as a bank 1 address
; (type 9, 6a) or, in the VMS_COPY build, copied into the buffer (type 12)
vmsverb:
        ldy     #6
.ifndef VMS_COPY
        clc                     ; (main path: without grand)
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
; ZP1 = list (bank 1), g_rsrc/e_dst set: type 9
vms9:   lda     ZP1
        sta     e_lst
        lda     ZP1+1
        sta     e_lst+1
        lda     #9
        jmp     emit_vms
.else
        jsr     grand
; copy uncropped list: ZP1 = list, g_vlen = length, g_rsrc/e_dst set; type 12
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
        ; vcopy: g_vlen bytes from (ZP1) to (mp), mp += g_vlen
        ldy     #0              ; unrolled four times (14 cycles per byte)
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

; fill rows: fn bytes from fsrc (row frow ...), column fx, width fw; identical bytes grouped (type 4/5)
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
        ldy     #0              ; count
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
@w:     ldy     #0              ; write: group [fr, fy) as type 4 (one row) or 5
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

; BAND(ent, y0, c0, c1) (5.6): ROWS or band image with clip_image in the window [c0, c1) x [y0, y0 + rows)
gband:  jsr     gsetup
        ldy     #0
        lda     (dp),y
        and     #EF_ROWS
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
        jsr     clipcores
        ldy     #0
        lda     (dp),y
        and     #EF_EDGE
        beq     @r
        ldy     #12             ; vlen
        lda     (dp),y
        iny
        ora     (dp),y
        beq     @r
        lda     g_c0            ; full width: uncropped
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
@cc:    ldy     #6              ; source = VB + edge_ofs, ZP1 = list, g_vlen
        jsr     grand
        lda     #0
        sta     ofull           ; general window
        lda     #$FF            ; image width unknown: run may be cropped on the right
        sta     cl_w
        jmp     clipvms_e

; BG(r0, r1, c0, c1) (5.7)
gbg:    sec
        lda     g_c1
        sbc     g_c0
        sta     e_cnt
        sta     bgn
        lda     bgsel           ; distant-view fill (5.7a): type 4/5 with the fill byte
        beq     @t
        lda     ffill
        bcs     @fb             ; C = 1 (c1 > c0)
@t:     lda     dbg_ok
        bne     @dbg
        lda     bgfill          ; without DBG: one type 4/5
@fb:    sta     e_b
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
        ; rows above the panorama [r0, min(r1, y0))
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
        lda     bgn             ; e_cnt = n (fillrows has not changed it: fw)
        sta     e_cnt
        bit     wmode
        bmi     @pw
        jsr     emit_vmc        ; count: one or two type 3
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
        jsr     bgq             ; C = 1: two parts, e_cnt = n1
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
        clc                     ; part 2: from source column 0 to destination column c0 + n1
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
@low:   ; rows below the panorama [max(r0, y0 + h), r1)
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

; fill rows of the DBG [g_a, A) (empty if A <= g_a)
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

; q = (o_v + c0) mod P -> bgqv; C = 1 if q + n > P (then e_cnt = n1 = P - q), else e_cnt = n
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
; cores: ZP1 = core table, kc = count; image position cl_x0/cl_y0 (16 bit), window relative to the image
; [cl_l, cl_r) x [cl_t, cl_b). One type 2/3 per visible core (count or write).
clipcores:
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
        lda     kss             ; st = srcstep or w
        sta     kst
        lda     kss+1
        sta     kst+1
        ora     kss
        bne     @st
        lda     kw
        sta     kst
@st:    lda     kss             ; full width: srcstep stays, otherwise st
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
@f:     sec                     ; e_cnt = count (ckwrite sets it again)
        lda     kb
        sbc     ka
        sta     e_cnt
        bit     wmode
        bpl     @em
        jsr     ckwrite
@em:    jsr     emit_vmcn
@nx:    clc
        lda     ZP1
        adc     #8
        sta     ZP1
        bcc     @n1
        inc     ZP1+1
@n1:    dec     kc
        jne     @k
        rts

; write values of a cropped core: src = VB + src + (c - dy) * st + (a - dx), dst = AP + row[y0 + c] + x0 + a
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

; crop VMS list (P5b 6.2): ZP1 = list, window cl_l/cl_r/cl_t/cl_b (in the image), cl_w = image width (R < w: a
; run may be cropped on the right; $FF = unknown), ofull = 2: only rows cropped (L = 0, R = w).
; Reference point of the output (x0 + L, y0 + T). Count: iv += 7 and im = 3 + bytes, if a command is visible;
; write: list from mp and VMS entry type 12 (src = g_rsrc, dst = AP + row[y0 + T] + x0 + L).
; Precondition (format rule P5b 4.6): ofs = row * stride + column, column + len <= w <= stride; thus row r expressed
; in ofs is visible in [tL, tR) = [r * stride + L, r * stride + R), and a visible command with column >= L
; gets ofs' = ofs - cfix, cfix = T * stride + L. Flow per row: skip commands with ofs < tL (k += length),
; look back at the last skipped type 1 (run cropped on the left), then copy the visible commands as a block:
; op is offset so that (op),y is the output location for input index y; 3 bytes stay free before it for the
; type 3 (k > 0), which is written only if the block is not empty. A command with ofs' >= lim' (= tR - cfix)
; ends the block, as does a run cropped on the right. Rows only: one block over all rows (lim' = (B - T) *
; stride, no look-back). Y = current input index (from $FC on ZP1 is advanced), X/ccnth = remaining commands.
; Count mode: the block writes to CSCR (bank 0 $0B00-$0BFF, engine reserve, 2.2), the single commands write nothing.
CSCR     = $0B00
cyl      = zt+4         ; clipvms_e: index of the length byte of the last skipped type 1
cq       = zt+5         ; clipvms_e: ofs' lo
ck       = dp           ; clipvms_e: pending jump k (dp is saved: iovf regenerates the entry)
clipvms_e:
        bit     wmode
        bpl     @cnt
        bvs     @k              ; size known (iovf)
        lda     g_vlen          ; space for at most 2 * vlen + 4 bytes (at most one additional type 3 per command, plus
        asl                     ; the command last copied for the probe)
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
@k:     lda     im              ; iovf without space check: list empty (count probe) -> nothing; otherwise the block would write
        ora     im+1            ; up to 9 bytes of scratch output after mp, where, with exactly fitting space, the VCL entries
        bne     @x              ; of the cores already are (with list: at most 6 bytes after its end, where the
        rts                     ; 7-byte entry type 12 is still free)
@s:     jsr     vmsneed
@x:     clc                     ; output after the header
        lda     mp
        adc     #3
        sta     copos
        lda     mp+1
        adc     #0
        bcc     @p              ; (C = 0: mp + 3 < $10000)
@cnt:   lda     #3              ; count: copos = 3 + bytes
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
        sec                     ; rows only: one block, lim' = (B - T) * stride
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
@gen:   sec                     ; row T: lim' = R - L
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
        lda     cl_l            ; bit 7: L > 0 (look-back), bit 6: R < w (crop run on the right)
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
        tax                     ; X = count lo
        iny
        lda     (ZP1),y
        cpx     #1              ; ccnth = hi + (lo <> 0): loop dex/beq, dec ccnth/bne
        adc     #0
        sta     ccnth
        bne     @y3
        jmp     @end            ; no commands
@y3:    iny
; ---- skip: commands with ofs < tL (k += length); Y = command
@sk:    lda     (ZP1),y
        lsr                     ; C = 1: Type 1
        iny
        lda     (ZP1),y
        bcc     @s8
        cmp     ctl
        iny
        lda     (ZP1),y
        sbc     ctl+1
        bcs     @fd             ; ofs >= tL (Y = command + 2)
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
@s8:    cmp     ctl             ; Type 8
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
        bit     cflg            ; list at end: look back at the last command
        bpl     @se
        jsr     cleft
@se:    jmp     @end
; ---- command at Y - 2 has ofs >= tL
@fd:    dey
        dey
        bit     cflg
        bpl     @vis
        tya                     ; look-back (L > 0): immediately before it a skipped type 1? (C = 1)
        sbc     #1
        cmp     cyl
        bne     @vis
        jsr     cleft2
; ---- visible commands from Y as a block
@vis:   sty     cys             ; block from Y: gap for the type 3 at k > 0, op = output + gap - Y
        stx     cxs             ; (count: CSCR + gap - Y)
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
@cp:    lda     (ZP1),y         ; type
        sta     (op),y
        lsr
        iny
        lda     (ZP1),y         ; ofs lo
        bcs     @c1
        adc     cncf            ; Type 8: ofs' = ofs - cfix (C = 0)
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
        jsr     ccommit         ; Y >= $FC: close block, advance ZP1, new block
        jsr     cnorm
        jmp     @vis
@cx:    dec     ccnth
        bne     @cy
        jsr     ccommit         ; list at end
        jmp     @end
@c1:    sbc     ccf             ; Type 1 (C = 1)
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
        lda     (ZP1),y         ; length
        sta     (op),y
        bit     cflg
        bvc     @v2
        lda     clim            ; R < w: d = lim' - ofs' (1 ... R - L, ofs' >= row start)
        sec
        sbc     cq
        cmp     (ZP1),y
        bcc     @pr             ; d < len: cropped on the right
@v2:    iny
        jmp     @cn
@ce:    dey                     ; command at Y - 2 not visible: close block, next row
        dey
        jsr     ccommit
        jmp     @nr
@pr:    sta     (op),y          ; length d; k = len - d after the block; row done
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
@pn:    cpy     #$FC            ; Y up to $FF possible (run from Y >= $F8): advance before @sk
        bcc     @nr
        jsr     cnorm
; ---- next row: tL += stride, lim' += stride; r >= B: end (rest is dropped)
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
        rts                     ; nothing visible: no list
@vs:    bit     wmode
        bmi     @wr
        lda     #7
        jsr     addiv
        lda     copos
        sta     im
        lda     copos+1
        sta     im+1
        rts
@wr:    ldy     #0              ; header: alpha, count
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
        lda     copos           ; mp = end of the list
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

; look-back (L > 0) before the command at Y or at the list end: was the immediately preceding command a skipped
; type 1 (cyl = index of its length) with e = ofs + len - tL > 0 (cropped on the left; the run stays in its row),
; then k -= e, type 3 (k), type 1 (ofs' = tL - cfix, n = min(e, R - L)), k = e - n. X, Y stay.
cleft:  sec
        tya                     ; look-back: immediately before it a skipped type 1 (cyl = index of its length)?
        sbc     #1              ; (C = 1; cyl = $FF: none, Y >= 3)
        cmp     cyl
        beq     cleft2
        rts
cleft2: sty     cq
        ldy     cyl             ; e = ofs + len - tL > 0: cropped on the left (the run stays in its row)
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
        sec                     ; k -= e (k already had len); type 3 (k)
        lda     ck
        sbc     cle
        sta     ck
        bcs     @l1
        dec     ck+1
@l1:    jsr     cflush
        lda     cwid            ; n = min(e, R - L), k = e - n; type 1 (ofs' = tL - cfix, n)
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

; close block up to before Y: n = Y - cys bytes; n > 0: copos += gap + n, cn += commands (cxs - X, < 256), type 3 (k)
; into the gap before the block (count: after CSCR). X, Y stay.
ccommit:
        tya
        sec
        sbc     cys
        beq     @r              ; empty: gap lapses
        clc
        adc     cgap
        adc     copos           ; (C = 0: n + gap < 256)
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

; Y >= $FC: ZP1 += Y - 4, Y = 4 (the previous command stays reachable for the look-back); advance cyl or $FF
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

; k > 0: output type 3 (k), k = 0. X, Y stay.
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
; output command A with word cot at copos (count: only copos), cn += 1. X, Y stay.
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
; output byte A at copos (length of a type 1). X, Y stay.
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

; ---------------------------------------------------------------- VCL entries (6)
; count: iv += length; write: vp -= length (vneed), entry at vp, nent += 1 (at most 255)
emit_vmcn:                      ; cores: srcstep = e_cnt is type 2 (like srcstep 0)
        lda     e_ss
        cmp     e_cnt
        bne     emit_vmc
        ldx     e_ss+1
        bne     emit_vmc
        stx     e_ss            ; = 0 (e_ss+1 is 0)
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
@w:     ldx     #2              ; type 2 (11 bytes) or 3 (13 bytes, srcstep e_ss)
        cmp     #1
        lda     #11
        bcc     @l
        inx
        lda     #13
@l:     jsr     vneed           ; (X stays)
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
; tail from field 5 (Y = 4, X = type): count, 0; except for type 4: reps, 0, step = stride
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
@w:     ldx     #4              ; type 4 (7 bytes) or 5 (11 bytes, reps > 1)
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

; A = type (12: list in the buffer, 9: list in bank 1); src = g_rsrc, dst = e_dst, list = e_lst
emit_vms:
        bit     wmode
        bmi     @w
        lda     #7
        jmp     addiv
@w:     tax
        lda     #7
        jsr     vneed           ; (X stays)
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

; ---------------------------------------------------------------- variables VIEW
        .segment "LIBBSS"
savesp: .res 1
ap:     .res 2
fc:     .res 2                  ; fixed coordinate of the depth (16 bit signed)
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
sp_n:   .res 1                  ; number of spans, $FF = recompute
sp_c0:  .res 5
sp_c1:  .res 5
vz_start:                       ; VIEW clears from here on
nitems: .res 1
verr:   .res 1
vpart:  .res 1
cv_n:   .res 1                  ; intervals in cover, bcov (masks)
bc_n:   .res 1
nent:   .res 1
cd:     .res 1
objv:   .res 2                  ; OBJVIS
fon:    .res 1                  ; distant view (5.7a): depth D and on
fany:   .res 1                  ; distant view: a cell of depth D with fill (then vfar instead of horizon in vtap)
bgsel:  .res 1                  ; gbg: <> 0 distant-view fill byte instead of wallpaper
vz_end:
fc0:    .res 1                  ; distant view: start of the sequence
cv_s:   .res MAXIV
cv_e:   .res MAXIV
bc_s:   .res MAXIV
bc_e:   .res MAXIV
ia:     .res 1
ib:     .res 1
ii:     .res 1
ij:     .res 1
cellp:  .res 2                  ; cell in the tile plane (cellptr), high = 0 outside the map
cbase:  .res 2                  ; tile plane + pos + d * F
du:     .res 2                  ; rtab
r_lo:   .res 31                 ; s * R per s + 15
r_hi:   .res 31
rlo:    .res 1                  ; s + 15 in [rlo, rhi): cell within the map (side axis)
rhi:    .res 1
; depth (order = depth entry 0-5)
dcy0:   .res 1
dcy1:   .res 1
dfy0:   .res 1
dfy1:   .res 1
dfirst: .res 1
dn:     .res 1
dout:   .res 1
gap:    .res 3                  ; index 1 floor, 2 ceiling
npend:  .res 1
pi:     .res 1
pd_c0:  .res MAXPEND
pd_c1:  .res MAXPEND
pd_both:.res MAXPEND
; Cells
kn:     .res 1
ksi:    .res 1                  ; s + 15
eart:   .res 1
gr_fc:  .res MAXGRP             ; classification floor/ceiling per cell of the depth ($FF don't care/no element, $FE gap, style)
gr_cc:  .res MAXGRP
ecur:   .res 1
pass:   .res 1
tsum:   .res 1
tlo:    .res 1
wocc:  .res 1
wc0:    .res 1
wc1:    .res 1
; bands (index 1 floor, 2 ceiling)
bk:     .res 1
bkx:    .res 1
by0:    .res 1
brows:  .res 1
bact:   .res 3                  ; rows of the depth not empty
bnstk:  .res 3                  ; NST, 0 without DTS
bsyk:   .res 3                  ; band slot
blive:  .res 3
bgap:   .res 3
bmix:   .res 3
bst1:   .res 3
bst0:   .res 3
bst0f:  .res 3
gentl:  .res 3                  ; band image of st0
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
; resolve, helpers
rst:    .res 1
rkx:    .res 1
tmp:    .res 1
tmp2:   .res 1
tmp3:   .res 1
mt:     .res 1
mw:     .res 2
ms:     .res 2
mr:     .res 2
; entries
svp:    .res 2                  ; state before the entry (iovf)
smp:    .res 2
snent:  .res 1
isp:    .res 1
s1:     .res 2
s3:     .res 2
iv:     .res 2
im:     .res 2
; generators
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
csdp:   .res 2                  ; dp during clipvms_e
cxs:    .res 1                  ; X at block start
ckr:    .res 1                  ; remainder of a run cropped on the right
cn:     .res 2                  ; commands output
copos:  .res 2                  ; output location (count: 3 + bytes)
cot:    .res 2
cln:    .res 1
cle:    .res 1
ccf:    .res 2                  ; cfix = T * stride + L
cncf:   .res 2                  ; -cfix
ctl:    .res 2                  ; tL of the row
clim:   .res 2                  ; lim' of the row
cwid:   .res 1                  ; R - L
cnr:    .res 1                  ; remaining rows
cflg:   .res 1
cys:    .res 1                  ; block start (Y)
cgap:   .res 1
g_vlen: .res 2                  ; length of the VMS list (clipvms_e)
g_rsrc: .res 2                  ; VB + edge_ofs
; Objects (5.8)
obm:    .res 32                 ; bit field: low byte of an object cell index (stays until the next VIEW)
objd:   .res 1
objon:  .res 1                  ; 0: no objects and items possible; bit 7: items (itemn > 0), else 1
nol:    .res 1                  ; visible objects of the list: cell index, index i, offset 6 i
ol_lo:  .res MAXOBJ
ol_hi:  .res MAXOBJ
ol_i:   .res MAXOBJ
ol_o:   .res MAXOBJ
spbase: .res 1                  ; 5 v
oclo:   .res 1                  ; cell index of the cell
ochi:   .res 1
nc:     .res 1                  ; number of candidates (tables cp ... coi in LIBTAB)
ocp:    .res 1                  ; current p
ocj:    .res 1                  ; current candidate
orx:    .res 1                  ; set in recs
oph:    .res 1
obase:  .res 1
ow:     .res 1
oh:     .res 1
ocx0:   .res 1
ocx1:   .res 1
ocy0:   .res 1
ocy1:   .res 1
ofull:  .res 1                  ; 1 = uncropped, 2 = rows only cropped
cl_w:   .res 1                  ; image width (clipvms_e)
g_oi:   .res 1
        .segment "LIBTAB"       ; working tables of VIEW (INIT does not clear them)
fdec:   .res 31                 ; distant view: decision per s + 15 of depth D ($40 fill, 0 wallpaper)
cp:     .res MAXOBJ+1           ; candidates: p, set, direction, phase, object index ($FF item)
cset:   .res MAXOBJ+1
cdir:   .res MAXOBJ+1
cph:    .res MAXOBJ+1
coi:    .res MAXOBJ+1
        .segment LIBSEG
