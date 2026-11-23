; dungeonboringengine – Lib in Bank 1 ($C000)
;
; Aufruf nur über den Stub (SYS 3331,F,X,Y). Läuft mit $FF00 = $7E (Bank 1, RAM, I/O)
; und gemeinsamem RAM unten 4 KB; Parameterblock P0..P3 bei $0C00 (Bank 0).
;
; Funktionen (A = F beim Aufruf, Rückgabe A = Fehlercode):
;   0 INIT     setzt den Zustand zurück -> X = Version; P0 = Codeende, P1 = Ende der Variablen
;   1 MAPINIT  P0 = Kartenadresse (Bank 1), P1 = Breite, P2 = Höhe (< 256), P3 = Arbeitskopie (0 = keine);
;              mit P3 wird die Karte dorthin kopiert und die Kopie benutzt; leert die Objektliste
;   2 SETPOS   P0 = Position (Zellindex), X = Richtung 0..3 (N, O, S, W)
;   6 SETCELL  P0 = Position, X = neuer Zellwert
;   4 VIEW     P0 = Bildpuffer (VRAM, AP) -> VCL-Liste ab $0B00, VMS-Listen ab $0E00;
;              X = Einträge, Y = Länge; A = 2, wenn nicht alles in die Puffer passt (hinten wird abgebrochen)
;   8 WALLSET  P0 = Wandsatz-Metadaten (Bank 1), P1 = VRAM-Basis der Wandbilder
;   9 SPRITESET X = Satz 0..3, P0 = Sprite-Metadaten (Bank 1, 0 = Satz löschen), P1 = VRAM-Basis
;  10 ITEMSET  X = Zellwert 0..63, Y = Satz + 1 (0 = kein Gegenstand)
;
; Objektliste (Bank 0, $0C10): Anzahl (max. 8), dann je 4 Byte: Position (W), Satz, Blickrichtung.
; Datenformate: docs/formats.md

        .include "dbe.inc"

MAXWS    = 64           ; Einträge im Wandsatz (Tabelle)
MAXVIS   = 22           ; sichtbare Einträge: 7 (Clear) + 22 * 11 + 1 <= 256 (VCL-Puffer)
MAXOBJ   = 8
NSETS    = 4
NITEMS   = 64
WS_HEAD  = 10
WS_ENT   = 10
SP_HEAD  = 6
SP_ENT   = 14
COLS     = 128          ; Spalten-Abdeckung (Zeilenbreite <= 128 Byte)
F_COVER  = $01          ; Wandeintrag deckt seine Spalten ab
F_SLOT   = $80          ; Wandeintrag ist ein Objektplatz
F_VMS    = $01          ; Sprite-Teil wird mit VMS (transparent) gezeichnet

.ifndef SIM
        .segment "LOADADDR"
        .word   LIB
.endif

        .export dbe_entry := entry

        .segment "CODE"
entry:  jmp     dispatch
        .byte   "DBE", DBE_VERSION

dispatch:
        stx     argx
        sty     argy
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

functab:
        .word   f_init-1, f_mapinit-1, f_setpos-1, notimpl-1, f_view-1
        .word   notimpl-1, f_setcell-1, notimpl-1, f_wallset-1, f_spriteset-1
        .word   f_itemset-1
NFUNC = (* - functab) / 2

ok:     lda     #E_OK
        ldx     #0
        ldy     #0
        rts

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
        lda     #0              ; Objektliste leeren
        sta     OBJN
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

; ---------------------------------------------------------------- 1 MAPINIT
f_mapinit:
        ldx     #5
@par:   lda     P0,x            ; map_addr, map_w, map_h liegen hintereinander
        sta     map_addr,x
        dex
        bpl     @par
        lda     #0
        sta     map_size
        sta     map_size+1
        sta     OBJN
        ldx     map_h
        beq     @done
@mul:   clc
        lda     map_size
        adc     map_w
        sta     map_size
        lda     map_size+1
        adc     map_w+1
        sta     map_size+1
        dex
        bne     @mul
