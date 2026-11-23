; dungeonboringengine – Lib in Bank 1 ($C000)
;
; Aufruf nur über den Stub (SYS 3331,F,X,Y). Läuft mit $FF00 = $7E (Bank 1, RAM, I/O)
; und gemeinsamem RAM unten 4 KB; Parameterblock P0..P3 bei $0C00 (Bank 0).
;
; Funktionen (A = F beim Aufruf, Rückgabe A = Fehlercode):
;   0 INFO     -> X = Version; P0 = Codeende, P1 = Ende der Variablen
;   1 MAPINIT  P0 = Kartenadresse (Bank 1), P1 = Breite, P2 = Höhe (< 256)
;   2 SETPOS   P0 = Position (Zellindex), X = Richtung 0..3 (N, O, S, W)
;   4 VIEW     P0 = Bildpuffer (VRAM, AP) -> VCL-Liste ab $0B00; X = Wandeinträge, Y = Länge;
;              A = 2, wenn mehr als MAXVIS Einträge sichtbar wären (die vorderen werden gezeichnet)
;   8 WALLSET  P0 = Wandsatz-Metadaten (Bank 1), P1 = VRAM-Basis der Wandbilder
;
; Wandsatz-Metadaten (docs/formats.md):
;   Kopf 10 Byte: "W","S",Version 1, Anzahl, Clear-Offset (W), Clear-Länge (W), Clear-Wert, Zeilenbreite
;   Eintrag 10 Byte: d, s (signed), Flags (Bit 0 = deckt Spalten ganz ab), Breite, Höhe,
;                    Quelle (W, rel. VRAM-Basis), Ziel (W, rel. AP), Spalte
;   Einträge stehen von vorne nach hinten; VIEW gibt die sichtbaren in umgekehrter Folge aus.

        .include "dbe.inc"

MAXWS    = 64           ; Einträge im Wandsatz (Tabelle)
MAXVIS   = 22           ; sichtbare Einträge: 7 (Clear) + 22 * 11 + 1 <= 256 (VCL-Puffer)
WS_HEAD  = 10
WS_ENT   = 10
COLS     = 128          ; Spalten-Abdeckung (Zeilenbreite <= 128 Byte)

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
        .word   f_info-1, f_mapinit-1, f_setpos-1, notimpl-1, f_view-1
        .word   notimpl-1, notimpl-1, notimpl-1, f_wallset-1
NFUNC = (* - functab) / 2

ok:     lda     #E_OK
        ldx     #0
        ldy     #0
        rts

; ---------------------------------------------------------------- 0 INFO
f_info:
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
@cp:    lda     P0,x            ; map_addr, map_w, map_h liegen hintereinander
        sta     map_addr,x
        dex
        bpl     @cp
        lda     #0
        sta     map_size
        sta     map_size+1
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
@done:  jmp     ok

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
        rts                     ; -> v_n / v_e / v_s / v_w (über rts, daher -1)
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
        bne     @wall
        lda     cell
        cmp     map_size
        bcs     @wall
@in:    clc
        lda     map_addr
        adc     cell
        sta     ZP1
        lda     map_addr+1
        adc     cell+1
        sta     ZP1+1
        ldy     #0
        lda     (ZP1),y
        and     #1
        bne     @wall
        jmp     v_next

@wall:  ldy     #9              ; sichtbar, wenn mindestens eine Spalte frei ist
        lda     (ZP0),y
        sta     xstart
        tax
        ldy     #3
        lda     (ZP0),y
        sta     wcnt
@vis:   lda     cover,x
        beq     @show
        inx
        dec     wcnt
        bne     @vis
        jmp     v_next
@show:  ldx     nvis
        cpx     #MAXVIS
        bcc     @room
        lda     #E_TOOMANY      ; Liste voll: die näheren Einträge sind drin, weiter hinten wird abgebrochen
        sta     verr
        jmp     v_emit
@room:  lda     ZP0
        sta     vis_lo,x
        lda     ZP0+1
        sta     vis_hi,x
        inc     nvis
        ldy     #2
        lda     (ZP0),y
        and     #1
        beq     @nomark
        ldy     #3              ; deckt ab: Spalten markieren
        lda     (ZP0),y
        sta     wcnt
        ldx     xstart
        lda     #1
@mark:  sta     cover,x
        inx
        dec     wcnt
        bne     @mark
@nomark:

v_next: clc
        lda     ZP0
        adc     #WS_ENT
        sta     ZP0
        bcc     :+
        inc     ZP0+1
:       dec     cnt
        beq     v_emit
        jmp     v_entry

v_emit: ldy     #0
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
@walls: ldx     nvis
        bne     @w
        jmp     @end
@w:     dex                     ; hinten nach vorne
        lda     vis_lo,x
        sta     ZP0
        lda     vis_hi,x
        sta     ZP0+1
        sty     outi
        ldy     #5
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
        cpx     #0
        beq     @end
        jmp     @w
@end:   lda     #0
        sta     VCLBUF,y
        iny
        lda     verr            ; E_OK oder E_TOOMANY
        ldx     nvis
        rts

code_end:

        .segment "BSS"
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
cnt:       .res 1
wcnt:      .res 1
xstart:    .res 1
nvis:      .res 1
outi:      .res 1
t_src:     .res 2
t_dst:     .res 2
t_w:       .res 1
t_h:       .res 1
cover:     .res COLS
verr:      .res 1
vis_lo:    .res MAXVIS
vis_hi:    .res MAXVIS
bss_end:
