# blob (sprite set)

Geometry ID 47585, NA 4, NP 2, D 3, NI 20, NK 49, NT 2

- S2 content (bank 1): 6276 bytes
- VRAM U: 6574 bytes
- VRL stream: 2754 bytes, ratio 0.419
- Buffer: largest VMS list 433, largest sum VCL + VMS 484 (shared buffer 2304)

## Images

| Phase | Angle | Depth | Value | Image | Source | w x h | Foot | Cores | Core bytes | Edge | VMS | VCL |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 0 | 0 | 1 | 0 | 0 | own | 16 x 54 | 7,52 | 4 | 445 | 172 | 417 | 51 |
| 0 | 0 | 2 | 1 | 1 | own | 10 x 34 | 4,33 | 2 | 145 | 100 | 297 | 29 |
| 0 | 0 | 3 | 2 | 2 | own | 6 x 21 | 2,20 | 1 | 40 | 50 | 142 | 18 |
| 0 | 1 | 1 | 3 | 3 | own | 16 x 54 | 7,52 | 4 | 454 | 163 | 433 | 51 |
| 0 | 1 | 2 | 4 | 4 | own | 10 x 34 | 4,33 | 2 | 155 | 90 | 275 | 29 |
| 0 | 1 | 3 | 5 | 5 | own | 6 x 21 | 2,20 | 1 | 40 | 50 | 136 | 18 |
| 0 | 2 | 1 | 6 | 6 | own | 16 x 54 | 7,52 | 4 | 483 | 134 | 341 | 51 |
| 0 | 2 | 2 | 7 | 7 | own | 10 x 34 | 4,33 | 3 | 180 | 65 | 209 | 40 |
| 0 | 2 | 3 | 8 | 8 | own | 6 x 21 | 2,20 | 1 | 40 | 50 | 130 | 18 |
| 0 | 3 | 1 | 9 | 9 | own | 16 x 54 | 7,52 | 4 | 444 | 173 | 405 | 51 |
| 0 | 3 | 2 | 10 | 10 | own | 10 x 34 | 4,33 | 2 | 152 | 93 | 263 | 29 |
| 0 | 3 | 3 | 11 | 11 | own | 6 x 21 | 2,20 | 1 | 40 | 50 | 136 | 18 |
| 1 | 0 | 1 | 12 | 12 | own | 16 x 54 | 7,52 | 4 | 452 | 165 | 401 | 51 |
| 1 | 0 | 2 | 13 | 13 | own | 10 x 34 | 4,33 | 2 | 147 | 98 | 259 | 29 |
| 1 | 0 | 3 | $FF |  | $FF |  |  |  |  |  |  |  |
| 1 | 1 | 1 | 14 | 14 | own | 16 x 54 | 7,52 | 4 | 454 | 163 | 431 | 51 |
| 1 | 1 | 2 | 15 | 15 | own | 10 x 34 | 4,33 | 2 | 155 | 90 | 276 | 29 |
| 1 | 1 | 3 | 16 | 16 | own | 6 x 21 | 2,20 | 1 | 40 | 50 | 133 | 18 |
| 1 | 2 | 1 | 6 | 6 | shared with image 6 | 16 x 54 | 7,52 | 4 | 483 | 134 | 341 | 51 |
| 1 | 2 | 2 | 7 | 7 | shared with image 7 | 10 x 34 | 4,33 | 3 | 180 | 65 | 209 | 40 |
| 1 | 2 | 3 | 8 | 8 | shared with image 8 | 6 x 21 | 2,20 | 1 | 40 | 50 | 130 | 18 |
| 1 | 3 | 1 | 17 | 17 | own | 16 x 54 | 7,52 | 4 | 444 | 173 | 399 | 51 |
| 1 | 3 | 2 | 18 | 18 | own | 10 x 34 | 4,33 | 2 | 152 | 93 | 260 | 29 |
| 1 | 3 | 3 | 19 | 19 | own | 6 x 21 | 2,20 | 1 | 40 | 50 | 133 | 18 |

## Tags

| Name | Phase | Count | Mode | Jiffies |
|---|---|---|---|---|
| IDLE | 0 | 1 | forward | 9 |
| WALK | 0 | 2 | pingpong | 9 |

```
REM BLOB: IDLE 0-0 9J, WALK 0-1 9J
```

## Warnings

- S2 content 6276 bytes >= 4096 (more than half of the 8 KB sprite area, P6 2.4)

## Infos

- v0_d1#0: foot point rounded to byte boundary
- v0_d1#1: foot point rounded to byte boundary
- v0_d2#0: foot point automatic
- v0_d2#0: foot point rounded to byte boundary
- v0_d2#1: foot point automatic
- v0_d2#1: foot point rounded to byte boundary
- v0_d3#0: foot point rounded to byte boundary
- v1_d1#0: foot point rounded to byte boundary
- v1_d1#1: foot point rounded to byte boundary
- v1_d2#0: foot point automatic
- v1_d2#0: foot point rounded to byte boundary
- v1_d2#1: foot point automatic
- v1_d2#1: foot point rounded to byte boundary
- v1_d3#0: foot point rounded to byte boundary
- v1_d3#1: foot point rounded to byte boundary
- v2_d1#0: foot point rounded to byte boundary
- v2_d1#1: foot point rounded to byte boundary
- v2_d2#0: foot point automatic
- v2_d2#0: foot point rounded to byte boundary
- v2_d2#1: foot point automatic
- v2_d2#1: foot point rounded to byte boundary
- v2_d3#0: foot point rounded to byte boundary
- v2_d3#1: foot point rounded to byte boundary
- v3_d1#0: foot point rounded to byte boundary
- v3_d1#1: foot point rounded to byte boundary
- v3_d2#0: foot point automatic
- v3_d2#0: foot point rounded to byte boundary
- v3_d2#1: foot point automatic
- v3_d2#1: foot point rounded to byte boundary
- v3_d3#0: foot point rounded to byte boundary
- v3_d3#1: foot point rounded to byte boundary
- layer 'ref' does not match v<ai>_d<d>, ignored