@done:  lda     P3              ; Arbeitskopie?
        ora     P3+1
        beq     @ok
        lda     map_addr        ; ZP0 = Quelle, ZP1 = Ziel, map_size Byte kopieren
        sta     ZP0
        lda     map_addr+1
        sta     ZP0+1
        lda     P3
        sta     ZP1
        sta     map_addr
        lda     P3+1
        sta     ZP1+1
        sta     map_addr+1
        lda     map_size
        sta     off
        lda     map_size+1
        sta     off+1
        ldy     #0
@cp:    lda     off
        ora     off+1
        beq     @ok
        lda     (ZP0),y
        sta     (ZP1),y
        inc     ZP0
        bne     :+
        inc     ZP0+1
:       inc     ZP1
        bne     :+
        inc     ZP1+1
:       lda     off
        bne     :+
        dec     off+1
:       dec     off
        jmp     @cp
@ok:    jmp     ok

; ---------------------------------------------------------------- 6 SETCELL
f_setcell:
        lda     P0+1
        cmp     map_size+1
        bcc     @in
        bne     @out
        lda     P0
        cmp     map_size
        bcs     @out
@in:    clc
        lda     map_addr
        adc     P0
        sta     ZP0
        lda     map_addr+1
        adc     P0+1
        sta     ZP0+1
        ldy     #0
        lda     argx
        sta     (ZP0),y
        jmp     ok
@out:   lda     #E_FORMAT
        ldx     #0
        ldy     #0
        rts

; ---------------------------------------------------------------- 2 SETPOS
f_setpos:
        lda     P0
        sta     pos
        lda     P0+1
        sta     pos+1
        lda     argx
        and     #3
        sta     dir
        jmp     ok

; ---------------------------------------------------------------- 8 WALLSET
f_wallset:
        lda     P0
        sta     ws
        sta     ZP0
        lda     P0+1
        sta     ws+1
        sta     ZP0+1
        lda     P1
        sta     da
        lda     P1+1
        sta     da+1
        ldy     #0
        lda     (ZP0),y
        cmp     #$57            ; "W"
        bne     @bad
        iny
        lda     (ZP0),y
        cmp     #$53            ; "S"
        bne     @bad
        iny
        lda     (ZP0),y
        cmp     #1
        bne     @bad
        iny
        lda     (ZP0),y
        cmp     #MAXWS+1
        bcs     @many
        sta     ws_count
        ldx     #0
@hd:    iny                     ; Kopf ab Byte 4 -> clear_off, clear_len, clear_val, rowlen
        lda     (ZP0),y
        sta     clear_off,x
        inx
        cpx     #6
        bne     @hd
        jmp     ok
@bad:   lda     #0
        sta     ws_count
        lda     #E_FORMAT
        ldx     #0
        ldy     #0
        rts
@many:  lda     #0
        sta     ws_count
        lda     #E_TOOMANY
        ldx     #0
        ldy     #0
        rts

; ---------------------------------------------------------------- 9 SPRITESET
f_spriteset:
        lda     argx
        cmp     #NSETS
        bcs     @bad
        asl
        tax
        lda     P0
        sta     ZP0
        lda     P0+1
        sta     ZP0+1
        ora     ZP0
        beq     @set            ; 0 = Satz löschen
        ldy     #0
        lda     (ZP0),y
        cmp     #$53            ; "S"
        bne     @bad
        iny
        lda     (ZP0),y
        cmp     #$50            ; "P"
        bne     @bad
        iny
        lda     (ZP0),y
        cmp     #1
        bne     @bad
@set:   lda     ZP0
        sta     setaddr,x
        lda     ZP0+1
        sta     setaddr+1,x
        lda     P1
        sta     setvram,x
        lda     P1+1
        sta     setvram+1,x
        jmp     ok
@bad:   lda     #E_FORMAT
        ldx     #0
        ldy     #0
        rts

; ---------------------------------------------------------------- 10 ITEMSET
f_itemset:
        ldx     argx
        cpx     #NITEMS
        bcs     @bad
        lda     argy
        sta     itemtab,x
        jmp     ok
