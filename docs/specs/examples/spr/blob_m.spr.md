# blob_m (Sprite-Satz)

Geometrie-ID 48903, NA 4, NP 2, D 3, NI 20, NK 49, NT 2

- S2-Inhalt (Bank 1): 6364 Byte
- VRAM U: 6574 Byte
- VRL-Strom: 2678 Byte, Verhaeltnis 0.407
- Puffer: groesste VMS-Liste 433, groesste Summe VCL + VMS 484 (gemeinsamer Puffer 2304)

## Bilder

| Phase | Winkel | Tiefe | Wert | Bild | Quelle | w x h | Fuss | Kerne | Kernbyte | Rand | VMS | VCL |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 0 | 0 | 1 | 0 | 0 | eigen | 16 x 54 | 7,52 | 4 | 445 | 172 | 417 | 51 |
| 0 | 0 | 2 | 1 | 1 | eigen | 10 x 34 | 4,33 | 2 | 145 | 100 | 297 | 29 |
| 0 | 0 | 3 | 2 | 2 | eigen | 6 x 21 | 2,20 | 1 | 40 | 50 | 142 | 18 |
| 0 | 1 | 1 | 3 | 3 | eigen | 16 x 54 | 7,52 | 4 | 454 | 163 | 433 | 51 |
| 0 | 1 | 2 | 4 | 4 | eigen | 10 x 34 | 4,33 | 2 | 155 | 90 | 275 | 29 |
| 0 | 1 | 3 | 5 | 5 | eigen | 6 x 21 | 2,20 | 1 | 40 | 50 | 136 | 18 |
| 0 | 2 | 1 | 6 | 6 | eigen | 16 x 54 | 7,52 | 4 | 483 | 134 | 341 | 51 |
| 0 | 2 | 2 | 7 | 7 | eigen | 10 x 34 | 4,33 | 3 | 180 | 65 | 209 | 40 |
| 0 | 2 | 3 | 8 | 8 | eigen | 6 x 21 | 2,20 | 1 | 40 | 50 | 130 | 18 |
| 0 | 3 | 1 | 9 | 9 | gespiegelt von v1_d1 | 16 x 54 | 8,52 | 4 | 454 | 163 | 433 | 51 |
| 0 | 3 | 2 | 10 | 10 | gespiegelt von v1_d2 | 10 x 34 | 5,33 | 2 | 155 | 90 | 275 | 29 |
| 0 | 3 | 3 | 11 | 11 | gespiegelt von v1_d3 | 6 x 21 | 3,20 | 1 | 40 | 50 | 136 | 18 |
| 1 | 0 | 1 | 12 | 12 | eigen | 16 x 54 | 7,52 | 4 | 452 | 165 | 401 | 51 |
| 1 | 0 | 2 | 13 | 13 | eigen | 10 x 34 | 4,33 | 2 | 147 | 98 | 259 | 29 |
| 1 | 0 | 3 | $FF |  | $FF |  |  |  |  |  |  |  |
| 1 | 1 | 1 | 14 | 14 | eigen | 16 x 54 | 7,52 | 4 | 454 | 163 | 431 | 51 |
| 1 | 1 | 2 | 15 | 15 | eigen | 10 x 34 | 4,33 | 2 | 155 | 90 | 276 | 29 |
| 1 | 1 | 3 | 16 | 16 | eigen | 6 x 21 | 2,20 | 1 | 40 | 50 | 133 | 18 |
| 1 | 2 | 1 | 6 | 6 | geteilt mit Bild 6 | 16 x 54 | 7,52 | 4 | 483 | 134 | 341 | 51 |
| 1 | 2 | 2 | 7 | 7 | geteilt mit Bild 7 | 10 x 34 | 4,33 | 3 | 180 | 65 | 209 | 40 |
| 1 | 2 | 3 | 8 | 8 | geteilt mit Bild 8 | 6 x 21 | 2,20 | 1 | 40 | 50 | 130 | 18 |
| 1 | 3 | 1 | 17 | 17 | gespiegelt von v1_d1 | 16 x 54 | 8,52 | 4 | 454 | 163 | 431 | 51 |
| 1 | 3 | 2 | 18 | 18 | gespiegelt von v1_d2 | 10 x 34 | 5,33 | 2 | 155 | 90 | 276 | 29 |
| 1 | 3 | 3 | 19 | 19 | gespiegelt von v1_d3 | 6 x 21 | 3,20 | 1 | 40 | 50 | 133 | 18 |

## Tags

| Name | Phase | Anzahl | Modus | Jiffies |
|---|---|---|---|---|
| IDLE | 0 | 1 | forward | 9 |
| WALK | 0 | 2 | pingpong | 9 |

```
REM BLOB_M: IDLE 0-0 9J, WALK 0-1 9J
```

## Warnungen

- S2-Inhalt 6364 Byte >= 4096 (mehr als die Haelfte des 8-KB-Sprite-Bereichs, P6 2.4)

## Infos

- v0_d1#0: Fusspunkt auf Bytegrenze gerundet
- v0_d1#1: Fusspunkt auf Bytegrenze gerundet
- v0_d2#0: Fusspunkt automatisch
- v0_d2#0: Fusspunkt auf Bytegrenze gerundet
- v0_d2#1: Fusspunkt automatisch
- v0_d2#1: Fusspunkt auf Bytegrenze gerundet
- v0_d3#0: Fusspunkt auf Bytegrenze gerundet
- v1_d1#0: Fusspunkt auf Bytegrenze gerundet
- v1_d1#1: Fusspunkt auf Bytegrenze gerundet
- v1_d2#0: Fusspunkt automatisch
- v1_d2#0: Fusspunkt auf Bytegrenze gerundet
- v1_d2#1: Fusspunkt automatisch
- v1_d2#1: Fusspunkt auf Bytegrenze gerundet
- v1_d3#0: Fusspunkt auf Bytegrenze gerundet
- v1_d3#1: Fusspunkt auf Bytegrenze gerundet
- v2_d1#0: Fusspunkt auf Bytegrenze gerundet
- v2_d1#1: Fusspunkt auf Bytegrenze gerundet
- v2_d2#0: Fusspunkt automatisch
- v2_d2#0: Fusspunkt auf Bytegrenze gerundet
- v2_d2#1: Fusspunkt automatisch
- v2_d2#1: Fusspunkt auf Bytegrenze gerundet
- v2_d3#0: Fusspunkt auf Bytegrenze gerundet
- v2_d3#1: Fusspunkt auf Bytegrenze gerundet
- Ebene 'ref' entspricht nicht v<ai>_d<d>, ignoriert
