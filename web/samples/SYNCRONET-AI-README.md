# SYNCRONET-AI — Adaptive Traffic Signal Simulation

**▶ Live demo:** https://sangamyo.github.io/sangamyo-sangamyo-Synchronet-Traffic-Simulation-with-stats/ (runs in the browser, no install)

A four-way intersection simulated in Python and Pygame, with **density-based adaptive signals**: each time a signal finishes its cycle, its next green phase is set to

```
green = 5 s + 2 s × vehicles waiting at that signal
```

so busier approaches get more green time instead of a fixed cycle. The white boxes next to each signal show how many vehicles are waiting; at the end of a run the simulation shows direction-wise and total vehicle counts.

## Run locally

```sh
pip install pygame-ce        # or: pip install pygame
python Synchronet-Traffic-Simulation-with-stats/simulation.py
```

## Browser build

The simulation runs on a single `asyncio` loop (no threads), so the same code runs on desktop and, via [pygbag](https://github.com/pygame-web/pygbag), in the browser as WebAssembly. Every push to `main` rebuilds the web version and deploys it to GitHub Pages (`.github/workflows/deploy-web.yml`).

```sh
pip install pygbag
python -m pygbag --ume_block 0 Synchronet-Traffic-Simulation-with-stats   # then open http://localhost:8000
```

## Credits

Built on [Traffic Intersection Simulation with Stats](https://github.com/mihir-m-gandhi/Traffic-Intersection-Simulation-with-Stats) by Mihir Gandhi (MIT License). SYNCRONET-AI adds the density-based adaptive signal timing, waiting-vehicle counts and the browser build.