@bad:   lda     #E_FORMAT
        ldx     #0
        ldy     #0
        rts

; ---------------------------------------------------------------- 4 VIEW
f_view:
        lda     P0
        sta     ap
        lda     P0+1
        sta     ap+1

        ; Vorwärts- und Rechtsschritt je Richtung
        sec
        lda     #0
        sbc     map_w
        sta     negw
        lda     #0
        sbc     map_w+1
        sta     negw+1
        lda     dir
        asl
        tax
        lda     dirtab,x
        pha
        lda     dirtab+1,x
        pha
        rts                     ; -> v_n / v_e / v_s / v_w
dirtab: .byte   >(v_n-1), <(v_n-1), >(v_e-1), <(v_e-1), >(v_s-1), <(v_s-1), >(v_w-1), <(v_w-1)

v_n:    lda     negw            ; F = -B, R = +1
        sta     fstep
        lda     negw+1
        sta     fstep+1
        lda     #1
        sta     rstep
        lda     #0
        sta     rstep+1
        jmp     v_go
v_e:    lda     #1              ; F = +1, R = +B
        sta     fstep
        lda     #0
        sta     fstep+1
        lda     map_w
        sta     rstep
        lda     map_w+1
        sta     rstep+1
        jmp     v_go
v_s:    lda     map_w           ; F = +B, R = -1
        sta     fstep
        lda     map_w+1
        sta     fstep+1
        lda     #$FF
        sta     rstep
        sta     rstep+1
        jmp     v_go
v_w:    lda     #$FF            ; F = -1, R = -B
        sta     fstep
        sta     fstep+1
        lda     negw
        sta     rstep
        lda     negw+1
        sta     rstep+1

v_go:   lda     #0
        sta     nvis
        sta     verr
        ldx     #COLS-1
@clr:   sta     cover,x
        dex
        bpl     @clr
        lda     OBJN
        cmp     #MAXOBJ+1
        bcc     :+
        lda     #MAXOBJ
:       sta     nobj

        clc
        lda     ws
        adc     #WS_HEAD
        sta     ZP0
        lda     ws+1
        adc     #0
        sta     ZP0+1
        lda     ws_count
        sta     cnt
        bne     v_entry
        jmp     v_emit

v_entry:
        ; off = d * F + s * R
        lda     #0
        sta     off
        sta     off+1
        ldy     #0
        lda     (ZP0),y         ; d
        sta     od
        beq     @side
        tax
@d:     clc
        lda     off
        adc     fstep
        sta     off
        lda     off+1
        adc     fstep+1
        sta     off+1
        dex
        bne     @d
@side:  ldy     #1
        lda     (ZP0),y         ; s
        sta     os
        beq     @cell
        bmi     @neg
        tax
@sp:    clc
        lda     off
        adc     rstep
        sta     off
        lda     off+1
        adc     rstep+1
        sta     off+1
        dex
        bne     @sp
        beq     @cell
@neg:   eor     #$FF
        clc
        adc     #1
        tax
@sn:    sec
        lda     off
        sbc     rstep
        sta     off
        lda     off+1
        sbc     rstep+1
        sta     off+1
        dex
        bne     @sn

@cell:  clc                     ; cell = pos + off; außerhalb der Karte zählt als Wand
        lda     pos
        adc     off
        sta     cell
        lda     pos+1
        adc     off+1
        sta     cell+1
        cmp     map_size+1
        bcc     @in
        bne     @oob
        lda     cell
        cmp     map_size
        bcs     @oob
@in:    clc
        lda     map_addr
        adc     cell
        sta     ZP1
        lda     map_addr+1
        adc     cell+1
        sta     ZP1+1
        ldy     #0
        lda     (ZP1),y
        jmp     @have
@oob:   lda     #1
@have:  sta     cellv
        ldy     #2
        lda     (ZP0),y
        bpl     @wallq
        jmp     v_obj
@wallq: lda     cellv
        and     #1
        bne     @wall
        jmp     v_next

@wall:  ldy     #3              ; sichtbar, wenn mindestens eine Spalte frei ist
        lda     (ZP0),y
        sta     wcnt
        ldy     #9
        lda     (ZP0),y
        sta     xstart
        jsr     col_free
        bcs     :+
        jmp     v_next
:       lda     ZP0
        sta     vp
        lda     ZP0+1
        sta     vp+1
        lda     #0              ; Art 0 = Wand
        jsr     vis_add
        bcc     :+
        jmp     v_emit
:       ldy     #2
        lda     (ZP0),y
        and     #F_COVER
        beq     v_next
        ldy     #3              ; deckt ab: Spalten markieren
        lda     (ZP0),y
        sta     wcnt
        ldx     xstart
        lda     #1
@mark:  sta     cover,x
        inx
        dec     wcnt
        bne     @mark

v_next: clc
        lda     ZP0
        adc     #WS_ENT
        sta     ZP0
        bcc     :+
        inc     ZP0+1
:       dec     cnt
        beq     v_emit_j
        jmp     v_entry
v_emit_j:
        jmp     v_emit

; Objektplatz (d, s): Objekte aus der Liste, dann Gegenstand aus der Karte.
; Von vorne nach hinten verarbeitet, daher wird der Gegenstand später vor dem Objekt gezeichnet.
v_obj:  lda     cellv
        and     #1
        bne     v_next          ; in einer Wand steht nichts
        lda     #0
        sta     oi
@o:     lda     oi
        cmp     nobj
        bcs     @items
        asl
        asl
        tax
        lda     OBJL,x
        cmp     cell
        bne     @on
        lda     OBJL+1,x
        cmp     cell+1
        bne     @on
        lda     OBJL+2,x
        sta     oset
        lda     dir             ; Blickwinkel = (2 + Spieler - Objekt) AND 3
        clc
        adc     #2
        sec
        sbc     OBJL+3,x
        and     #3
        sta     oang
        jsr     add_parts
        bcs     @full
@on:    inc     oi
        jmp     @o
@items: lda     cellv
        and     #NITEMS-1
        tax
        lda     itemtab,x
        beq     @done
        sec
        sbc     #1
        sta     oset
        lda     #$FF
        sta     oang
        jsr     add_parts
        bcs     @full
@done:  jmp     v_next
@full:  jmp     v_emit

; Teile des Satzes oset passend zu (od, os, oang) vormerken. C = 1: Liste voll.
add_parts:
        lda     oset
        cmp     #NSETS
        bcs     @ok
        asl
        tax
        lda     setaddr,x
        sta     ZP1
        lda     setaddr+1,x
        sta     ZP1+1
        ora     ZP1
        beq     @ok
        ldy     #3
        lda     (ZP1),y
        beq     @ok
        sta     pcnt
        clc
        lda     ZP1
        adc     #SP_HEAD
        sta     ZP1
        bcc     @p
        inc     ZP1+1
@p:     ldy     #0
        lda     (ZP1),y
        cmp     od
        bne     @pn
        iny
        lda     (ZP1),y
        cmp     os
        bne     @pn
        iny
        lda     (ZP1),y
        cmp     #$FF
        beq     @ang
        cmp     oang
        bne     @pn
@ang:   ldy     #4
        lda     (ZP1),y
        sta     wcnt
        ldy     #10
        lda     (ZP1),y
        jsr     col_free
        bcc     @pn
        lda     ZP1
        sta     vp
        lda     ZP1+1
        sta     vp+1
        lda     oset            ; Art = Satz + 1
        clc
        adc     #1
        jsr     vis_add
        bcs     @full
@pn:    clc
        lda     ZP1
        adc     #SP_ENT
        sta     ZP1
        bcc     :+
        inc     ZP1+1
:       dec     pcnt
        bne     @p
@ok:    clc
        rts
@full:  sec
        rts

; Ist in den Spalten A .. A+wcnt-1 noch eine frei? C = 1: ja
col_free:
        tax
