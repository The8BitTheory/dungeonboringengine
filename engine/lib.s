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
; Alle anderen Funktionen (und F >= 17): A = E_NOTIMPL, bis ihr Teilschritt (P6c-P6f) sie umsetzt.
;
; Übersetzen mit -DDBE_TEST (nur Tests, nie im Spiel): Funktionen 250 (MMU-/Common-RAM-Probe)
; und 251 (Warteschleife von P0 x etwa 1300 Zyklen) für den VICE-Rauchtest.
; Übersetzen mit -DSIM: ohne LOADADDR (sim65-Harness, test/sim).

        .include "dbe.inc"

.ifndef SIM
        .segment "LOADADDR"
        .word   LIB
.endif

        .export dbe_entry := entry
        .export bss_start, bss_end, code_end            ; für Tests (Labeldatei)
        .export buf_b0, buf_b1, pool_a, pool_b, pool_on

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
        .word   f_init-1,     notimpl-1,    notimpl-1,    notimpl-1     ; 0 INIT, 1 MAPINIT, 2 SETPOS, 3 MOVE
        .word   notimpl-1,    notimpl-1,    notimpl-1,    notimpl-1     ; 4 VIEW, 5 CELL, 6 SETCELL, 7 (ENEMYSTEP)
        .word   notimpl-1,    notimpl-1,    notimpl-1,    f_poolset-1   ; 8 (WALLSET), 9 SPRITESET, 10 ITEMSET, 11 POOLSET
        .word   notimpl-1,    notimpl-1,    notimpl-1,    f_bufset-1    ; 12 GEOMSET, 13 TEXSET, 14 BGSET, 15 BUFSET
        .word   notimpl-1                                               ; 16 SETITEM
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
        ldx     #0
        ldy     #0
        rts

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

        .segment "CODE"
code_end:                       ; Codeende (nur ein Segment CODE, kein RODATA)

; ---------------------------------------------------------------- Variablen (Bank 1 $E000-$E7FF)
        .segment "LIBBSS"
bss_start:
argx:   .res 1
argy:   .res 1
buf_b0: .res 2                  ; Puffer (BUFSET): Anfang, Ende exklusiv
buf_b1: .res 2
pool_a: .res 2                  ; Pool (POOLSET): Anfang, Ende exklusiv (0 = 65536)
pool_b: .res 2
pool_on:.res 1                  ; 0 = keine Prüfung
bss_end:
