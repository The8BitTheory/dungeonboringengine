        .include "simdata.inc"
        .export _dbe_call, _dbe_x, _dbe_y, _mapdata, _wsmdata, _map_w, _map_h
        .import popa, dbe_entry
        .bss
tmpx:   .res 1
_dbe_x: .res 1
_dbe_y: .res 1
        .code
_dbe_call:
        sta     tmpx
        jsr     popa
        ldx     tmpx
        ldy     #0
        jsr     dbe_entry
        stx     _dbe_x
        sty     _dbe_y
        ldx     #0
        rts
        .rodata
_map_w: .byte   MAP_W
_map_h: .byte   MAP_H
        .data
_mapdata: .incbin MAPFILE, MAP_OFF, MAP_W*MAP_H
_wsmdata: .incbin WSMFILE, 2