@l:     lda     cover,x
        beq     @free
        inx
        dec     wcnt
        bne     @l
        clc
        rts
@free:  sec
        rts

; Eintrag vp mit Art A vormerken. C = 1: Liste voll.
vis_add:
        ldx     nvis
        cpx     #MAXVIS
        bcc     :+
        lda     #E_TOOMANY
        sta     verr
        sec
        rts
:       sta     vis_k,x
        lda     vp
        sta     vis_lo,x
        lda     vp+1
        sta     vis_hi,x
        inc     nvis
        clc
        rts

; ---------------------------------------------------------------- Ausgabe
v_emit: lda     #0
        sta     sbuf
        sta     sbuf+1
        ldy     #0
        lda     clear_len
        ora     clear_len+1
        beq     @walls
        lda     #4              ; VMF Adresse, Wert, Länge
        sta     VCLBUF,y
        iny
        clc
        lda     ap
        adc     clear_off
        sta     VCLBUF,y
        iny
        lda     ap+1
        adc     clear_off+1
        sta     VCLBUF,y
        iny
        lda     clear_val
        sta     VCLBUF,y
        iny
        lda     #0
        sta     VCLBUF,y
        iny
        lda     clear_len
        sta     VCLBUF,y
        iny
        lda     clear_len+1
        sta     VCLBUF,y
        iny
@walls: sty     outi
        ldx     nvis
        bne     @w
        jmp     @end
@w:     dex                     ; hinten nach vorne
        stx     vx
        lda     vis_lo,x
        sta     ZP0
        lda     vis_hi,x
        sta     ZP0+1
        lda     vis_k,x
        beq     @wall
        jsr     emit_sprite
        jmp     @nx
@wall:  ldy     #5
        clc
        lda     (ZP0),y
        adc     da
        sta     t_src
        iny
        lda     (ZP0),y
        adc     da+1
        sta     t_src+1
        iny
        clc
        lda     (ZP0),y
        adc     ap
        sta     t_dst
        iny
        lda     (ZP0),y
        adc     ap+1
        sta     t_dst+1
        ldy     #3
        lda     (ZP0),y
        sta     t_w
        iny
        lda     (ZP0),y
        sta     t_h
        jsr     emit_vmc
@nx:    ldx     vx
        beq     @end
        jmp     @w
@end:   ldy     outi
        lda     #0
        sta     VCLBUF,y
        iny
        lda     verr            ; E_OK oder E_TOOMANY
        ldx     nvis
        rts

; VMC-Eintrag (Typ 2) aus t_src, t_dst, t_w, t_h an VCLBUF+outi anhängen
emit_vmc:
        ldy     outi
        lda     #2              ; VMC Quelle, Ziel, Breite, Zeilen, Zeilenbreite
        sta     VCLBUF,y
        iny
        lda     t_src
        sta     VCLBUF,y
        iny
        lda     t_src+1
        sta     VCLBUF,y
        iny
        lda     t_dst
        sta     VCLBUF,y
        iny
        lda     t_dst+1
        sta     VCLBUF,y
        iny
        lda     t_w
        sta     VCLBUF,y
        iny
        lda     #0
        sta     VCLBUF,y
        iny
        lda     t_h
        sta     VCLBUF,y
        iny
        lda     #0
        sta     VCLBUF,y
        iny
        lda     rowlen
        sta     VCLBUF,y
        iny
        lda     #0
        sta     VCLBUF,y
        iny
        sty     outi
        rts

; Sprite-Teil ZP0 (Satz vis_k-1) ausgeben: VMS (Liste nach SPRBUF kopieren) oder VMC
emit_sprite:
        sec
        sbc     #1
        asl
        tax
        stx     sx
        ldy     #6              ; Quelle + VRAM-Basis des Satzes
        clc
        lda     (ZP0),y
        adc     setvram,x
        sta     t_src
        iny
        lda     (ZP0),y
        adc     setvram+1,x
        sta     t_src+1
        iny
        clc                     ; Ziel + AP
        lda     (ZP0),y
        adc     ap
        sta     t_dst
        iny
        lda     (ZP0),y
        adc     ap+1
        sta     t_dst+1
        ldy     #4
        lda     (ZP0),y
        sta     t_w
        iny
        lda     (ZP0),y
        sta     t_h
        ldy     #3
        lda     (ZP0),y
        and     #F_VMS
        bne     @vms
        jmp     emit_vmc

