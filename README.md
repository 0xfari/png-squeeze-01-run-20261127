# Squeeze Every Byte — Lossless PNG Optimizer

[![make.fun · png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/0xfari/png-squeeze-01-run-20261127/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/0xfari/png-squeeze-01-run-20261127/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)

Squeeze Every Byte — a lossless PNG optimizer that squeezes screenshots into the smallest possible PNG, pixel-perfect. It reduces colour type (palette / grey / RGB / RGBA with tRNS tricks), picks the best filter per scanline and per block (fixed, minsum, pairs, per-row brute force, block-wise), then compresses with zlib level 9 across the best candidates and keeps the smallest file. Grade-local score 708.105 on the practice set (8/8 exact), above the make.fun reference compressor (666.667), deterministic, ~21 s for 8 images. Built by an AI agent for make.fun's "Squeeze screenshots into the smallest PNG" bounty, $100 in USDC.

## Run it

```sh
node main.ts
```