@vms:   ldy     #11             ; Listenlänge
        lda     (ZP0),y
        sta     llen
        clc                     ; passt die Liste noch in SPRBUF?
        adc     sbuf
        sta     t_end
        lda     sbuf+1
        adc     #0
        sta     t_end+1
        cmp     #>SPRBUF_LEN
        bcc     @fits
        bne     @nofit
        lda     t_end
        cmp     #<SPRBUF_LEN
        bcc     @fits
        beq     @fits
@nofit: lda     #E_TOOMANY
        sta     verr
        rts
@fits:  ldy     #12             ; Listenquelle = Satzadresse + Listenoffset
        ldx     sx
        clc
        lda     (ZP0),y
        adc     setaddr,x
        sta     ZP1
        iny
        lda     (ZP0),y
        adc     setaddr+1,x
        sta     ZP1+1
        clc                     ; Ziel der Kopie = SPRBUF + sbuf
        lda     #<SPRBUF
        adc     sbuf
        sta     t_lst
        sta     @dst+1
        lda     #>SPRBUF
        adc     sbuf+1
        sta     t_lst+1
        sta     @dst+2
        ldy     #0
@cp:    lda     (ZP1),y
@dst:   sta     $FFFF,y         ; selbstmodifizierend
        iny
        cpy     llen
        bne     @cp
        lda     t_end
        sta     sbuf
        lda     t_end+1
        sta     sbuf+1
        ldy     outi
        lda     #12             ; VMS Quelle, Ziel, Liste
        sta     VCLBUF,y
        iny
        lda     t_src
        sta     VCLBUF,y
        iny
        lda     t_src+1
        sta     VCLBUF,y
        iny
        lda     t_dst
        sta     VCLBUF,y
        iny
        lda     t_dst+1
        sta     VCLBUF,y
        iny
        lda     t_lst
        sta     VCLBUF,y
        iny
        lda     t_lst+1
        sta     VCLBUF,y
        iny
        sty     outi
        rts

code_end:

        .segment "BSS"
bss_start:
argx:      .res 1
argy:      .res 1
map_addr:  .res 2               ; map_addr, map_w, map_h: Reihenfolge für MAPINIT
map_w:     .res 2
map_h:     .res 2
map_size:  .res 2
pos:       .res 2
dir:       .res 1
ws:        .res 2
da:        .res 2
ws_count:  .res 1
clear_off: .res 2               ; clear_off .. rowlen: Reihenfolge wie im Kopf
clear_len: .res 2
clear_val: .res 1
rowlen:    .res 1
ap:        .res 2
negw:      .res 2
fstep:     .res 2
rstep:     .res 2
off:       .res 2
cell:      .res 2
cellv:     .res 1
cnt:       .res 1
wcnt:      .res 1
xstart:    .res 1
nvis:      .res 1
verr:      .res 1
outi:      .res 1
vx:        .res 1
vp:        .res 2
od:        .res 1
os:        .res 1
oi:        .res 1
oset:      .res 1
oang:      .res 1
nobj:      .res 1
pcnt:      .res 1
sx:        .res 1
llen:      .res 1
sbuf:      .res 2
t_src:     .res 2
t_dst:     .res 2
t_lst:     .res 2
t_end:     .res 2
t_w:       .res 1
t_h:       .res 1
setaddr:   .res NSETS*2
setvram:   .res NSETS*2
itemtab:   .res NITEMS
cover:     .res COLS
vis_lo:    .res MAXVIS
vis_hi:    .res MAXVIS
vis_k:     .res MAXVIS
bss_end:
